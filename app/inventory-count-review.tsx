"use client";

import {Fragment,useRef,useState} from "react";

export type CountRequest = {
  id:string;site:string;channel:string;sku:string;system_qty:number;counted_qty:number;
  current_qty?:number;reason:string;status:string;creator_name?:string;creator_id:string;
  created_at:string;decision_comment?:string;reviewer_name?:string;
};
type Props = {
  rows:CountRequest[];busy:boolean;
  act:(action:string,payload:Record<string,unknown>,success:string,onError?:(message:string)=>void)=>Promise<Record<string,unknown>|null>;
};
const fmt=(value:number)=>value.toLocaleString("zh-CN");
const date=(value:string)=>new Date(value).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false});

export default function InventoryCountReview({rows,busy,act}:Props){
  const [editing,setEditing]=useState<{id:string;decision:"approve"|"reject"}|null>(null);
  const [comment,setComment]=useState(""),[error,setError]=useState(""),[message,setMessage]=useState("");
  const [showHistory,setShowHistory]=useState(false),[submitting,setSubmitting]=useState(false);
  const inFlight=useRef(false);
  const locked=busy||submitting;
  const visible=showHistory?rows:rows.filter(row=>row.status==="pending");
  const open=(row:CountRequest,decision:"approve"|"reject")=>{setEditing({id:row.id,decision});setComment("");setError("");setMessage("");};
  const submit=async(row:CountRequest)=>{
    if(!editing||locked||inFlight.current)return;
    if(comment.trim().length<3){setError("请填写至少3个字的复核意见，例如：已核对盘点表。");return;}
    if(editing.decision==="approve"&&(row.current_qty===undefined||Number(row.current_qty)!==Number(row.system_qty))){setError("当前库存与提交时不同，不能覆盖。请驳回此单，让运营按最新库存重新提交盘点。");return;}
    inFlight.current=true;setSubmitting(true);setError("");
    const success=editing.decision==="approve"?`${row.sku} 已批准，账面可售库存已设为 ${fmt(Number(row.counted_qty))} 件。`:`${row.sku} 已驳回，库存未调整。`;
    try{
      let failure="";
      const result=await act("decideInventoryCount",{requestId:row.id,decision:editing.decision,comment:comment.trim()},success,text=>{failure=text;setError(text);});
      if(result){setEditing(null);setComment("");setMessage(success);}
      else if(!failure)setError("本次未确认成功，请刷新页面核对该单状态后再操作。");
    }catch(cause){setError(cause instanceof Error?cause.message:"本次未确认成功，请刷新页面核对该单状态后再操作。");}
    finally{inFlight.current=false;setSubmitting(false);}
  };
  return <section className="panel count-review" aria-labelledby="count-review-title">
    <div className="panel-head"><div><h4 id="count-review-title">待复核盘点差异</h4><p>先核对来源，再确认库存调整；提交后库存变化时会阻止覆盖。</p></div><label className="report-toggle"><input type="checkbox" checked={showHistory} disabled={locked} onChange={e=>setShowHistory(e.target.checked)}/>显示已处理记录</label></div>
    <details className="count-basis"><summary>这些数字从哪里来？</summary><p><strong>提交时账面：</strong>提交盘点时，系统该站点、渠道、SKU 的账面可售库存；尚无库存记录时按 0 处理，不代表仓库实物一定为 0。</p><p><strong>提交实盘：</strong>运营手工录入或从盘点表导入的目标库存，系统不会自动向平台或 ERP 核验。原始文件名未保存在差异单中，请向提交人核对报表日期、盘点范围和凭证。</p><p><strong>差异：</strong>提交实盘 − 提交时账面。批准会把账面可售库存设为提交实盘数，并记录差额流水；预留、待上架、隔离库存不变。“原因”是提交人填写的说明。</p></details>
    {message&&<div className="notice info" role="status">{message}</div>}
    <div className="table-wrap"><table><thead><tr><th>站点 / 渠道 · SKU</th><th>提交人 / 时间</th><th className="num">提交时账面</th><th className="num">提交实盘</th><th className="num">差异</th><th className="num">当前账面</th><th>原因 / 复核意见</th><th>状态 / 操作</th></tr></thead><tbody>
      {visible.length===0?<tr><td colSpan={8}><div className="empty">{showHistory?"暂无盘点差异单":"暂无待复核盘点差异"}</div></td></tr>:visible.map(row=>{
        const delta=Number(row.counted_qty)-Number(row.system_qty),known=row.current_qty!==undefined;
        const stale=known&&Number(row.current_qty)!==Number(row.system_qty),active=editing?.id===row.id;
        return <Fragment key={row.id}><tr>
          <td><strong>{row.sku}</strong><div className="cell-note">{row.site} · {row.channel}</div></td>
          <td>{row.creator_name||row.creator_id}<div className="cell-note">{date(row.created_at)}（北京时间）</div></td>
          <td className="num">{fmt(Number(row.system_qty))}</td><td className="num">{fmt(Number(row.counted_qty))}</td>
          <td className="num">{delta>0?"+":""}{fmt(delta)}</td><td className="num">{known?fmt(Number(row.current_qty)):"—"}</td>
          <td>{row.reason}{row.decision_comment&&<div className="cell-note">{row.reviewer_name||"复核人"}：{row.decision_comment}</div>}</td>
          <td><span className={`pill ${row.status==="approved"?"green":"red"}`}>{row.status==="pending"?"待复核":row.status==="approved"?"已批准":"已驳回"}</span>{row.status==="pending"&&<><div className="count-actions"><button className="btn primary" disabled={locked||stale||!known} onClick={()=>open(row,"approve")}>批准</button><button className="btn danger" disabled={locked} onClick={()=>open(row,"reject")}>驳回</button></div>{stale&&<div className="count-conflict">库存已变化，请驳回后重新盘点。</div>}{!known&&<div className="count-conflict">库存尚未读取，请刷新页面。</div>}</>}</td>
        </tr>{active&&<tr><td colSpan={8}><form className="count-decision" aria-label={`${row.sku} 盘点复核`} onSubmit={event=>{event.preventDefault();void submit(row);}}>
          <strong>{editing.decision==="approve"?"确认批准":"确认驳回"} · {row.sku}</strong>
          <p>{editing.decision==="approve"?`批准后账面库存：${known?fmt(Number(row.current_qty)):"—"} → ${fmt(Number(row.counted_qty))} 件；本次差额 ${delta>0?"+":""}${fmt(delta)} 件。请先核对原始盘点依据。`:"驳回不会改变库存；运营可核实最新数量后重新提交。"}</p>
          <label>复核意见（至少 3 个字）<textarea autoFocus maxLength={500} value={comment} disabled={locked} onChange={e=>setComment(e.target.value)} placeholder="请填写已核对的盘点表、ERP报表编号或驳回原因" aria-invalid={Boolean(error)} aria-describedby={error?`count-error-${row.id}`:undefined}/></label>
          {error&&<div className="notice error" role="alert" id={`count-error-${row.id}`}>{error}</div>}
          {row.status!=="pending"&&<div className="notice info" role="status">此单已被处理，请关闭复核表单查看结果。</div>}
          {stale&&editing.decision==="approve"&&<div className="notice error" role="alert">提交后库存已变化，不能批准旧盘点。请取消后选择驳回。</div>}
          <div className="form-actions"><button type="button" className="btn" disabled={locked} onClick={()=>setEditing(null)}>取消</button><button type="submit" className={`btn ${editing.decision==="approve"?"primary":"danger"}`} disabled={locked||row.status!=="pending"||(editing.decision==="approve"&&(stale||!known))}>{submitting?"正在提交…":editing.decision==="approve"?"确认批准并调整库存":"确认驳回"}</button></div>
        </form></td></tr>}</Fragment>;
      })}
    </tbody></table></div>
  </section>;
}
