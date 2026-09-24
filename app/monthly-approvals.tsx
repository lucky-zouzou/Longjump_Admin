"use client";

import {useState} from "react";
import {SupplyPicker} from "./plan-changes";

type Row = Record<string,any>;
type Act = (action:string,payload:Row,success:string,onError?:(message:string)=>void)=>Promise<Row|null>;
const format=(value:number)=>Number(value||0).toLocaleString("zh-CN");
const labels:Record<string,string>={pending:"待管理员审批",withdrawn:"已撤回 · 待供应链送审",rejected:"已驳回 · 待供应链调整",approved:"已批准"};
const date=(value:string)=>new Date(value).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false});

function PlanCard({row,data,act,busy}:{row:Row;data:Row;act:Act;busy:boolean}) {
  const [mode,setMode]=useState(""),[comment,setComment]=useState(""),[error,setError]=useState("");
  const [supplyUserId,setSupplyUserId]=useState(data.users.some((u:Row)=>u.id===row.creator_id&&u.role==="供应链"&&u.active)?row.creator_id:"");
  const own=row.creator_id===data.actor.id,admin=data.actor.role==="管理员",supply=data.actor.role==="供应链";
  const pending=row.status==="pending",canWithdraw=pending&&own&&(admin||supply),canDecide=pending&&admin&&!own;
  const canResubmit=supply&&["withdrawn","rejected"].includes(row.status);
  const items:Row[]=row.payload?.items||[],series:Row[]=row.payload?.seriesOrders||[];
  const submitted=data.submissions.filter((r:Row)=>r.month===row.month);
  const complete=["马来西亚","印尼","泰国","越南","菲律宾"].reduce((sum,site)=>sum+["TikTok","Shopee"].filter(channel=>submitted.some((r:Row)=>r.site===site&&r.channel===channel)).length,0);
  const open=(next:string)=>{setMode(next);setComment("");setError("");};
  const submit=async(event:React.FormEvent)=>{
    event.preventDefault();setError("");
    const result=mode==="resubmit"
      ?await act("submitPlan",{month:row.month,version:row.version},"供应链已重新送审，请由管理员审批",setError)
      :mode==="withdraw"
        ?await act("withdrawPlan",{approvalId:row.id,version:row.version,reason:comment},"计划已撤回，运营需求已保留，请由供应链核对后重新送审",setError)
        :await act("decideApproval",{approvalId:row.id,version:row.version,decision:mode,comment,supplyUserId},mode==="approve"?"计划已批准，采购单与生产单已生成":"计划已驳回，等待供应链调整后重新送审",setError);
    if(result)setMode("");
  };
  return <article className="panel monthly-approval" aria-label={`${row.month}月度计划`}>
    <header className="approval-header"><div><h3>{row.month} 月度备货计划</h3><p>送审人：{row.creator_name||"历史账号"} · {row.creator_role} <span>版本 V{row.version}</span></p></div><span className={`pill ${row.status==="approved"?"green":"red"}`}>{labels[row.status]||row.status}</span></header>
    <div className="approval-totals"><span>产品系列<strong>{format(series.length)}</strong></span><span>SKU<strong>{format(items.length)}</strong></span><span>备货总量<strong>{format(items.reduce((sum,item)=>sum+Number(item.total||0),0))} 件</strong></span></div>
    {row.decision_comment&&<p className="approval-comment">最近处理意见：{row.decision_comment}</p>}
    {pending&&<div className={`notice ${own&&admin?"warn":"info"}`}>{own&&admin?"这张计划由您送审，不能自行批准或驳回。请先撤回，再由供应链账号重新送审，之后您就可以审批。":own?"您是本次送审人，等待管理员审批。需要调整时可以撤回。":admin?"请核对计划明细；批准时指定供应链负责人，驳回时填写原因。":"当前等待管理员审批；供应链账号负责送审和执行，不负责审批。"}</div>}
    {["withdrawn","rejected"].includes(row.status)&&<div className="notice info">运营已提交的需求保留，可以调整后再次提交；由供应链账号核对并重新送审，再交管理员审批。</div>}
    {row.status==="approved"&&<p className="cell-note">已进入采购与生产流程；后续数量调整请到月度计划提交变更审批。</p>}
    <details className="approval-detail"><summary>查看本版计划明细（{items.length} 个 SKU）</summary><div className="table-wrap"><table><thead><tr><th>SKU / 商品</th><th>站点 / 渠道分配</th><th className="num">总数量</th></tr></thead><tbody>{items.length?items.map((item:Row)=><tr key={item.sku}><td><strong>{item.sku}</strong><div className="cell-note">{item.name}</div></td><td>{(item.allocations||[]).map((a:Row)=><div key={`${a.site}-${a.channel}`}>{a.site} · {a.channel}：{format(a.qty)} 件</div>)}</td><td className="num">{format(item.total)}</td></tr>):<tr><td colSpan={3}>本月已确认无备货需求</td></tr>}</tbody></table></div></details>
    {!mode&&<div className="approval-actions">
      {canWithdraw&&<button className="btn danger" disabled={busy} onClick={()=>open("withdraw")}>撤回本人计划</button>}
      {canResubmit&&<button className="btn primary" disabled={busy} onClick={()=>open("resubmit")}>核对并重新送审</button>}
      {canDecide&&<><button className="btn primary" disabled={busy} onClick={()=>open("approve")}>批准计划</button><button className="btn danger" disabled={busy} onClick={()=>open("reject")}>驳回计划</button></>}
    </div>}
    {mode&&<form className="approval-editor" onSubmit={submit}>
      <h4>{mode==="withdraw"?"撤回本人计划":mode==="resubmit"?"核对最新运营需求":mode==="approve"?"批准计划并生成执行单":"驳回计划"}</h4>
      {mode==="resubmit"?<><p>重新送审将采用运营最新提交的需求，送审人变为当前供应链账号：<strong>{data.actor.name}</strong>。原计划和处理记录保留。</p><div className="notice info">{row.month} 提交完整度 {complete}/10 · 最新备货合计 {format(submitted.reduce((sum:number,r:Row)=>sum+Number(r.total_qty||0),0))} 件</div><div className="table-wrap"><table><thead><tr><th>站点 / 渠道</th><th>SKU 数</th><th className="num">备货量</th></tr></thead><tbody>{submitted.map((r:Row)=><tr key={r.id}><td>{r.site} · {r.channel}</td><td>{r.items?.length||0}</td><td className="num">{format(r.total_qty)}</td></tr>)}</tbody></table></div>{complete!==10&&<p role="alert">五站双渠道须全部提交后才能送审。</p>}</>:<>
        {mode==="withdraw"&&<p>撤回只解除本计划的待审批状态，保留运营需求和原版计划，下一步交供应链重新送审。</p>}
        {mode==="approve"&&<SupplyPicker users={data.users} value={supplyUserId} onChange={setSupplyUserId}/>}
        <label>{mode==="withdraw"?"撤回原因（至少4个字）":mode==="reject"?"驳回原因（至少3个字）":"批准意见（至少3个字）"}<textarea required minLength={mode==="withdraw"?4:3} maxLength={300} value={comment} onChange={e=>setComment(e.target.value)} autoFocus placeholder={mode==="withdraw"?"例如：调整送审人，由供应链重新送审":"请填写本次处理的具体意见"}/></label>
      </>}
      {error&&<div className="notice error" role="alert">{error}</div>}
      <div className="approval-actions"><button type="button" className="btn" disabled={busy} onClick={()=>setMode("")}>取消操作</button><button type="submit" className={`btn ${["withdraw","reject"].includes(mode)?"danger":"primary"}`} disabled={busy||(mode==="resubmit"?complete!==10:comment.trim().length<(mode==="withdraw"?4:3))||(mode==="approve"&&!supplyUserId)}>{busy?"处理中…":mode==="withdraw"?"确认撤回":mode==="resubmit"?"确认由我重新送审":mode==="approve"?"确认批准":"确认驳回"}</button></div>
    </form>}
    <details className="approval-detail approval-history"><summary>操作记录（{(row.history||[]).length}）</summary>{row.history?.length?<ol>{row.history.map((entry:Row)=><li key={entry.id}><div><strong>{entry.action}</strong>{entry.version!=null&&<span>V{entry.version}</span>}<time>{date(entry.createdAt)}</time></div><p>{entry.actorName}{entry.comment?` · ${entry.comment}`:""}</p>{entry.totalQty!=null&&<p>{entry.seriesCount} 个系列 · {entry.skuCount} 个 SKU · {format(entry.totalQty)} 件</p>}</li>)}</ol>:<p>暂无历史操作日志。原送审人：{row.creator_name||"历史账号"}，创建时间：{date(row.created_at)}；后续操作会逐项记录。</p>}</details>
  </article>;
}

export default function MonthlyApprovals({data,act,busy}:{data:Row;act:Act;busy:boolean}) {
  return <div className="monthly-approvals"><div className="approval-flow" aria-label="月度计划审批流程"><span>① 运营提交需求</span><span>② 供应链核对送审</span><span>③ 管理员审批</span><span>④ 采购与生产执行</span></div><p className="approval-flow-note">需修改时：申请人撤回或管理员驳回 → 运营调整需求 → 供应链重新送审。每次处理保留操作人、时间、原因及计划快照。</p>{data.approvals.filter((r:Row)=>r.type==="monthly_plan").length?data.approvals.filter((r:Row)=>r.type==="monthly_plan").map((row:Row)=><PlanCard key={`${row.id}-${row.version}`} row={row} data={data} act={act} busy={busy}/>):<div className="panel empty">暂无月度计划审批记录，请由供应链在月度计划中送审。</div>}</div>;
}
