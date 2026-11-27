'use client';
import {useEffect,useState} from 'react';
import './connections.css';
type Row=Record<string,any>;
const names:Row={shop:'TikTok Shop',ads:'TikTok 广告'};
const states:Row={connected:'已授权',expired:'需重新授权',error:'读取未完成',disconnected:'已断开',reconnect:'需重新授权',configuration:'配置待检查'};
const regions:Row={MY:'马来西亚',ID:'印尼',TH:'泰国',VN:'越南',PH:'菲律宾'};
const time=(v:string)=>v?new Date(v).toLocaleString('zh-CN',{hour12:false}):'尚未读取';
export default function Connections(){
 const [data,setData]=useState<Row|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(''),[notice,setNotice]=useState(''),[detail,setDetail]=useState<Row|null>(null),[disconnect,setDisconnect]=useState<Row|null>(null),[setup,setSetup]=useState(false);
 useEffect(()=>{if(setup)document.querySelector('.cn-setup')?.scrollIntoView({behavior:'smooth',block:'start'});},[setup]);
 async function load(){const r=await fetch('/api/connections',{cache:'no-store'}),d=await r.json();if(!r.ok)throw Error(d.error);setData(d);}
 useEffect(()=>{if(!detail&&!disconnect)return;const previous=document.activeElement as HTMLElement|null,old=document.body.style.overflow;document.body.style.overflow='hidden';const handler=(e:KeyboardEvent)=>{if(e.key==='Escape'&&!busy){setDetail(null);setDisconnect(null);}if(e.key==='Tab'){const items=Array.from(document.querySelectorAll<HTMLElement>('.cn-dialog button:not(:disabled), .cn-dialog a[href], .cn-dialog input'));if(!items.length)return;const first=items[0],last=items[items.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}};document.addEventListener('keydown',handler);return()=>{document.body.style.overflow=old;document.removeEventListener('keydown',handler);previous?.focus();};},[detail,disconnect,busy]);
 useEffect(()=>{let active=true;fetch('/api/connections',{cache:'no-store'}).then(async r=>{const d=await r.json();if(!r.ok)throw Error(d.error);if(active)setData(d);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[]);
 async function act(payload:Row){
  setBusy(payload.accountId||payload.provider||'refresh');setError('');setNotice('');
  try{const r=await fetch('/api/connections',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}),d=await r.json();if(!r.ok)throw Error(d.error);
   if(d.url){window.location.assign(d.url);return;}
   if(payload.action==='disconnect'){setDisconnect(null);setDetail(null);setNotice('已停止本系统读取。若要撤销平台授权，请到 TikTok 官方后台取消应用授权。');}
   else {setDetail(null);setNotice('这次数据读好了，可以展开核对明细。');}await load();
  }catch(e){setError((e as Error).message);await load().catch(()=>{});}finally{setBusy('');}
 }
 async function showDetail(a:Row){setBusy(a.id);setError('');try{const r=await fetch('/api/connections?account='+encodeURIComponent(a.id),{cache:'no-store'}),d=await r.json();if(!r.ok)throw Error(d.error);setDetail({...d,account:a});}catch(e){setError((e as Error).message);}finally{setBusy('');}}
 async function refresh(){setBusy('refresh');setError('');try{await load();}catch(e){setError((e as Error).message);}finally{setBusy('');}}
 return <div className="connections"><header className="cn-head"><div><p className="cn-eyebrow">LOONG JUMP · 数据连接</p><h1>连接与授权</h1><p>把店铺与广告数据接进来，让每一步判断都有出处。</p></div><button className="btn" disabled={!!busy} onClick={()=>void refresh()}>刷新状态</button></header>
  {error&&<p className="cn-alert" role="alert">{error}</p>}{notice&&<p className="cn-note" role="status">{notice}</p>}
  {!data?<p role="status">{error?'请检查服务后刷新重试。':'正在检查连接状态…'}</p>:<>
   <div className="cn-cards">{data.configuration.map((c:Row)=>{
    const count=data.accounts.filter((a:Row)=>a.provider===c.provider&&a.status!=='disconnected').length;
    return <section className="cn-card" key={c.provider}><div className="cn-card-title"><span className={'cn-icon '+c.provider} aria-hidden="true">{c.provider==='shop'?'♪':'↗'}</span><div><h2>{names[c.provider]}</h2><span className={'cn-badge '+(count?'ok':'')}>{count?`${count} 个授权账户`:c.ready?'等待授权':'等待配置'}</span></div></div>
     <p>{c.provider==='shop'?'核对店铺身份，读取近 7 天订单与履约状态。':'核对广告账户，读取每日消耗、展示与点击。'}</p>
     <div className="cn-card-foot"><span>{c.ready?'授权后选择账户读取数据':'官方应用资料准备好后，即可授权'}</span><button className={'btn '+(c.ready?'primary':'')} disabled={!!busy} onClick={()=>c.ready?void act({action:'authorize',provider:c.provider}):setSetup(true)}>{busy===c.provider?'正在连接…':c.ready?'前往官方授权':'查看接入准备'}</button></div>
    </section>;
   })}</div>
   <div className="cn-boundary"><span aria-hidden="true">✓</span><p>当前仅做数据读取。保留店铺、国家和币种，先核对再入账。连接数据暂不覆盖手工报表，也不会自动调整库存、补货或广告投放。</p></div>
   <section className="cn-accounts"><div className="cn-section-head"><h2>已授权店铺与广告账户 <span>{data.accounts.length}</span></h2><a href="?page=agent-pilot">查看单店 Agent →</a></div>
    {!data.accounts.length?<div className="cn-empty"><span aria-hidden="true">⇄</span><h3>第一条数据，从连接开始</h3><p>先完成官方应用配置，再用店铺或广告账号授权。连接成功后，这里会列出真实账号和读取结果。</p><ol><li><b>1</b>准备官方应用</li><li><b>2</b>确认授权账号</li><li><b>3</b>读取并核对数据</li></ol><p className="cn-muted">马来西亚店铺与印尼店铺分别识别，不会自动混入印尼 Agent 试点。</p></div>:
    <div className="cn-account-list">{data.accounts.map((a:Row)=><article key={a.id} className="cn-account"><div className="cn-account-heading"><div><span className="cn-muted">{names[a.provider]} · {regions[a.region]||a.region||'地区未返回'}</span><h3>{a.name}</h3><p className="cn-id">账号编号 {a.externalId}</p></div><span className={'cn-badge '+(a.status==='connected'?'ok':'')}>{a.busy?'正在读取':states[a.status]||a.status}</span></div>
     <div className="cn-account-data"><div><span>最近成功读取</span><strong>{time(a.lastSyncAt)}</strong></div><div><span>{a.provider==='shop'?'订单数量':'已返回日期的消耗小计'}</span><strong>{!a.summary?'—':a.provider==='shop'?`${a.summary.count} 笔`:a.summary.spend===null?'待核对':`${Number(a.summary.spend).toLocaleString('zh-CN',{maximumFractionDigits:2})} ${a.summary.currency}`}</strong></div><div><span>数据期间</span><strong>{a.summary?`${a.startAt.slice(0,10)} — ${a.endAt.slice(0,10)}`:'读取后显示'}</strong></div></div>
     {a.summary&&<p className="cn-muted">{a.summary.rangeLabel}{a.summary.timezone?` · ${a.summary.timezone}`:''}{a.summary.missingDays?` · ${a.summary.missingDays} 天未返回记录`:''}{a.summary.missingSpend?` · ${a.summary.missingSpend} 条消耗未返回`:''}。{a.summary.note}</p>}
     {a.error&&<p className="cn-error">{a.error}。{a.summary?'上次结果仍保留，不能当作本次数据。':''}</p>}
     <div className="cn-actions"><button className="btn primary" disabled={!!busy||a.busy||['disconnected','expired','reconnect','configuration'].includes(a.status)} onClick={()=>void act({action:'sync',accountId:a.id})}>{busy===a.id?'正在处理…':'读取最近数据'}</button>{a.summary&&<button className="btn" disabled={!!busy} onClick={()=>void showDetail(a)}>查看明细</button>}{a.status!=='disconnected'&&<button className="cn-text-button" disabled={!!busy} onClick={()=>setDisconnect(a)}>断开连接</button>}</div>
    </article>)}</div>}
   </section>
   <details className="cn-setup" open={setup} onToggle={e=>setSetup(e.currentTarget.open)}><summary>接入准备与回调地址</summary><p>分别在 TikTok Shop Partner Center 和 TikTok for Business 配置自有应用。只申请本次所需的商家信息、订单和广告报表读取权限。</p><p>App ID / App Key、App Secret 和官方授权链接由管理员保存在服务端私密配置；不在此页面填写或展示密钥。</p>{data.configuration.map((c:Row)=><div className="cn-config-row" key={c.provider}><strong>{names[c.provider]}</strong><p>{c.message}</p><label>在官方应用填写的回调地址<input readOnly value={c.callbackUrl} onFocus={e=>e.currentTarget.select()}/></label><button className="btn" onClick={()=>void navigator.clipboard.writeText(c.callbackUrl).then(()=>setNotice('回调地址已复制。')).catch(()=>setError('未能复制，请选中地址后手动复制。'))}>复制地址</button></div>)}<p className="cn-muted">完成授权和首次真实读取后，才能确认接口已接通。GMV Max 专项指标、商品库存、退款和达人平台数据尚不属于本次读取范围。</p></details>
   {data.events.length>0&&<details className="cn-setup"><summary>最近连接记录</summary><ul>{data.events.map((e:Row,i:number)=><li key={i}>{time(e.createdAt)} · {names[e.provider]} · {({authorization_started:'发起授权',authorized:'授权完成',sync_completed:'数据读取完成',sync_failed:'数据读取未完成',disconnected:'断开本地连接'} as Row)[e.event]||e.event}</li>)}</ul></details>}
  </>}
  {disconnect&&<div className="cn-overlay"><section className="cn-dialog" role="dialog" aria-modal="true" aria-label="断开连接确认"><h2>停止读取这个账户？</h2><p>{disconnect.name}</p><p>本系统将停止读取，保留已核对的数据和连接记录。若要撤销官方授权，还需在 TikTok 后台取消。</p><div className="cn-actions"><button autoFocus className="btn" disabled={!!busy} onClick={()=>setDisconnect(null)}>继续保留</button><button className="btn" disabled={!!busy} onClick={()=>void act({action:'disconnect',accountId:disconnect.id})}>确认断开</button></div></section></div>}
  {detail&&<div className="cn-overlay"><section className="cn-dialog cn-wide" role="dialog" aria-modal="true" aria-label="平台数据明细"><div className="cn-section-head"><h2>{detail.account.name} · 读取明细</h2><button autoFocus className="btn" onClick={()=>setDetail(null)}>关闭</button></div><p>{detail.summary.note}</p><p className="cn-muted">{detail.startAt} — {detail.endAt} · 读取于 {time(detail.fetchedAt)} · 共 {detail.total} 条，展示前 50 条。</p><div className="cn-table-wrap"><table><thead><tr>{(detail.account.provider==='shop'?['订单编号','状态','原币金额','币种']:['日期','消耗','展示','点击']).map(v=><th key={v}>{v}</th>)}</tr></thead><tbody>{detail.records.map((r:Row,i:number)=><tr key={i}>{(detail.account.provider==='shop'?[r.id,r.status,r.amount,r.currency]:[r.date,r.spend,r.impressions,r.clicks]).map((v:any,j:number)=><td key={j}>{v===null||v===undefined||v===''?'未返回':String(v)}</td>)}</tr>)}</tbody></table>{!detail.records.length&&<p>此期间平台未返回记录。</p>}</div></section></div>}
 </div>;
}
