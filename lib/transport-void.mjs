import {hasPermission} from './permissions.mjs';
import {assertWritable,guardStatement,atomicBatch} from './atomic.mjs';
export class TransportVoidError extends Error{constructor(status,message){super(message);this.status=status;}}
const fail=(status,message)=>{throw new TransportVoidError(status,message);};
const text=(v,n=600)=>String(v??'').trim().slice(0,n);
const rows=async(db,sql,args=[])=>{const r=await db.prepare(sql).bind(...args).all();if(!r.success)fail(500,'历史到仓凭据读取不完整，请重试');return r.results||[];};
const first=(db,sql,args=[])=>db.prepare(sql).bind(...args).first();
const permitted=actor=>{if(!hasPermission(actor.role,'transport.void'))fail(403,'仅管理员或供应链可核销历史已到仓运输单');};
const totals=items=>{const m=new Map();for(const i of items)m.set(i.sku,(m.get(i.sku)||0)+Number(i.qty));return [...m].map(([sku,qty])=>({sku,qty})).sort((a,b)=>a.sku.localeCompare(b.sku));};
const different=(a,b)=>JSON.stringify(totals(a))!==JSON.stringify(totals(b));
const pristineSql=`NOT EXISTS(SELECT 1 FROM transport_leg_items WHERE leg_id=? AND (received_qty<>0 OR pending_shelf_qty<>0 OR sellable_qty<>0 OR quarantine_qty<>0)) AND NOT EXISTS(SELECT 1 FROM transport_receipts WHERE leg_id=?) AND NOT EXISTS(SELECT 1 FROM transport_receipt_items r JOIN transport_leg_items i ON i.id=r.leg_item_id WHERE i.leg_id=?) AND NOT EXISTS(SELECT 1 FROM transport_shelf_confirmations s JOIN transport_leg_items i ON i.id=s.leg_item_id WHERE i.leg_id=?)`;
async function legContext(db,actor,legId){
 permitted(actor);const leg=await first(db,'SELECT * FROM transport_legs WHERE id=?',[text(legId,120)]);
 if(!leg)fail(404,'目的地运输单不存在');
 const items=await rows(db,'SELECT * FROM transport_leg_items WHERE leg_id=? ORDER BY sku,id',[leg.id]);
 return {leg,items,expectedItems:totals(items)};
}
async function historySource(db,leg,kind,id,requestedSkus,expectedItems){
 let document,allItems;
 if(kind==='document'){
  document=await first(db,'SELECT * FROM inbound_documents WHERE id=?',[id]);
  allItems=await rows(db,'SELECT * FROM inbound_document_lines WHERE document_id=? AND site=? AND channel=? ORDER BY sku,id',[id,leg.site,leg.channel]);
 }else if(kind==='legacy'){
  document=await first(db,'SELECT * FROM inbound_receipts WHERE id=?',[id]);
  allItems=document?(await rows(db,'SELECT * FROM inbound_allocations WHERE receipt_id=? AND site=? AND channel=?',[id,leg.site,leg.channel])).map(r=>({...r,sku:document.sku})):[];
 }else fail(400,'历史到仓凭据类型无效');
 if(!document||!text(document.proof_ref)||!allItems.length||allItems.some(i=>!Number.isSafeInteger(Number(i.qty))||Number(i.qty)<=0))fail(409,'所选历史到仓凭据无效，或不属于本单站点与渠道');
 let skus;
 if(requestedSkus!==undefined){if(!Array.isArray(requestedSkus)||!requestedSkus.length||requestedSkus.some(s=>typeof s!=='string'||!allItems.some(i=>i.sku===s))||new Set(requestedSkus).size!==requestedSkus.length)fail(400,'所选历史凭据SKU无效或重复');skus=[...requestedSkus].sort();}
 else{const matching=allItems.filter(i=>expectedItems.some(e=>e.sku===i.sku));skus=[...new Set((matching.length?matching:allItems).map(i=>i.sku))].sort();}
 const items=allItems.filter(i=>skus.includes(i.sku)),used=await rows(db,'SELECT s.sku,v.leg_id,l.leg_no FROM transport_leg_void_sources s JOIN transport_leg_voids v ON v.id=s.void_id JOIN transport_legs l ON l.id=v.leg_id WHERE s.source_kind=? AND s.source_id=? AND s.site=? AND s.channel=?',[kind,id,leg.site,leg.channel]);
 const sourceItems=totals(items).map(total=>{const lines=items.filter(i=>i.sku===total.sku),states=[...new Set(lines.map(i=>i.stock_state||'unknown'))];return {...total,name:lines[0].name||document.name||'',stockState:states.length===1?states[0]:'mixed'};});
 return {kind,id,receiptNo:document.receipt_no,proofRef:document.proof_ref,businessDate:document.business_date||String(document.received_at||'').slice(0,10),site:leg.site,channel:leg.channel,skus,sourceItems,expectedItems,isMismatch:different(expectedItems,items),usedByLegId:used.find(u=>skus.includes(u.sku))?.leg_id||null,usedByLegNo:used.find(u=>skus.includes(u.sku))?.leg_no||null,document,items};
}
const publicSource=s=>({kind:s.kind,id:s.id,receiptNo:s.receiptNo,proofRef:s.proofRef,businessDate:s.businessDate,date:s.businessDate,site:s.site,channel:s.channel,skus:s.skus,sourceItems:s.sourceItems,expectedItems:s.expectedItems,isMismatch:s.isMismatch,usedByLegId:s.usedByLegId,usedByLegNo:s.usedByLegNo,totalQty:s.sourceItems.reduce((n,i)=>n+i.qty,0),selectable:!s.usedByLegId});
export async function transportVoidCandidates(db,actor,p){
 const context=await legContext(db,actor,p.legId),{leg,expectedItems}=context;
 const q=text(p.q,100),max=Math.min(100,Math.max(1,Math.trunc(Number(p.limit)||40)));
 const sql=`SELECT 'document' kind,d.id,d.created_at at FROM inbound_documents d WHERE length(trim(d.proof_ref))>0 AND EXISTS(SELECT 1 FROM inbound_document_lines l WHERE l.document_id=d.id AND l.site=? AND l.channel=? AND l.qty>0) AND (?='' OR instr(d.receipt_no,?)>0 OR instr(d.proof_ref,?)>0)
 UNION ALL SELECT 'legacy' kind,r.id,r.received_at at FROM inbound_receipts r WHERE length(trim(r.proof_ref))>0 AND EXISTS(SELECT 1 FROM inbound_allocations a WHERE a.receipt_id=r.id AND a.site=? AND a.channel=? AND a.qty>0) AND (?='' OR instr(r.receipt_no,?)>0 OR instr(r.proof_ref,?)>0) ORDER BY at DESC,id LIMIT ?`;
 const matches=await rows(db,sql,[leg.site,leg.channel,q,q,q,leg.site,leg.channel,q,q,q,max]);
 const candidates=await Promise.all(matches.map(r=>historySource(db,leg,r.kind,r.id,undefined,expectedItems).then(publicSource)));
 return {ok:true,expectedItems,leg:{id:leg.id,legNo:leg.leg_no,version:leg.version,site:leg.site,channel:leg.channel,stage:leg.stage,expectedItems},candidates};
}
function sourceGuard(db,actor,source){
 const d=source.document,parts=[],args=[];
 if(source.kind==='document'){
  parts.push('EXISTS(SELECT 1 FROM inbound_documents WHERE id=? AND receipt_no=? AND proof_ref=? AND business_date=? AND total_qty=? AND created_at=?)');args.push(d.id,d.receipt_no,d.proof_ref,d.business_date,d.total_qty,d.created_at);
  for(const i of source.items){parts.push('EXISTS(SELECT 1 FROM inbound_document_lines WHERE id=? AND document_id=? AND site=? AND channel=? AND sku=? AND qty=? AND warehouse_id=? AND stock_state=? AND source_batch=?)');args.push(i.id,d.id,i.site,i.channel,i.sku,i.qty,i.warehouse_id,i.stock_state,i.source_batch);}
  for(const sku of source.skus){parts.push('(SELECT COUNT(*) FROM inbound_document_lines WHERE document_id=? AND site=? AND channel=? AND sku=?)=?');args.push(d.id,source.site,source.channel,sku,source.items.filter(i=>i.sku===sku).length);}
 }else{
  parts.push('EXISTS(SELECT 1 FROM inbound_receipts WHERE id=? AND receipt_no=? AND sku=? AND proof_ref=? AND total_qty=? AND received_at=? AND source_batch=?)');args.push(d.id,d.receipt_no,d.sku,d.proof_ref,d.total_qty,d.received_at,d.source_batch);
  for(const i of source.items){parts.push('EXISTS(SELECT 1 FROM inbound_allocations WHERE receipt_id=? AND site=? AND channel=? AND qty=?)');args.push(d.id,i.site,i.channel,i.qty);}
 }
 for(const i of source.sourceItems){parts.push('NOT EXISTS(SELECT 1 FROM transport_leg_void_sources WHERE source_kind=? AND source_id=? AND site=? AND channel=? AND sku=?)');args.push(source.kind,source.id,source.site,source.channel,i.sku);}
 return guardStatement(db,actor,'核对历史到仓核销凭据',parts.join(' AND '),args);
}
export async function voidTransportLeg(db,actor,p){
 await assertWritable(db);permitted(actor);
 const reason=text(p.reason),discrepancyReason=text(p.discrepancyReason,1000);
 if(p.confirmed!==true||reason.length<4)fail(400,'请填写核销原因，并确认历史到仓已另行登记、本次不增减库存');
 if(!Array.isArray(p.historyRefs)||!p.historyRefs.length||p.historyRefs.length>20||p.historyRefs.some(r=>!r||typeof r!=='object'||Array.isArray(r)))fail(400,'请明确选择1至20份已登记的历史到仓凭据');
 const refs=p.historyRefs.map(r=>({kind:text(r.kind,20),id:text(r.id,120),...(r.skus!==undefined?{skus:r.skus}: {})}));
 if(refs.some(r=>!['document','legacy'].includes(r.kind)||!r.id)||new Set(refs.map(r=>r.kind+':'+r.id)).size!==refs.length)fail(400,'历史到仓凭据重复或格式无效');
 refs.sort((a,b)=>(a.kind+':'+a.id).localeCompare(b.kind+':'+b.id));
 const legId=text(p.legId,120),request=JSON.stringify({actorId:actor.id,legId,refs,reason,discrepancyReason}),old=await first(db,'SELECT * FROM transport_leg_voids WHERE leg_id=?',[legId]);
 if(old){if(old.request_json===request)return {ok:true,voidId:old.id,legId,stage:'voided',replayed:true};fail(409,'该目的地运输单已核销，请查看原核销记录');}
 const {leg,items,expectedItems}=await legContext(db,actor,legId),version=Number(p.version);
 if(!Number.isSafeInteger(version)||version!==Number(leg.version))fail(409,'运输单已更新，请刷新核对后再核销');
 if(!['booking','sea_freight','port_arrived','customs_clearance','last_mile_delivery','awaiting_receipt'].includes(leg.stage)||!items.length||!(await first(db,`SELECT (${pristineSql}) ok`,Array(4).fill(legId)))?.ok)fail(409,'只有尚未登记任何签收、上架或隔离数量的运输单可核销；已有实收须走库存核对流程');
 const history=await Promise.all(refs.map(r=>historySource(db,leg,r.kind,r.id,r.skus,expectedItems)));
 if(history.some(h=>h.usedByLegId))fail(409,'所选历史到仓同站点、渠道与SKU已关联其他核销单，请核对原关联，不能重复使用');
 const mismatch=different(expectedItems,history.flatMap(h=>h.sourceItems));
 if(mismatch&&discrepancyReason.length<8)fail(400,'原运输SKU或数量与历史到仓不同，请明确填写差异说明（至少8个字）');
 const now=new Date().toISOString(),voidId='transport_void_'+crypto.randomUUID(),summary=history.map(publicSource);
 const statements=[guardStatement(db,actor,'核销历史已到仓运输单',`EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND role=?) AND EXISTS(SELECT 1 FROM transport_legs WHERE id=? AND version=? AND stage=? AND site=? AND channel=? AND total_qty=? AND batch_id=?) AND (SELECT COUNT(*) FROM transport_leg_items WHERE leg_id=?)=? AND ${pristineSql} AND NOT EXISTS(SELECT 1 FROM transport_leg_voids WHERE leg_id=?)`,[actor.id,actor.role,legId,version,leg.stage,leg.site,leg.channel,leg.total_qty,leg.batch_id,legId,items.length,...Array(4).fill(legId),legId])];
 for(const item of items)statements.push(guardStatement(db,actor,'核对原运输明细','EXISTS(SELECT 1 FROM transport_leg_items WHERE id=? AND leg_id=? AND batch_item_id=? AND sku=? AND qty=?)',[item.id,legId,item.batch_item_id,item.sku,item.qty]));
 for(const h of history)statements.push(sourceGuard(db,actor,h));
 statements.push(db.prepare("INSERT INTO transport_leg_voids(id,leg_id,kind,reason,discrepancy_reason,request_json,original_json,history_json,actor_id,actor_name,created_at) VALUES (?,?,'historical_inbound',?,?,?,?,?,?,?,?)").bind(voidId,legId,reason,discrepancyReason,request,JSON.stringify({leg,items}),JSON.stringify(summary),actor.id,actor.name,now));
 for(const h of history)for(const item of h.sourceItems)statements.push(db.prepare('INSERT INTO transport_leg_void_sources(void_id,source_kind,source_id,site,channel,sku,source_qty,receipt_no,proof_ref,source_json) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(voidId,h.kind,h.id,leg.site,leg.channel,item.sku,item.qty,h.receiptNo,h.proofRef,JSON.stringify({document:h.document,items:h.items.filter(i=>i.sku===item.sku)})));
 const evidence=JSON.parse(leg.evidence_json||'[]');evidence.push({stage:'voided',kind:'historical_inbound',voidId,reason,discrepancyReason,note:reason+(discrepancyReason?`；差异：${discrepancyReason}`:''),reference:summary.map(h=>h.receiptNo).join('、'),role:actor.role,history:summary,at:now,by:actor.name});
 statements.push(db.prepare("UPDATE transport_legs SET stage='voided',stage_owner='已核销',evidence_json=?,version=version+1,updated_at=? WHERE id=?").bind(JSON.stringify(evidence),now,legId),db.prepare("UPDATE transport_batches SET status=CASE WHEN EXISTS(SELECT 1 FROM transport_legs WHERE batch_id=? AND stage NOT IN ('on_shelf','voided')) THEN 'active' ELSE 'completed' END,updated_at=? WHERE id=?").bind(leg.batch_id,now,leg.batch_id),db.prepare("INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES (?,'核销历史已到仓运输单','transport_leg',?,?,?,?,?)").bind('audit_'+crypto.randomUUID(),legId,JSON.stringify({voidId,reason,discrepancyReason,expectedItems,history:summary,inventoryDelta:0,shipmentCommitmentPreserved:true}),actor.id,actor.name,now));
 try{await atomicBatch(db,statements);}catch(e){if(/UNIQUE/.test(String(e)))fail(409,'运输单或历史凭据已被其他人核销，请刷新核对');throw e;}
 return {ok:true,voidId,legId,stage:'voided',isMismatch:mismatch};
}
