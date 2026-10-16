"use client";
import {useEffect,useRef,useState} from "react";
import {hasPermission} from "../lib/permissions.mjs";
import {useWholesaleLanguage} from "./wholesale-language";
type Row=Record<string,any>;
const today=()=>new Date(Date.now()+7*3600000).toISOString().slice(0,10);

export default function CustomerReceipts({order:o,actor,busy,mutate,close,focus=false}:{order:Row;actor:Row;busy:boolean;mutate:(action:string,payload:Row)=>Promise<boolean>;close?:()=>void;focus?:boolean}){
 const {t,stamp,fmt}=useWholesaleLanguage(),target=useRef<HTMLElement>(null);
 const [shipmentId,setShipmentId]=useState(""),[businessDate,setDate]=useState(today()),[receiver,setReceiver]=useState(""),[proofRef,setProof]=useState(""),[note,setNote]=useState(""),[confirmed,setConfirmed]=useState(false),[revokeId,setRevokeId]=useState(""),[reason,setReason]=useState("");
 useEffect(()=>{if(focus){target.current?.focus({preventScroll:true});target.current?.scrollIntoView({block:"start",behavior:"smooth"});}},[focus]);
 const receipts:Row[]=o.customerReceipts||[],active=receipts.filter(r=>!r.revoked_at),pending:Row[]=o.shipments.filter((s:Row)=>!active.some(r=>r.shipment_id===s.id));
 const shipment=pending.find(s=>s.id===shipmentId)||pending[0],editable=hasPermission(actor.role,"wholesale.receive");
 const base={orderId:o.id,version:o.version};
 return <section ref={target} tabIndex={-1} className="wh-action-box wh-customer-receipts" aria-label={t("客户收货确认")}>
  <div className="panel-head"><h4>{t("客户收货确认")} · {o.order_no}</h4>{close&&<button type="button" className="btn" onClick={close}>{t("收起")}</button>}</div>
  <p><strong>{o.customer.name}</strong> · {t(o.customerReceipt.status)} · {t("已确认 {0} / {1} 个发货批次",[active.length,o.shipments.length])}</p>
  <p className="wh-copy">{t("由负责销售或经办人员核对客户签收后登记。按发货批次确认，不代表已付款或寄售已售，不会再次扣库存。缺件或尚未收到整批货物时请先跟进，暂勿确认。")}</p>
  {editable&&shipment&&<form onSubmit={async e=>{e.preventDefault();if(await mutate("customerReceiptConfirm",{...base,shipmentId:shipment.id,businessDate,receiver,proofRef,note,receivedConfirmed:confirmed})){setShipmentId("");setReceiver("");setProof("");setNote("");setConfirmed(false);}}}>
   <div className="wh-grid">
    <label className="wh-field"><span>{t("待收货发货批次")}</span><select disabled={busy} value={shipment.id} onChange={e=>{setShipmentId(e.target.value);setConfirmed(false);}}>{pending.map(s=><option key={s.id} value={s.id}>{s.shipment_no} · {s.business_date}</option>)}</select></label>
    <label className="wh-field"><span>{t("客户实际收货日期")}</span><input required type="date" min={shipment.business_date} max={today()} value={businessDate} onChange={e=>setDate(e.target.value)}/></label>
    <label className="wh-field"><span>{t("客户收货人")}</span><input required maxLength={100} value={receiver} onChange={e=>setReceiver(e.target.value)} placeholder={t("填写实际签收人姓名")}/></label>
    <label className="wh-field"><span>{t("收货核对依据")}</span><input required minLength={4} maxLength={600} value={proofRef} onChange={e=>setProof(e.target.value)} placeholder={t("签收单号、物流签收记录或客户确认消息")}/></label>
   </div>
   <div className="wh-history"><strong>{t("本批次商品")}</strong><p>{shipment.items.map((i:Row)=>`${o.items.find((r:Row)=>r.id===i.order_item_id)?.sku} × ${fmt(i.qty)}`).join("；")}</p><small>{t("物流单号：")}{shipment.tracking_no||"—"}</small></div>
   <label className="wh-field"><span>{t("收货备注（选填）")}</span><textarea rows={2} maxLength={600} value={note} onChange={e=>setNote(e.target.value)}/></label>
   <label className="wh-check"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>{t("已与客户或签收凭证核实，本批次所有商品均已收到")}</label>
   <button className="btn primary" disabled={busy||!confirmed||!receiver.trim()||proofRef.trim().length<4}>{busy?t("正在保存，请稍候…"):t("确认客户收货")}</button>
  </form>}
  {!o.shipments.length&&<p>{t("尚未发货，实际出库后可登记客户收货。")}</p>}
  {!!o.shipments.length&&!pending.length&&<p className="wh-copy">{t("当前已发批次均已登记收货；后续新发批次仍需单独确认。")}</p>}
  <h5>{t("客户收货记录")}</h5>
  {!receipts.length&&<p className="wh-copy">{t("暂无收货确认记录，历史已发货订单也需核对后补充。")}</p>}
  {receipts.map(r=><div key={r.id} className="wh-history">
   <strong>{r.business_date} · {r.receiver} · {t(r.revoked_at?"收货确认已撤销":"客户已收货")}</strong>
   <p>{o.shipments.find((s:Row)=>s.id===r.shipment_id)?.shipment_no}</p><p>{r.proof_ref}</p>{r.note&&<p>{r.note}</p>}
   <small>{t("登记人：")}{r.actor_name} · {stamp(r.created_at)}</small>
   {r.revoked_at?<p>{t("撤销记录：")}{r.revoked_by_name} · {stamp(r.revoked_at)} · {r.revoke_reason}</p>:editable&&(["管理员","财务"].includes(actor.role)||r.actor_id===actor.id)&&<>
    <button type="button" className="btn" disabled={busy} onClick={()=>{setRevokeId(revokeId===r.id?"":r.id);setReason("");}}>{t("撤销误确认")}</button>
    {revokeId===r.id&&<form onSubmit={async e=>{e.preventDefault();if(await mutate("customerReceiptRevoke",{...base,receiptId:r.id,reason})){setRevokeId("");setReason("");}}}>
     <label className="wh-field"><span>{t("撤销原因（至少4个字）")}</span><input required minLength={4} maxLength={600} value={reason} onChange={e=>setReason(e.target.value)}/></label>
     <p className="wh-copy">{t("仅撤销收货标记，保留原记录；实物退货请走退货实收登记。")}</p>
     <button className="btn danger" disabled={busy||reason.trim().length<4}>{t("确认撤销收货标记")}</button>
    </form>}
   </>}
  </div>)}
 </section>;
}
