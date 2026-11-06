"use client";
import {useEffect, useState} from 'react';

type Event = {at:string|null;kind:'actual'|'estimate'|'unknown';state:string;description:string};
type Row = {id:string;waybill:string;updatedAt:string;error:string;snapshot:{country:string;status:string;groups:{events:Event[]}[]}};
type View = {canManage:boolean;rows:Row[]};
const time = (value:string|null) => value ? new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}) : '时间待核实';

function Events({events}:{events:Event[]}) {
  return <>{(['actual','estimate','unknown'] as const).map(kind => {
    const selected = events.filter(event => event.kind === kind);
    if (!selected.length) return null;
    return <section key={kind}><h5>{{actual:'实际轨迹',estimate:'预计安排',unknown:'性质待核实'}[kind]}</h5>
      <ol className="production-timeline">{selected.map((event,i) => <li key={i}>
        <small>{time(event.at)}</small><p>{event.description || event.state || '百世暂未提供节点说明'}</p>
      </li>)}</ol></section>;
  })}</>;
}

export default function BestTracking({legId,references}:{legId:string;references:string[]}) {
  const [open,setOpen] = useState(false), [view,setView] = useState<View|null>(null);
  const [busy,setBusy] = useState(false), [error,setError] = useState(''), [waybill,setWaybill] = useState('');
  const [removeId,setRemoveId] = useState(''), [reload,setReload] = useState(0);
  useEffect(() => {
    if (!open || busy) return;
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch('/api/best-tracking?legId='+encodeURIComponent(legId),{cache:'no-store',signal:controller.signal});
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '轨迹读取失败');
        if (!controller.signal.aborted) setView(result);
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '轨迹读取失败'); }
    };
    void load();
    const timer = window.setInterval(load,60000);
    return () => {controller.abort(); window.clearInterval(timer);};
  },[legId,open,busy,reload]);

  async function submit(action:string,id?:string) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/best-tracking',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({legId,action,id,waybill})});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '操作失败，请重试');
      setView(result); setRemoveId('');
      if (action === 'link') setWaybill('');
    } catch (e) { setError(e instanceof Error ? e.message : '操作失败，请重试'); }
    finally {setBusy(false);}
  }

  const recorded = [...new Set(references.map(value => value.trim().toUpperCase()))]
    .filter(no => /^BS[A-Z0-9-]{5,48}$/.test(no) && !view?.rows.some(row => row.waybill === no));
  return <details className="transport-trace best-tracking" onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>百世运单与运输轨迹</summary>
    {error && <p role="alert" className="notice warn">{error} <button type="button" className="btn" onClick={()=>{setError('');setReload(n=>n+1);}}>重新读取</button></p>}
    {!view && !error && open && <p role="status">正在读取运单…</p>}
    {view && <>
      {!view.rows.length && <p>此目的地分批尚未关联百世运单。</p>}
      {view.rows.map(row => <article key={row.id} className="best-shipment">
        <header><div><strong>{row.waybill}</strong><p>收货国 {row.snapshot.country} · 同步于 {time(row.updatedAt)}（北京时间）</p></div>
          <span className="pill blue">{row.snapshot.status || '百世暂未提供状态'}</span></header>
        {row.error && <p className="notice warn" role="status">{row.error}。当前显示上次成功同步的轨迹。</p>}
        {!row.snapshot.groups.some(g=>g.events.length) && <p>百世暂未返回轨迹节点。</p>}
        {row.snapshot.groups.map((group,i) => <div key={i}>
          {row.snapshot.groups.length>1 && <h5>运输分组 {i+1}</h5>}<Events events={group.events}/>
        </div>)}
        {view.canManage && <div className="transport-actions"><button type="button" className="btn" disabled={busy} onClick={()=>submit('refresh',row.id)}>刷新轨迹</button>
          {removeId===row.id ? <><button type="button" className="btn" disabled={busy} onClick={()=>submit('unlink',row.id)}>确认解除本分批关联</button>
            <button type="button" className="btn" onClick={()=>setRemoveId('')}>取消</button></> :
            <button type="button" className="btn" disabled={busy} onClick={()=>setRemoveId(row.id)}>解除关联</button>}</div>}
      </article>)}
      {view.canManage && recorded.length>0 && <div className="transport-actions"><span>本分批已登记的凭证</span>
        {recorded.map(no => <button className="btn" key={no} type="button" disabled={busy} onClick={()=>setWaybill(no)}>{no}</button>)}</div>}
      {view.canManage && <form className="transport-actions" onSubmit={e=>{e.preventDefault();void submit('link');}}>
        <label>百世运单号<input value={waybill} required maxLength={50} placeholder="填写本目的地分批的运单号" onChange={e=>setWaybill(e.target.value)}/></label>
        <button className="btn primary" disabled={busy || !waybill.trim()}>{busy ? '处理中…' : '核对并关联运单'}</button>
      </form>}
    </>}
  </details>;
}
