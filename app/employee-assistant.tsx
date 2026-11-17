"use client";
import {useCallback,useEffect,useRef,useState} from 'react';
import './employee-assistant.css';
import WorkspaceIcon from './workspace-icons';
import {encouragementFor,guideQuestion} from '../lib/employee-voice.mjs';
import {assistantName,wakeQuestion} from '../lib/employee-wake.mjs';

type Entry={id:string;title:string};
type Topic={scope:'internal'|'public';key:string;title:string};
type Mode='auto'|'internal'|'public';
type Home={edition?:string;revision?:string;role:string;intro:string;dailyGuide?:string;suggestions?:Entry[];guides:Entry[];recent:Topic[]};
type Citation={start:number;end:number;url:string;title:string};
type DecisionContext={month:string;channel:string;site:string;metric:string;order:string;selectedSites?:string[];aggregate?:boolean;byPlatform?:boolean;targetRanking?:boolean};
type PlanContext={site:string;channel:string;month:string};
type ProductionContext={site:string;channel:string;sku:string};
type Answer={learnable?:boolean;personalMatch?:boolean;planContext?:PlanContext;brief?:{period:string;details:string[]};productionContext?:ProductionContext;decisionContext?:DecisionContext;ledger?:{page:string;label:string;view?:string;month?:string;entity?:string}|null;questions?:string[];topic?:Topic;saved?:boolean;verifiedAt?:string;citations?:Citation[];choices?:Entry[];step?:number;answer:string;notice:string;source:string;intent:string;guide:(Entry & {steps:string[];next:string;page:string})|null};
type Turn={id:string;question:string;reply:Answer;encouragement:string};
type AskOptions={planContext?:PlanContext;productionContext?:ProductionContext;decisionContext?:DecisionContext;previous?:string;previousStep?:number;guideId?:string;mode?:Mode;knowledgeId?:string};
const sources:Record<string,string>={'learned-guide':'学过的问法 · 岗位手册','ledger':'业务台账','conversation':'小品同学','unavailable':'小品同学','knowledge':'公司知识库','openai':'模型匹配 · 岗位手册','public-data':'公开数据源','public-web':'公开网页检索','public-unavailable':'外部资料查询'};
function currentStep(reply?:Answer){
  if(reply?.intent!=='step'||!reply.guide)return 0;
  return reply.step??reply.guide.steps.indexOf(reply.answer)+1;
}

function CitedAnswer({reply}:{reply:Answer}){
  if(reply.brief){
    const [headline,...reasons]=reply.answer.split('\n');
    return <div className="employee-brief">
      <p className="employee-result"><strong>{headline}</strong></p>
      {reasons.map((line,i)=><p key={i}>{line}</p>)}
      <small>{reply.brief.period}</small>
      {!!reply.brief.details.length&&<details><summary>查看明细和计算依据</summary>
        <ul>{reply.brief.details.map((line,i)=><li key={i}>{line}</li>)}</ul>
      </details>}
    </div>;
  }
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

function GuideFeedback({question,page,reply,guides,busy,openGuide}:{question:string;page:string;reply:Answer;guides:Entry[];busy:boolean;openGuide:(g:Entry)=>void}){
  const [editing,setEditing]=useState(false),[selected,setSelected]=useState('');
  const [saving,setSaving]=useState(false),[known,setKnown]=useState(reply.personalMatch||false),[note,setNote]=useState('');
  async function save(id:string,forget=false){
    if(saving)return;
    setSaving(true);setNote('');
    try{
      const r=await fetch('/api/employee-assistant?feedback=1',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({question,page,guideId:id,forget}),signal:AbortSignal.timeout(10000)});
      const data=await r.json();
      if(!r.ok)throw Error(data.error||'这次没记住，点一下再试试。');
      setKnown(data.remembered);setEditing(false);
      setNote(forget?'已撤回你的选择。':'记住这个问法啦！下次我直接找这条指引。');
      const guide=guides.find(g=>g.id===id);
      if(!forget&&guide&&id!==reply.guide?.id)openGuide(guide);
    }catch(e){setNote(e instanceof Error&&e.name==='Error'?e.message:'刚才没连上，重新点一下吧。');}
    finally{setSaving(false);}
  }
  return <div className="employee-feedback">
    <div className="employee-picks">
      {reply.guide&&!known&&<button disabled={busy||saving} onClick={()=>void save(reply.guide!.id)}>对，就是这条</button>}
      <button disabled={busy||saving} aria-expanded={editing} onClick={()=>{setEditing(!editing);setNote('');}}>{reply.guide?'换条指引':'教小品认这个问法'}</button>
      {known&&<button disabled={busy||saving} onClick={()=>void save('',true)}>撤回我的选择</button>}
    </div>
    {editing&&<div className="employee-feedback-picker"><label>这个问法对应哪条操作？
      <select value={selected} disabled={saving} onChange={e=>setSelected(e.target.value)}><option value="">选择岗位指引</option>
        {guides.map(g=><option key={g.id} value={g.id}>{g.title}</option>)}</select></label>
      <button className="btn" disabled={!selected||saving||busy} onClick={()=>void save(selected)}>记住并查看</button></div>}
    {note&&<small role="status">{note}</small>}
  </div>;
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
  return <div><button className="btn" disabled={state==='loading'} onClick={()=>void load()}>{state==='loading'?'我数数…':'看看有几条经营行动'}</button>
    {state==='error'&&<p role="alert">这次没读到行动数量，点一下再查查。</p>}
    {state==='ready'&&counts&&<p role="status"><strong>{counts.site} · {counts.channel}</strong><br/>{counts.total
      ? <>已触发 {counts.triggered} 条，待核实 {counts.verifying} 条，待复查 {counts.review} 条。同一条行动可能既已触发，也在等复查。<br/>行动记录最近更新于 {new Date(counts.updated!).toLocaleString('zh-CN')}。</>
      : '这里还没有行动记录。去「每日经营行动单」看看证据更新到哪天了吧。'}</p>}
  </div>;
}

export default function EmployeeAssistant({initialQuestion,page,pageTitle,close,go}:{initialQuestion:string;page:string;pageTitle:string;close:()=>void;go:(page:string, view?:string, month?:string, entity?:string)=>void}) {
  const dialog=useRef<HTMLDialogElement>(null);
  const input=useRef<HTMLTextAreaElement>(null);
  const pending=useRef<AbortController|null>(null);
  const [home,setHome]=useState<Home|null>(null),[turns,setTurns]=useState<Turn[]>([]);
  const [mode,setMode]=useState<Mode>('auto');
  const [draft,setDraft]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [homeAttempt,setHomeAttempt]=useState(0);
  const [guideSearch,setGuideSearch]=useState('');
  const transcript=useRef<HTMLDivElement>(null);
  const submit=useCallback(async (question:string,options:AskOptions={})=>{
    if(!question.trim()||pending.current) return;
    const ctl=new AbortController();
    pending.current=ctl;setBusy(true);setError('');
    const addTurn=(reply:Answer)=>{
      const variation=Math.random(),id=crypto.randomUUID();
      setTurns(old=>{
        const encouragement=encouragementFor(reply,old.map(t=>t.encouragement).reverse(),variation);
        return [...old.slice(-9),{id,question,reply,encouragement}];
      });
    };
    try {
      const response=await fetch('/api/employee-assistant',{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',
        signal:AbortSignal.any([ctl.signal,AbortSignal.timeout(40000)]),body:JSON.stringify({question,page,...options})});
      if(!response.ok) throw new Error(response.status===401?'登录过期啦，重新登录后咱们接着聊。':'这次没接上。问题帮你留在输入框了，再发一次就好。');
      const reply:Answer=await response.json();
      if(!ctl.signal.aborted){addTurn(reply);setDraft('');
        const topic=reply.topic;
        if(reply.saved&&topic)setHome(h=>h?{...h,recent:[topic,...(h.recent||[]).filter(t=>t.scope!==topic.scope||t.title!==topic.title)].slice(0,10)}:h);
      }
    } catch(e) {
      if(!ctl.signal.aborted){
        const answer=e instanceof Error&&!['TimeoutError','AbortError','TypeError'].includes(e.name)?e.message:'刚才没连上。问题还在输入框里，网络好了再发一次。';
        addTurn({answer,source:'unavailable',intent:'unknown',guide:null,notice:''});
        setDraft(question);
      }
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
        const r=await fetch('/api/employee-assistant?page='+encodeURIComponent(page),{cache:'no-store',signal:AbortSignal.any([ctl.signal,AbortSignal.timeout(10000)])});
        if(!r.ok) throw new Error();
        const info:Home=await r.json();
        if(!ctl.signal.aborted){setHome(info);if(initialQuestion)void submit(initialQuestion);}
      } catch {if(!ctl.signal.aborted)setError('手册这次没打开。先确认还登录着，然后点「再试一次」。');}
    })();
    return ()=>ctl.abort();
  },[initialQuestion,page,submit,homeAttempt]);
  useEffect(()=>{
    if(!turns.length&&!busy)return;
    const target=busy?transcript.current?.querySelector('.employee-working'):transcript.current?.querySelector('article:last-of-type');
    target?.scrollIntoView({block:'start',behavior:'instant'});
  },[turns,busy]);
  const last=[...turns].reverse().find(t=>t.reply.intent!=='chat'&&t.reply.source!=='unavailable')?.reply;
  const [file,setFile]=useState<File|null>(null),[uploading,setUploading]=useState(false),[receipt,setReceipt]=useState('');
  async function uploadHandbook(){
    if(!file||uploading||home?.role!=='管理员')return;
    setUploading(true);setError('');setReceipt('');
    try {
      if(file.size>256000)throw new Error('这份手册超过了 256 KB，换个小一点的文件吧。');
      const r=await fetch('/api/employee-assistant?handbook=1',{method:'POST',headers:{'Content-Type':'application/json','X-Handbook-Revision':home.revision||''},body:file,signal:AbortSignal.timeout(30000)});
      const result=await r.json();if(!r.ok)throw new Error(result.error||'这份手册没导进去，再检查一下文件吧。');
      setReceipt('新手册收到了！'+result.edition+' 版已生效，里面有 '+result.count+' 项补充指引。');setTurns([]);setFile(null);setHomeAttempt(n=>n+1);
    } catch(e){setError(e instanceof Error?e.message:'手册没导进去，检查一下文件再试吧。');}finally{setUploading(false);}
  }
  function ask() {
    const q=(wakeQuestion(draft)??draft).trim()||(wakeQuestion(draft)===''?'在吗？':'');
    void submit(q,{planContext:last?.planContext,decisionContext:last?.decisionContext,productionContext:last?.productionContext,previous:last?.guide?.id||(last?.ledger?.page==='suggestions'?'production-basis':undefined),previousStep:currentStep(last),mode});
  }
  const suggestions=home?.suggestions?.length?home.suggestions:home?.guides.slice(0,2)||[];
  const query=guideSearch.trim().toLocaleLowerCase();
  const matches=home?.guides.filter(g=>g.title.toLocaleLowerCase().includes(query))||[];
  const openGuide=(g:Entry)=>void submit(guideQuestion(g.title),{guideId:g.id,mode:'internal'});
  const follow=(question:string)=>void submit(question,{previous:last?.guide?.id||(last?.ledger?.page==='suggestions'?'production-basis':undefined),previousStep:currentStep(last),mode:'internal'});

  return <dialog className="employee-dialog" ref={dialog} aria-labelledby="employee-title" onCancel={e=>{e.preventDefault();close();}}>
    <header className="employee-bar">
      <span className="employee-avatar" aria-hidden="true"><i><b/></i></span>
      <div><h2 id="employee-title">{assistantName}</h2><p>有我让你工作更加从容</p></div>
      <button className="employee-close" type="button" aria-label="关闭小品同学" onClick={close}><WorkspaceIcon name="close"/></button>
    </header>
    <div className="employee-transcript" ref={transcript}>
      {home && <>
        <div className="employee-hello">
          <p>{home.intro}</p>
          <span className="employee-breeze" aria-hidden="true"><i/><i/><i/></span>
        </div>
        <section className="employee-start">
          <h3>{home.suggestions?.length&&pageTitle?'聊聊'+pageTitle:'想先忙哪件事？'}</h3>
          <div className="employee-shortcuts">{suggestions.map(g=><button key={g.id} disabled={busy} onClick={()=>openGuide(g)}>
            <WorkspaceIcon name={home.suggestions?.length?page:'reviews'}/><span>{guideQuestion(g.title)}</span><WorkspaceIcon name="chevron"/>
          </button>)}</div>
          <div className="employee-picks">
            <button disabled={busy} onClick={()=>void submit('我刚来，从哪儿上手？',{mode:'internal'})}>我刚来，从哪儿上手？</button>
            {['管理员','财务','运营主管','运营'].includes(home.role)&&<button disabled={busy} onClick={()=>void submit(home.role==='运营'?'本站本月的销售额和广告投入是多少？':'本月哪个站点的销售贡献小，广告投入占比却高？',{mode:'internal'})}>{home.role==='运营'?'本站的销售和投放怎么样？':'哪站投入多、贡献少？'}</button>}
            {['管理员','财务','运营主管'].includes(home.role)&&<button disabled={busy} onClick={()=>void submit('今天最该盯哪件事？',{mode:'internal'})}>今天最该盯哪件事？</button>}
            {['monthly','fulfillment','suggestions'].includes(page)&&['管理员','供应链','运营','运营主管'].includes(home.role)&&<button disabled={busy} onClick={()=>void submit('本月备货计划到哪一步了？',{mode:'internal'})}>本月备货到哪了？</button>}
            {home.dailyGuide&&<button disabled={busy} onClick={()=>void submit('我每天先忙啥？',{guideId:home.dailyGuide,mode:'internal'})}>我每天先忙啥？</button>}
          </div>
        </section>
        <div className="employee-library">
          <details><summary><WorkspaceIcon name="reviews"/>翻翻岗位手册 <small>{home.guides.length}</small><WorkspaceIcon name="chevron"/></summary>
            <div className="employee-library-body">
              <input type="search" aria-label="搜索岗位指引" placeholder="搜个名字，比如「备货」" value={guideSearch} onChange={e=>setGuideSearch(e.target.value)}/>
              <div className="employee-picks">{matches.map(g=><button key={g.id} disabled={busy} onClick={()=>openGuide(g)}>{g.title}</button>)}</div>
              {!matches.length&&<p role="status">没翻到这个名字。试试短一点的词，比如「日报」。</p>}
            </div>
          </details>
          {!!home.recent?.length&&<details><summary><WorkspaceIcon name="audit"/>最近答过的问题<WorkspaceIcon name="chevron"/></summary>
            <div className="employee-picks">{home.recent.map(t=><button key={t.key} disabled={busy} onClick={()=>void submit(t.title,{mode:t.scope,knowledgeId:t.key})}>{t.title}</button>)}</div>
          </details>}
          {home.role==='管理员'&&<details><summary><WorkspaceIcon name="permissions"/>给小品更新手册<WorkspaceIcon name="chevron"/></summary>
            <div className="employee-library-body"><label>选择员工手册知识包（JSON）<input type="file" accept=".json,application/json" onChange={e=>{setFile(e.target.files?.[0]||null);setReceipt('');}}/></label>
            <button className="btn" disabled={!file||uploading||busy} onClick={()=>void uploadHandbook()}>{uploading?'正在导入…':'导入并启用手册'}</button>{receipt&&<p role="status">{receipt}</p>}</div>
          </details>}
        </div>
      </>}
      {!home&&!error&&<p role="status">我翻翻岗位手册…</p>}
      {turns.map(({id,question,reply,encouragement})=><article key={id} className="employee-turn">
        <h3>{question}</h3>
        <small>{sources[reply.source]||'岗位手册'}{reply.saved?' · 已存入知识库':''}{reply.verifiedAt?' · '+new Date(reply.verifiedAt).toLocaleDateString('zh-CN'):''}</small>
        {reply.notice&&<p className="employee-note">{reply.notice}</p>}
        {reply.guide&&<h4>{reply.guide.title}{reply.intent==='step'&&currentStep(reply)>0&&<small>第 {currentStep(reply)} / {reply.guide.steps.length} 步</small>}{reply.intent==='handoff'&&<small>接下来谁接手</small>}</h4>}
        <CitedAnswer reply={reply}/>
        {reply.ledger&&<button className="employee-link" onClick={()=>go(reply.ledger!.page,reply.ledger!.view,reply.ledger!.month,reply.ledger!.entity)}>{reply.ledger.label} →</button>}
        {!!reply.questions?.length&&<div className="employee-picks">{reply.questions.map(q=><button key={q} disabled={busy} onClick={()=>void submit(q,{mode:'internal',planContext:reply.planContext,decisionContext:reply.decisionContext})}>{q}</button>)}</div>}
        {!!reply.choices?.length&&<div className="employee-picks">{reply.choices.map(g=><button key={g.id} disabled={busy} onClick={()=>openGuide(g)}>{guideQuestion(g.title)}</button>)}</div>}
        {reply.guide&&<>
          {reply.intent!=='step'&&reply.intent!=='handoff'&&<><ol>{reply.guide.steps.map((s,n)=><li key={n}>{s}</li>)}</ol>
            <p className="employee-handoff"><b>接下来谁接手</b>　{reply.guide.next}</p></>}
          {reply.guide.id==='action-review'&&<ActionCounts/>}
          <div className="employee-turn-actions">
            <button className="employee-link" onClick={()=>go(reply.guide!.page)}>带我去工作区 <WorkspaceIcon name="arrow"/></button>
            {reply===last&&reply.intent!=='handoff'&&<div className="employee-picks">
              {currentStep(reply)<reply.guide.steps.length&&<button disabled={busy} onClick={()=>follow('下一步怎么做？')}>{currentStep(reply)?'接着往下看':'带我从头走一遍'}</button>}
              <button disabled={busy} onClick={()=>follow('谁来接手？')}>谁来接手？</button>
            </div>}
          </div>
        </>}
        {reply.learnable&&home&&<GuideFeedback question={question} page={page} reply={reply} guides={home.guides} busy={busy} openGuide={openGuide}/>}
        <p className="employee-encouragement"><WorkspaceIcon name="new-products"/>{encouragement}</p>
      </article>)}
      {busy&&<p className="employee-working" role="status">我来瞧瞧…</p>}
      {error&&<p role="alert">{error} {!home&&<button className="btn" onClick={()=>{setError('');setHomeAttempt(n=>n+1);}}>再试一次</button>}</p>}
    </div>
    <form className="employee-composer" onSubmit={e=>{e.preventDefault();ask();}}>
      <div className="employee-compose-head"><label htmlFor="employee-question">{mode==='public'?'想查什么公开资料？':'想问点什么？'}</label>
        <label className="employee-scope">去哪儿找 <select aria-label="去哪儿找（查询范围）" value={mode} disabled={busy} onChange={e=>setMode(e.target.value as Mode)}>
          <option value="auto">让小品选</option><option value="internal">内部业务与操作</option><option value="public">外部公开资料</option></select></label>
      </div>
      <div className="employee-input"><textarea ref={input} id="employee-question" maxLength={600} rows={1}
        placeholder={mode==='public'?'说个公开的话题就行，客户、订单和内部数据记得留在公司里。':'比如：'+(last?.guide?'下一步怎么做？':'我在这页先做什么？')} value={draft} disabled={busy} onChange={e=>setDraft(e.target.value)}
        onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing&&e.nativeEvent.keyCode!==229){e.preventDefault();if(home&&!busy)ask();}}}/>
        <button className="employee-send" disabled={!home||busy||!draft.trim()}>问小品<WorkspaceIcon name="arrow"/></button>
      </div>
      <small>模型启用时，你写的问题可能会发给 OpenAI。客户和订单资料别放进来哦。</small>
    </form>
  </dialog>;
}
