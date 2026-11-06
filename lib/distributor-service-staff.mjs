import {atomicBatch,guardStatement} from './atomic.mjs';
import {indonesiaDate} from './wholesale.mjs';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const text=(v,max=500)=>typeof v==='string'?v.trim().slice(0,max):'';
const role=(actor,target)=>{if(actor.role!==target)fail('当前岗位无权办理此步骤',403);};
const remaining=(kind,col)=>`${col}-COALESCE((SELECT SUM(a.amount) FROM distributor_refund_allocations a WHERE a.kind='${kind}' AND a.source_id=s.id),0)`;

// Refunds use existing warehouse receipts and posted bank records. One source may cover several SKUs.
export async function distributorFinanceChoices(db,actor,r){
 role(actor,'财务');const x=r.data.dist;
 if(!x||x.kind!=='return'||x.state!=='approved')fail('请选择待财务处理的分销退货申请');
 const warehouse=remaining('return','s.qty'),funds=remaining('refund','s.amount');
 const list=async(sql,id)=>(await db.prepare(sql).bind(id).all()).results;
 return {returns:await list(`SELECT s.id,s.proof_ref ref,s.business_date day,${warehouse} available FROM wholesale_returns s
   WHERE s.order_item_id=? AND ${warehouse}>0 ORDER BY s.business_date,s.id`,x.item),
   refunds:await list(`SELECT s.id,s.reference ref,s.business_date day,${funds} available FROM wholesale_finance_entries s
   WHERE s.order_id=? AND s.kind='refund' AND NOT EXISTS(SELECT 1 FROM wholesale_finance_entries v WHERE v.reverses_id=s.id) AND ${funds}>0 ORDER BY s.business_date,s.id`,x.orderId)};
}
function allocate(caseId,kind,needed,ids,choices,guards,stmts,db){
 if(!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length||ids.length>200)fail('请选择本次对应的有效凭据');
 for(const id of ids){
   const source=choices.find(s=>s.id===id);
   if(!source||needed===0)fail('凭据已变更或多选，请重新核对');
   const n=Math.min(needed,source.available);needed-=n;
   const sql=kind==='return'?`SELECT 1 FROM wholesale_returns s WHERE s.id=? AND ${remaining('return','s.qty')}>=?`:
     `SELECT 1 FROM wholesale_finance_entries s WHERE s.id=? AND s.kind='refund' AND NOT EXISTS(SELECT 1 FROM wholesale_finance_entries v WHERE v.reverses_id=s.id) AND ${remaining('refund','s.amount')}>=?`;
   guards.push([`EXISTS(${sql})`,[id,n]]);
   stmts.push(db.prepare('INSERT INTO distributor_refund_allocations(case_id,kind,source_id,amount) VALUES(?,?,?,?)').bind(caseId,kind,id,n));
 }
 if(needed)fail('所选凭据可核销的数量或金额不足');
}
export async function processDistributorCase(db,actor,p,r,audit){
 const d=r.data,x=d.dist,now=new Date().toISOString(),day=indonesiaDate(),note=text(p.note,1000);
 if(!x||['draft','void','closed'].includes(r.status))fail('请选择有效的分销售后记录');
 const line=await db.prepare('SELECT * FROM wholesale_order_items WHERE id=? AND order_id=?').bind(x.item,x.orderId).first();
 if(!line)fail('原订单明细缺失，请核实');
 const guards=[['EXISTS(SELECT 1 FROM after_sales WHERE id=? AND version=? AND status=?)',[r.id,r.version,r.status]],
   ['EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND role=?)',[actor.id,actor.role]]], stmts=[];
 if(p.action==='distApprove'||p.action==='distReject'){
   role(actor,'管理员');
   if(x.state!=='submitted'||note.length<4)fail('请核对待审核申请并填写给客户的处理说明');
   if(p.action==='distApprove'&&x.kind==='return'){
     const amount=Number(p.amount);
     if(!Number.isSafeInteger(amount)||amount<=0||amount>line.unit_price*d.qty)fail('核准退款须为正整数且不能超过该明细的订单货值');
     x.approvedAmount=amount;
   }
   x.state=p.action==='distApprove'?'approved':'rejected';x.message=note;
   if(x.state==='rejected'||x.kind==='exchange')d.refundCents=0;
 }else if(p.action==='distUndoRefund'){
   role(actor,'财务');
   if(x.kind!=='return'||x.state!=='completed'||note.length<4)fail('请填写撤销本次售后核销的原因');
   stmts.push(db.prepare('DELETE FROM distributor_refund_allocations WHERE case_id=?').bind(r.id));
   x.state='approved';d.refundCents=null;
 }else if(p.action==='distFinish'){
   role(actor,'财务');
   if(x.state!=='approved'||note.length<4)fail('请先由管理员审核，并填写财务核对说明');
   if(x.kind==='return'){
     const choices=await distributorFinanceChoices(db,actor,r);
     allocate(r.id,'return',d.qty,p.returnIds,choices.returns,guards,stmts,db);
     allocate(r.id,'refund',x.approvedAmount,p.refundIds,choices.refunds,guards,stmts,db);
     d.refundCents=x.approvedAmount*100;
   }else{
     const receipt=text(p.receipt),carrier=text(p.carrier,100),tracking=text(p.tracking,120);
     const from=p.shipChannel,to=p.returnChannel;
     if(!receipt||!carrier||!tracking||p.physicalConfirmed!==true||
        ![from,to].every(ch=>['TikTok','Shopee'].includes(ch)))fail('请核对仓库实收及实际补发，填写收货凭据、库存渠道、承运商和运单号');
     guards.push(["EXISTS(SELECT 1 FROM inventory_balances WHERE site='印尼' AND channel=? AND sku=? AND qty-reserved_qty>=?)",[from,r.sku,d.qty]],
       ["EXISTS(SELECT 1 FROM inventory_balances WHERE site='印尼' AND channel=? AND sku=?)",[to,r.sku]],
       ["NOT EXISTS(SELECT 1 FROM wholesale_finance_periods WHERE status='closed' AND month>=?)",[day.slice(0,7)]],
       [`EXISTS(SELECT 1 FROM wholesale_order_items i WHERE i.id=? AND i.shipped_qty-i.returned_qty-
        COALESCE((SELECT SUM(json_extract(data_json,'$.qty')) FROM after_sales WHERE channel='线下分销' AND json_extract(data_json,'$.dist.item')=i.id
        AND json_extract(data_json,'$.dist.state')='completed' AND json_extract(data_json,'$.dist.kind')='exchange'),0)>=?)`,[x.item,d.qty]]);
     const movement=(ch,delta,label,detail)=>db.prepare(`INSERT INTO inventory_movements(id,site,channel,sku,name,movement_type,qty_delta,balance_after,reference_type,reference_id,note,actor_id,created_at)
       SELECT ?,'印尼',channel,sku,name,?,?,qty,'线下分销换货',?,?,?,? FROM inventory_balances WHERE site='印尼' AND channel=? AND sku=?`)
       .bind(crypto.randomUUID(),label,delta,r.id,detail,actor.id,now,ch,r.sku);
     stmts.push(db.prepare("UPDATE inventory_balances SET quarantine_qty=quarantine_qty+?,updated_at=? WHERE site='印尼' AND channel=? AND sku=?").bind(d.qty,now,to,r.sku),
       movement(to,0,'换货收回隔离',receipt+' · '+d.qty+'件'),
       db.prepare("UPDATE inventory_balances SET qty=qty-?,updated_at=? WHERE site='印尼' AND channel=? AND sku=?").bind(d.qty,now,from,r.sku),
       movement(from,-d.qty,'同SKU换新补发',carrier+' · '+tracking));
     Object.assign(x,{carrier,tracking,returnChannel:to,shipChannel:from});d.refundCents=0;
   }
   x.state='completed';
 }else fail('无效的分销售后操作');
 x.updatedAt=now;
 await atomicBatch(db,[guardStatement(db,actor,p.action,guards.map(([s])=>s).join(' AND '),guards.flatMap(([,args])=>args)),
   ...stmts,db.prepare('UPDATE after_sales SET data_json=?,updated_at=?,version=version+1 WHERE id=?').bind(JSON.stringify(d),now,r.id),
   audit(db,actor,r.id,p.action,{note,state:x.state,approvedAmount:x.approvedAmount,receipt:text(p.receipt),carrier:x.carrier,tracking:x.tracking,returnIds:p.returnIds,refundIds:p.refundIds})]);
 return {ok:true,id:r.id};
}
