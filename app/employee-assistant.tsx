"use client";
import {useCallback,useEffect,useRef,useState} from 'react';
import './employee-assistant.css';
import {assistantName,wakeQuestion} from '../lib/employee-wake.mjs';

type Entry={id:string;title:string};
type Topic={scope:'internal'|'public';key:string;title:string};
type Mode='auto'|'internal'|'public';
type Home={edition?:string;revision?:string;role:string;intro:string;dailyGuide?:string;guides:Entry[];recent:Topic[]};
type Citation={start:number;end:number;url:string;title:string};
type Answer={topic?:Topic;saved?:boolean;verifiedAt?:string;citations?:Citation[];answer:string;notice:string;source:string;intent:string;guide:(Entry & {steps:string[];next:string;page:string})|null};
type Turn={question:string;reply:Answer};

function CitedAnswer({reply}:{reply:Answer}){
  const links=reply.citations||[],parts:React.ReactNode[]=[];
  let offset=0;
  for(const [i,c] of [...links].sort((a,b)=>a.start-b.start).entries()){
    if(!/^https:\/\//i.test(c.url))continue;
    const aligned=Number.isInteger(c.start)&&Number.isInteger(c.end)&&c.start>=offset&&c.end>=c.start&&c.end<=reply.answer.length;
    const end=aligned?c.end:reply.answer.length;
    const inline=aligned&&/^\s*\(?\[[^\]]+\]\(https?:\/\//i.test(reply.answer.slice(c.start,c.end));
    parts.push(reply.answer.slice(offset,inline?c.start:end));
    parts.push(<a key={i} target="_blank" rel="noreferrer" href={c.url}>〔{c.title}〕</a>);
    offset=end;
  }
  parts.push(reply.answer.slice(offset));return <p className="employee-answer">{parts}</p>;
}

function ActionCounts() {
  type Counts={site:string;channel:string;total:number;triggered:number;verifying:number;review:number;updated:string|null};
  const [counts,setCounts]=useState<Counts|null>(null),[state,setState]=useState('idle');
  async function load() {
    setState('loading');
    try {
      const response=await fetch('/api/employee-assistant?actionCounts=1',{cache:'no-store',signal:AbortSignal.timeout(10000)});
      if(!response.ok) throw new Error();
      setCounts(await response.json());setState('ready');
    } catch {setState('error');}
  }
  return <div><button className="btn" disabled={state==='loading'} onClick={()=>void load()}>{state==='loading'?'读取中…':'查看当前经营行动数量'}</button>
    {state==='error'&&<p role="alert">行动数量暂时无法读取，请重试。</p>}
    {state==='ready'&&counts&&<p role="status"><strong>{counts.site} · {counts.channel}</strong><br/>{counts.total
      ? <>已触发 {counts.triggered} 条，待核实 {counts.verifying} 条，待复查 {counts.review} 条。复查状态可与触发状态重叠。<br/>行动记录最近更新于 {new Date(counts.updated!).toLocaleString('zh-CN')}。</>
      : '尚无行动记录。请到每日经营行动单核对证据更新情况。'}</p>}
  </div>;
}

export default function EmployeeAssistant({initialQuestion,page,close,go}:{initialQuestion:string;page:string;close:()=>void;go:(page:string)=>void}) {
  const dialog=useRef<HTMLDialogElement>(null);
  const input=useRef<HTMLTextAreaElement>(null);
  const pending=useRef<AbortController|null>(null);
  const [home,setHome]=useState<Home|null>(null),[turns,setTurns]=useState<Turn[]>([]);
  const [mode,setMode]=useState<Mode>('auto');
  const [draft,setDraft]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [homeAttempt,setHomeAttempt]=useState(0);
  const transcript=useRef<HTMLDivElement>(null);
  const submit=useCallback(async (question:string,previous='',guideId='',scope:Mode='auto',knowledgeId?:string)=>{
    if(!question.trim()||pending.current) return;
    const ctl=new AbortController();
    pending.current=ctl;setBusy(true);setError('');
    try {
      const response=await fetch('/api/employee-assistant',{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',
        signal:AbortSignal.any([ctl.signal,AbortSignal.timeout(40000)]),body:JSON.stringify({question,previous,guideId,page,mode:scope,knowledgeId})});
      if(!response.ok) throw new Error(response.status===401?'登录已过期，请重新登录。':'暂时无法回答，请重试。');
      const reply:Answer=await response.json();
      if(!ctl.signal.aborted){setTurns(old=>[...old.slice(-9),{question,reply}]);setDraft('');
        const topic=reply.topic;
        if(reply.saved&&topic)setHome(h=>h?{...h,recent:[topic,...(h.recent||[]).filter(t=>t.scope!==topic.scope||t.title!==topic.title)].slice(0,10)}:h);
      }
    } catch(e) {
      if(!ctl.signal.aborted){setError(e instanceof Error&&!['TimeoutError','AbortError','TypeError'].includes(e.name)?e.message:'请求超时或网络不可用，请重试。');setDraft(question);}
    } finally {if(pending.current===ctl){pending.current=null;setBusy(false);}}
  },[page]);
  useEffect(()=>{
    const node=dialog.current;node?.showModal();
    return ()=>{pending.current?.abort();pending.current=null;node?.close();};
  },[]);
  useEffect(()=>{
    const ctl=new AbortController();
    (async()=>{
      try {
        const r=await fetch('/api/employee-assistant',{cache:'no-store',signal:AbortSignal.any([ctl.signal,AbortSignal.timeout(10000)])});
        if(!r.ok) throw new Error();
        const info:Home=await r.json();
        if(!ctl.signal.aborted){setHome(info);if(initialQuestion)void submit(initialQuestion);}
      } catch {if(!ctl.signal.aborted)setError('无法读取岗位手册，请检查登录状态后重试。');}
    })();
    return ()=>ctl.abort();
  },[initialQuestion,submit,homeAttempt]);
  useEffect(()=>{const el=transcript.current;if(el)el.scrollTop=el.scrollHeight;},[turns,busy]);
  const last=turns.at(-1)?.reply.guide?.id||'';
  const [file,setFile]=useState<File|null>(null),[uploading,setUploading]=useState(false),[receipt,setReceipt]=useState('');
  async function uploadHandbook(){
    if(!file||uploading||home?.role!=='管理员')return;
    setUploading(true);setError('');setReceipt('');
    try {
      if(file.size>256000)throw new Error('手册文件超过 256 KB');
      const r=await fetch('/api/employee-assistant?handbook=1',{method:'POST',headers:{'Content-Type':'application/json','X-Handbook-Revision':home.revision||''},body:file,signal:AbortSignal.timeout(30000)});
      const result=await r.json();if(!r.ok)throw new Error(result.error||'手册导入失败');
      setReceipt('员工手册 '+result.edition+' 已生效，已载入 '+result.count+' 项补充指引。');setTurns([]);setFile(null);setHomeAttempt(n=>n+1);
    } catch(e){setError(e instanceof Error?e.message:'无法导入手册');}finally{setUploading(false);}
  }
  function ask() {
    const q=(wakeQuestion(draft)??draft).trim()|| (wakeQuestion(draft)===''?'新员工从哪里开始？':'');
    void submit(q,last,'',mode);
  }
  return <dialog className="employee-dialog" ref={dialog} aria-labelledby="employee-title" onCancel={e=>{e.preventDefault();close();}}>
    <header><div><h2 id="employee-title">{assistantName}</h2><p>{home ? home.role+' · '+(home.edition?'员工使用手册 '+home.edition:'岗位操作指引') : '岗位操作指引'}</p></div><button type="button" className="btn" onClick={close}>关闭</button></header>
    <div className="employee-transcript" ref={transcript}>
      {home && <><p>{home.intro}</p><div className="employee-picks">
        <button disabled={busy} onClick={()=>void submit('我刚入职，应该从哪里开始？')}>我刚入职，从哪里开始？</button>
        {home.dailyGuide&&<button disabled={busy} onClick={()=>void submit('我每天需要做什么？')}>我每天需要做什么？</button>}
        {home.guides.slice(0,2).map(g=><button key={g.id} disabled={busy} onClick={()=>void submit(g.title,'',g.id)}>{g.title}</button>)}
      </div><details><summary>查看全部岗位指引（{home.guides.length}）</summary><div className="employee-picks">{home.guides.map(g=><button key={g.id} disabled={busy} onClick={()=>void submit(g.title,'',g.id)}>{g.title}</button>)}</div></details>{!!home.recent?.length&&<details><summary>岗位知识库 · 最近解答</summary><div className="employee-picks">{home.recent.map(t=><button key={t.key} disabled={busy} onClick={()=>void submit(t.title,'','',t.scope,t.key)}>{t.title}</button>)}</div></details>}</>}
      {!home&&!error&&<p role="status">正在读取岗位手册…</p>}
      {home?.role==='管理员'&&<details><summary>维护员工手册</summary><label>选择员工手册知识包（JSON）<input type="file" accept=".json,application/json" onChange={e=>{setFile(e.target.files?.[0]||null);setReceipt('');}}/></label><button className="btn" disabled={!file||uploading||busy} onClick={()=>void uploadHandbook()}>{uploading?'正在导入…':'导入并启用手册'}</button>{receipt&&<p role="status">{receipt}</p>}</details>}
      {turns.map((t,i)=><article key={i}><h3>{t.question}</h3><small>{({'knowledge':'公司知识库','openai':'模型匹配 · 岗位手册','public-data':'公开数据源','public-web':'公开网页检索','public-unavailable':'外部资料查询'} as Record<string,string>)[t.reply.source]||'岗位手册'}{t.reply.saved?' · 已存入知识库':''}{t.reply.verifiedAt?' · '+new Date(t.reply.verifiedAt).toLocaleDateString('zh-CN'):''}</small>
        {t.reply.notice&&<p className="employee-note">{t.reply.notice}</p>}<CitedAnswer reply={t.reply}/>
        {t.reply.guide && <><strong>{t.reply.guide.title}</strong><ol>{t.reply.guide.steps.map(s=><li key={s}>{s}</li>)}</ol>
          {t.reply.intent!=='handoff'&&<p><b>下一岗位　</b>{t.reply.guide.next}</p>}
          {t.reply.guide.id==='action-review'&&<ActionCounts/>}
          <button className="btn" onClick={()=>go(t.reply.guide!.page)}>打开对应工作区 →</button></>}
      </article>)}
      {busy&&<p role="status">正在查找操作步骤…</p>}
      {error&&<p role="alert">{error} {!home&&<button className="btn" onClick={()=>{setError('');setHomeAttempt(n=>n+1);}}>重新读取</button>}</p>}
    </div>
    <form onSubmit={e=>{e.preventDefault();ask();}}><label>查询范围 <select aria-label="查询范围" value={mode} disabled={busy} onChange={e=>setMode(e.target.value as Mode)}>
      <option value="auto">自动判断</option><option value="internal">系统操作</option><option value="public">外部公开资料</option></select></label>
      <label htmlFor="employee-question">{mode==='public'?'公开查询主题（请勿填写客户、订单或内部数据）':'你的问题'}</label>
      <textarea ref={input} id="employee-question" maxLength={600} rows={2} placeholder="例如：小品同学，备货计划提交后由谁审核？" value={draft} disabled={busy} onChange={e=>setDraft(e.target.value)}
        onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing&&e.nativeEvent.keyCode!==229){e.preventDefault();if(home&&!busy)ask();}}}/>
      <div><small>自由提问会在模型启用时发给 OpenAI，请只描述操作问题。</small><button className="btn primary" disabled={!home||busy||!draft.trim()}>提问</button></div>
    </form>
  </dialog>;
}
