import {sampleWorkKinds} from './distribution-workflow-view.mjs';
import {atomicBatch,assertWritable,guardStatement} from './atomic.mjs';
import {creatorActor,canCreatorProfile} from './creator-policy.mjs';
import {fail,required,txt,integer,minor,instant} from './creator-model.mjs';
import {practiceFile} from './creator-practice-file.mjs';
import {assertFinanceOpen,financeClock,financeGuardSql,financialRates} from './finance-periods.mjs';
import {uniqueBusinessNumber} from './distribution-identifiers.mjs';
const rows=async(db,sql,args=[])=>(await db.prepare(sql).bind(...args).all()).results||[];
const one=(db,sql,args=[])=>db.prepare(sql).bind(...args).first();
const json=x=>JSON.parse(x||'{}'),uid=()=>crypto.randomUUID();
const roles=['管理员','财务','供应链','达人BD','运营','运营主管'];
const today=()=>new Date(Date.now()+7*3600000).toISOString().slice(0,10);
const day=(v,label)=>{const s=required(v,label,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s))||new Date(s).toISOString().slice(0,10)!==s||s>today())fail('日期无效或晚于印尼今天');return s;};
const past=(v,label,now)=>{const s=instant(v,label);if(s>now)fail('实际时间不能晚于现在');return s;};
const stampDay=s=>new Date(Date.parse(s)+7*3600000).toISOString().slice(0,10);
async function actorFor(db,a){const u=await one(db,'SELECT id,name,role,site,channel,active FROM users WHERE id=?',[a?.id]);if(!u?.active||u.role!==a.role||!roles.includes(u.role))fail('没有营销寄样权限',403);return creatorActor(db,u);}
async function context(db){const [profiles,scopes,rounds,users,warehouses]=await Promise.all([rows(db,'SELECT * FROM creator_profiles'),rows(db,'SELECT * FROM creator_scopes'),rows(db,'SELECT * FROM creator_rounds WHERE test_archived_at IS NULL'),rows(db,'SELECT id,name,role,active FROM users'),rows(db,"SELECT id,name,site,channel,active FROM warehouses WHERE site='印尼' AND channel='TikTok'")]);return {profiles,scopes,rounds,users,warehouses};}
function creatorScope(c,o){const profile=c.profiles.find(p=>p.id===o.creator_id),scope=c.scopes.find(s=>s.id===profile?.scope_id);return {profile,scope};}
function readAllowed(a,c,o){if(['管理员','财务'].includes(a.role))return true;if(a.role==='供应链')return o.status==='pending'||[o.reviewer_id,o.logistics_user_id,o.warehouse_user_id].includes(a.id);const {profile,scope}=creatorScope(c,o);return !!profile&&canCreatorProfile(a,profile,scope);}
function bdAllowed(a,c,o){const {profile,scope}=creatorScope(c,o);return a.role==='达人BD'&&!!profile&&canCreatorProfile(a,profile,scope);}
function activeStaff(c,id){if(!c.users.some(u=>u.id===id&&u.active&&u.role==='供应链'))fail('请选择启用的供应链执行账号');return id;}
function enabledWarehouse(c,id){const w=c.warehouses.find(w=>w.id===id&&w.active);if(!w)fail('请选择印尼 TikTok 启用仓库');return w;}
function capabilities(a,c,o,shipments){const bd=bdAllowed(a,c,o),stock=['管理员','供应链'].includes(a.role);return {
 review:stock&&o.status==='pending'&&o.applicant_id!==a.id,assign:a.role==='供应链'&&o.logistics_user_id===a.id&&['approved','assigned','partial'].includes(o.status),
 ship:a.role==='供应链'&&o.warehouse_user_id===a.id&&['assigned','partial'].includes(o.status),receipt:bd&&shipments.some(s=>!s.receipt),
 cancel:!['received','rejected','cancelled','closed'].includes(o.status)&&(a.role==='管理员'||o.status==='pending'&&bd||a.role==='供应链'&&[o.reviewer_id,o.logistics_user_id].includes(a.id)),cost:a.role==='财务'&&shipments.length>0};}
async function costRows(db){return rows(db,`SELECT c.*,o.round_id,o.order_no,s.shipment_no FROM marketing_sample_costs c JOIN marketing_sample_orders o ON o.id=c.order_id JOIN marketing_sample_shipments s ON s.id=c.shipment_id WHERE c.revision=(SELECT MAX(x.revision) FROM marketing_sample_costs x WHERE x.shipment_id=c.shipment_id AND x.kind=c.kind) ORDER BY c.business_date,c.id`);}
export async function marketingSampleCostSummary(db,{from='0001-01-01',to='9999-12-31',roundId=null}={}){
 const [all,shipments]=await Promise.all([costRows(db),rows(db,'SELECT s.*,o.round_id FROM marketing_sample_shipments s JOIN marketing_sample_orders o ON o.id=s.order_id')]);
 const relevant=shipments.filter(s=>(!roundId||s.round_id===roundId)&&s.business_date>=from&&s.business_date<=to),ids=new Set(relevant.map(s=>s.id)),entries=all.filter(c=>(!roundId||c.round_id===roundId)&&c.business_date>=from&&c.business_date<=to),rateMap={};
 for(const month of new Set(entries.map(e=>e.business_date.slice(0,7))))rateMap[month]=await financialRates(db,month);
 const lines=entries.map(({data_json,...e})=>{const rate=rateMap[e.business_date.slice(0,7)][e.currency];return {...e,site:'印尼',channel:'TikTok',costCenter:'印尼 TikTok 运营',data:json(data_json),rate:rate?.rate??null,rateId:rate?.id??null,cnyMinor:rate?Math.round(e.amount_minor*rate.rate):null};});
 // Latest revisions stay authoritative: a cost moved beyond the reporting cutoff
 // leaves the shipment's historical cost unresolved, without reviving its old row.
 const confirmedByCutoff=new Set(all.filter(c=>c.business_date<=to).map(c=>`${c.shipment_id}|${c.kind}`));
 const pending=relevant.flatMap(s=>['sample','freight'].filter(kind=>!confirmedByCutoff.has(`${s.id}|${kind}`)).map(kind=>({shipmentId:s.id,kind,businessDate:s.business_date})));
 const totals=Object.fromEntries(['sample','freight'].map(kind=>{const ls=lines.filter(c=>c.kind===kind);return [kind,{entryCount:ls.length,confirmedCount:ls.filter(c=>c.cnyMinor!=null).length,confirmedCnyMinor:ls.filter(c=>c.cnyMinor!=null).reduce((n,c)=>n+c.cnyMinor,0),missingRateCount:ls.filter(c=>c.cnyMinor==null).length,pendingCount:pending.filter(c=>c.kind===kind).length,currencies:Object.fromEntries([...new Set(ls.map(c=>c.currency))].map(currency=>[currency,ls.filter(c=>c.currency===currency).reduce((n,c)=>n+c.amount_minor,0)]))}];}));
 return {site:'印尼',channel:'TikTok',costCenter:'印尼 TikTok 运营',lines,pending,totals,shipmentCount:ids.size,method:'实际出库样品成本与寄样运费分列；不计销售、不计应收，不重复并入逐日销售成本。'};
}
export async function marketingSampleRoundCosts(db,roundId){
 const orders=await rows(db,"SELECT * FROM marketing_sample_orders WHERE round_id=? AND status NOT IN ('cancelled','rejected')",[roundId]);if(!orders.length)return null;
 const summary=await marketingSampleCostSummary(db,{roundId});const pendingOrders=orders.some(o=>['pending','approved','assigned','partial'].includes(o.status));
 return {...summary,complete:!pendingOrders&&summary.shipmentCount>0&&!summary.pending.length&&!summary.lines.some(x=>x.cnyMinor==null),managed:true};
}
export async function readMarketingSamples(db,identity){
 const actor=await actorFor(db,identity),c=await context(db);
 const [raw,items,ships,receipts,files,events,costs]=await Promise.all([rows(db,'SELECT * FROM marketing_sample_orders ORDER BY created_at DESC,id'),rows(db,'SELECT * FROM marketing_sample_items'),rows(db,'SELECT * FROM marketing_sample_shipments ORDER BY shipped_at,id'),rows(db,'SELECT * FROM marketing_sample_receipts'),rows(db,'SELECT id,order_id,shipment_id,filename,mime FROM marketing_sample_files'),rows(db,'SELECT * FROM marketing_sample_events ORDER BY created_at,id'),costRows(db)]);
 const canFinance=['管理员','财务'].includes(actor.role),visible=raw.filter(o=>readAllowed(actor,c,o));
 const orders=visible.map(o=>{const round=c.rounds.find(r=>r.id===o.round_id),{profile,scope}=creatorScope(c,o),shipments=ships.filter(s=>s.order_id===o.id).map(s=>({...s,items:json(s.items_json),receipt:receipts.find(r=>r.shipment_id===s.id)||null,files:files.filter(f=>f.shipment_id===s.id),costs:canFinance?costs.filter(k=>k.shipment_id===s.id).map(k=>({...k,data:json(k.data_json)})):[]}));return {...o,creatorName:profile?.name||'',roundNo:round?.round_no||'',shop:scope?.shop||'',contentStatus:json(o.terms_json).sampleOnly===true?'not_required':round?.status||'unknown',terms:json(o.terms_json),recipient:json(o.recipient_json),items:items.filter(i=>i.order_id===o.id),shipments,receiptStatus:!shipments.length?'pending':shipments.every(s=>s.receipt)?'received':'pending',costStatus:shipments.length&&shipments.every(s=>costs.some(k=>k.shipment_id===s.id&&k.kind==='sample')&&costs.some(k=>k.shipment_id===s.id&&k.kind==='freight'))?'confirmed':'pending',events:events.filter(e=>e.order_id===o.id&&(canFinance||e.action!=='cost')).map(e=>({...e,detail:json(e.detail_json)})),capabilities:capabilities(actor,c,o,shipments)};});
 for(const o of orders){const warehouseReady=c.users.some(u=>u.id===o.warehouse_user_id&&u.active&&u.role==='供应链')&&c.warehouses.some(w=>w.id===o.warehouse_id&&w.active);o.workKinds=sampleWorkKinds(o,{warehouseReady,followContent:bdAllowed(actor,c,o)});}
 const candidates=c.rounds.filter(r=>{const p=c.profiles.find(p=>p.id===r.creator_id),s=c.scopes.find(s=>s.id===p?.scope_id);return actor.role==='达人BD'&&p&&!p.deleted_at&&p.state!=='paused'&&s?.site==='印尼'&&s.platform==='TikTok'&&canCreatorProfile(actor,p,s)&&['approved','executing'].includes(r.status)&&r.approved_at&&json(r.terms_json).sampleQty>0&&!json(r.logistics_json).dispatch&&!raw.some(o=>o.round_id===r.id&&!['rejected','cancelled'].includes(o.status));}).map(r=>({...r,terms:json(r.terms_json),creatorName:c.profiles.find(p=>p.id===r.creator_id)?.name}));
 return {actor:{id:actor.id,name:actor.name,role:actor.role},serverTime:new Date().toISOString(),canCreate:actor.role==='达人BD',canFinance,orders,rounds:candidates,staff:c.users.filter(u=>u.active&&u.role==='供应链'),warehouses:c.warehouses.filter(w=>w.active),summary:canFinance?await marketingSampleCostSummary(db):null};
}
async function fingerprint(p){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(p))))].map(n=>n.toString(16).padStart(2,'0')).join('');}
export async function mutateMarketingSample(db,identity,p){
 const a=await actorFor(db,identity);await assertWritable(db);const action=required(p.action,'操作',30),operationId=required(p.operationId,'操作标识',100),hash=await fingerprint(p);
 const replay=async()=>{const op=await one(db,'SELECT * FROM system_operations WHERE id=?',[operationId]);if(!op)return null;const request=json(op.request_json);if(op.actor_id!==a.id||op.action!=='marketing-sample.'+action||request.hash!==hash)fail('操作标识已使用，请刷新',409);return {ok:true,id:request.id,replayed:true};};const old=await replay();if(old)return old;
 const clock=await one(db,"SELECT version FROM creator_clock WHERE id='global'"),fv=await financeClock(db),fg=financeGuardSql(fv),c=await context(db),now=new Date().toISOString(),statements=[],extra=[],args=[];
 const sql=(s,...args)=>statements.push(db.prepare(s).bind(...args)),put=(table,obj)=>{const keys=Object.keys(obj);sql(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`,...keys.map(k=>obj[k]));};
 let o,orderId,detail={},round;
 if(action==='create'){
  if(a.role!=='达人BD')fail('仅负责 BD 可申请寄样',403);
  round=c.rounds.find(r=>r.id===p.roundId);const profile=c.profiles.find(x=>x.id===round?.creator_id),scope=c.scopes.find(s=>s.id===profile?.scope_id);
  if(!round||!profile||!scope||!canCreatorProfile(a,profile,scope))fail('合作不在本人权限范围',403);
  if(profile.deleted_at||profile.state==='paused'||scope.site!=='印尼'||scope.platform!=='TikTok'||!['approved','executing'].includes(round.status)||!round.approved_at)fail('请选择印尼 TikTok 已确认且有效的合作');
  if(json(round.logistics_json).dispatch)fail('已登记历史寄样，不可再次扣库存');
  if(await one(db,"SELECT id FROM marketing_sample_orders WHERE round_id=? AND status NOT IN ('rejected','cancelled')",[round.id]))fail('本轮已有寄样单，请继续原单',409);
  // Existing manually verified sample costs are historical facts, never silently remapped.
  const prior=await one(db,'SELECT data_json FROM creator_finance WHERE round_id=? ORDER BY revision DESC LIMIT 1',[round.id]);if(prior&&['samples','sampleFreight'].some(k=>Number(json(prior.data_json).costs?.[k]?.minor)>0||json(prior.data_json).costs?.[k]?.mode==='included'))fail('本轮已有历史样品费用，请另建合作轮次避免重复归集');
  const terms=json(round.terms_json),sampleItems=(terms.items||[]).filter(i=>Number(i.sampleQty)>0);if(!sampleItems.length)fail('本轮没有约定寄样 SKU');
  const recipient={name:required(p.recipient?.name,'收件人',100),phone:required(p.recipient?.phone,'收件电话',80),address:required(p.recipient?.address,'完整地址',500),city:required(p.recipient?.city,'城市',100)};
  const agreementRef=required(p.agreementRef,'签署协议凭据',1000),signedOn=day(p.signedOn,'协议签署日期');orderId=uid();const orderNo=await uniqueBusinessNumber(db,'marketing_sample_orders','order_no','ID');
  put('marketing_sample_orders',{id:orderId,order_no:orderNo,round_id:round.id,creator_id:profile.id,scope_id:scope.id,applicant_id:a.id,status:'pending',agreement_ref:agreementRef,signed_on:signedOn,recipient_json:JSON.stringify(recipient),terms_json:JSON.stringify(terms),created_at:now,updated_at:now});
  for(const item of sampleItems){if(!await one(db,'SELECT sku FROM sku_settings WHERE sku=?',[item.sku]))fail('合作 SKU 已不存在');put('marketing_sample_items',{id:uid(),order_id:orderId,sku:item.sku,qty:integer(item.sampleQty,'样品数量',1,10000)});}
  sql('UPDATE creator_rounds SET version=version+1,updated_at=? WHERE id=?',now,round.id);detail={roundId:round.id,agreementRef,signedOn,costDocument:'待核',costCenter:'印尼 TikTok 运营'};
 }else{
  o=await one(db,'SELECT * FROM marketing_sample_orders WHERE id=?',[required(p.orderId,'寄样单',100)]);if(!o||!readAllowed(a,c,o))fail('寄样单不存在或无权查看',403);orderId=o.id;if(Number(p.version)!==o.version)fail('寄样单已更新，请刷新',409);
  round=c.rounds.find(r=>r.id===o.round_id);const items=await rows(db,'SELECT * FROM marketing_sample_items WHERE order_id=?',[o.id]),shipments=await rows(db,'SELECT * FROM marketing_sample_shipments WHERE order_id=?',[o.id]);
  const bump=values=>{const keys=Object.keys(values);sql(`UPDATE marketing_sample_orders SET ${keys.map(k=>k+'=?').join(',')},version=version+1,updated_at=? WHERE id=?`,...keys.map(k=>values[k]),now,o.id);};
  const movement=(item,delta,type,ref)=>sql("INSERT INTO inventory_movements(id,site,channel,sku,name,movement_type,qty_delta,balance_after,reference_type,reference_id,note,actor_id,created_at) SELECT ?,'印尼','TikTok',sku,name,?,?,qty,'营销寄样',?,?,?,? FROM inventory_balances WHERE site='印尼' AND channel='TikTok' AND sku=?",uid(),type,delta,ref,o.order_no,a.id,now,item.sku);
  if(action==='review'){
   if(!['管理员','供应链'].includes(a.role)||o.status!=='pending')fail('当前不能审核寄样单',403);if(o.applicant_id===a.id)fail('申请人不能审核自己的寄样单，请其他供应链或管理员独立审核',403);const reason=required(p.reason,'审核意见',1000);if(!['approve','reject'].includes(p.decision))fail('请选择审核结果');
   if(p.decision==='reject'){bump({status:'rejected',reviewer_id:a.id});detail={reason};}
   else{
    if(!round||!['approved','executing'].includes(round.status)||!round.approved_at||c.profiles.find(x=>x.id===o.creator_id)?.state==='paused')fail('合作已变化，请 BD 先核对');
    const logistics=activeStaff(c,required(p.logisticsUserId,'物流负责人',100));
    for(const item of items){const b=await one(db,"SELECT qty,reserved_qty FROM inventory_balances WHERE site='印尼' AND channel='TikTok' AND sku=?",[item.sku]);if(!b||b.qty-b.reserved_qty<item.qty)fail('印尼 TikTok 可用库存不足，整单未锁库',409);extra.push("EXISTS(SELECT 1 FROM inventory_balances WHERE site='印尼' AND channel='TikTok' AND sku=? AND qty-reserved_qty>=?)");args.push(item.sku,item.qty);sql("UPDATE inventory_balances SET reserved_qty=reserved_qty+?,updated_at=? WHERE site='印尼' AND channel='TikTok' AND sku=?",item.qty,now,item.sku);movement(item,0,'营销样品锁库',o.id);}
    bump({status:'approved',reviewer_id:a.id,logistics_user_id:logistics,approved_at:now});detail={reason,logisticsUserId:logistics};
   }
  }else if(action==='assign'){
   if(a.role!=='供应链'||o.logistics_user_id!==a.id||!['approved','assigned','partial'].includes(o.status))fail('仅本单物流负责人可在发货前派仓',403);
   const warehouse=enabledWarehouse(c,p.warehouseId);extra.push("EXISTS(SELECT 1 FROM warehouses WHERE id=? AND active=1 AND site='印尼' AND channel='TikTok')");args.push(warehouse.id);const worker=activeStaff(c,required(p.warehouseUserId,'仓库执行账号',100));bump({status:shipments.length?'partial':'assigned',warehouse_id:warehouse.id,warehouse_user_id:worker,assigned_at:now});detail={warehouseId:warehouse.id,warehouseName:warehouse.name,warehouseUserId:worker,reason:required(p.reason,'派仓说明',1000)};
  }else if(action==='ship'){
   if(a.role!=='供应链'||o.warehouse_user_id!==a.id||!['assigned','partial'].includes(o.status))fail('仅派定仓库执行账号可登记实际出库',403);const warehouse=enabledWarehouse(c,o.warehouse_id);extra.push("EXISTS(SELECT 1 FROM warehouses WHERE id=? AND active=1 AND site='印尼' AND channel='TikTok')");args.push(warehouse.id);
   if(!round||!['approved','executing','completed'].includes(round.status))fail('合作已终止，请先处理寄样余量');
   const at=past(p.shippedAt,'实际寄出时间',now);if(at<o.assigned_at||at<o.approved_at)fail('实际寄出时间不能早于库存审核及派仓');const businessDate=stampDay(at);await assertFinanceOpen(db,businessDate);
   if(!Array.isArray(p.items)||!p.items.length||p.items.length>100||new Set(p.items.map(i=>i.itemId)).size!==p.items.length)fail('请选择本次实际出库 SKU 和数量');
   const shipped=p.items.map(v=>{const item=items.find(i=>i.id===v.itemId);if(!item)fail('出库 SKU 不属于本单');const qty=integer(v.qty,'实际出库数量',1,10000);if(qty>item.qty-item.shipped_qty-item.released_qty)fail('实际数量超过本单剩余数量');return {itemId:item.id,sku:item.sku,qty};});
   if(!Array.isArray(p.photos)||!p.photos.length||p.photos.length>4)fail('请上传1至4张打包照片');const photos=p.photos.map(practiceFile);if(photos.some(f=>!f||!['image/png','image/jpeg'].includes(f.mime)))fail('打包照片仅支持 PNG 或 JPEG');
   const shipmentId=uid(),shipmentNo=o.order_no+'-S-'+String(shipments.length+1).padStart(3,'0');put('marketing_sample_shipments',{id:shipmentId,order_id:o.id,shipment_no:shipmentNo,business_date:businessDate,shipped_at:at,carrier:required(p.carrier,'承运商',100),tracking_no:required(p.trackingNo,'运单或 Lalamove 订单号',150),warehouse_id:warehouse.id,warehouse_name:warehouse.name,actor_id:a.id,items_json:JSON.stringify(shipped),created_at:now});
   for(const f of photos)put('marketing_sample_files',{...f,order_id:o.id,shipment_id:shipmentId,actor_id:a.id,created_at:now});
   for(const item of shipped){extra.push("EXISTS(SELECT 1 FROM inventory_balances WHERE site='印尼' AND channel='TikTok' AND sku=? AND qty>=reserved_qty AND reserved_qty>=?)");args.push(item.sku,item.qty);sql("UPDATE inventory_balances SET qty=qty-?,reserved_qty=reserved_qty-?,updated_at=? WHERE site='印尼' AND channel='TikTok' AND sku=?",item.qty,item.qty,now,item.sku);sql('UPDATE marketing_sample_items SET shipped_qty=shipped_qty+? WHERE id=?',item.qty,item.itemId);movement(item,-item.qty,'营销样品出库',shipmentId);}
   const total=items.reduce((n,i)=>n+i.qty-i.released_qty,0),qty=items.reduce((n,i)=>n+i.shipped_qty,0)+shipped.reduce((n,i)=>n+i.qty,0);bump({status:qty===total?'shipped':'partial'});
   const logistics=json(round.logistics_json);logistics.dispatch={...(logistics.dispatch||{}),at:logistics.dispatch?.at||at,orderNumber:o.order_no,sampleOrderId:o.id,qty,items:items.map(i=>({sku:i.sku,sampleQty:i.shipped_qty+(shipped.find(s=>s.itemId===i.id)?.qty||0)}))};sql('UPDATE creator_rounds SET logistics_json=?,version=version+1,updated_at=? WHERE id=?',JSON.stringify(logistics),now,round.id);detail={shipmentId,shipmentNo,items:shipped};
  }else if(action==='receipt'){
   if(!bdAllowed(a,c,o))fail('仅负责 BD 可确认样品签收',403);const shipment=shipments.find(s=>s.id===p.shipmentId);if(!shipment)fail('请选择本单实际发货记录');if(await one(db,'SELECT id FROM marketing_sample_receipts WHERE shipment_id=?',[shipment.id]))fail('该批已签收',409);
   const at=past(p.receivedAt,'实际签收时间',now);if(at<shipment.shipped_at)fail('签收时间不能早于寄出');put('marketing_sample_receipts',{id:uid(),shipment_id:shipment.id,order_id:o.id,received_at:at,receiver:required(p.receiver,'实际签收人',100),proof_ref:required(p.proofRef,'签收凭据',1000),actor_id:a.id,created_at:now});
   const count=Number((await one(db,'SELECT COUNT(*) n FROM marketing_sample_receipts WHERE order_id=?',[o.id])).n)+1,received=count===shipments.length&&!items.some(i=>i.qty>i.shipped_qty+i.released_qty);bump({status:received&&o.status!=='closed'?'received':o.status});
   if(received&&round){const logistics=json(round.logistics_json);logistics.receipt={at,evidence:p.proofRef,sampleOrderId:o.id};sql('UPDATE creator_rounds SET logistics_json=?,version=version+1,updated_at=? WHERE id=?',JSON.stringify(logistics),now,round.id);}detail={shipmentId:shipment.id,receivedAt:at};
  }else if(action==='cancel'){
   const shipViews=shipments.map(s=>({...s,receipt:null}));if(!capabilities(a,c,o,shipViews).cancel)fail('当前不能取消寄样余量',403);
   const reason=required(p.reason,'取消及后续处理说明',1000);if(o.status!=='pending')for(const item of items){const n=item.qty-item.shipped_qty-item.released_qty;if(n>0){extra.push("EXISTS(SELECT 1 FROM inventory_balances WHERE site='印尼' AND channel='TikTok' AND sku=? AND reserved_qty>=?)");args.push(item.sku,n);sql("UPDATE inventory_balances SET reserved_qty=reserved_qty-?,updated_at=? WHERE site='印尼' AND channel='TikTok' AND sku=?",n,now,item.sku);sql('UPDATE marketing_sample_items SET released_qty=released_qty+? WHERE id=?',n,item.id);movement(item,0,'营销样品释放',o.id);}}
   bump({status:shipments.length?'closed':'cancelled'});detail={reason};
  }else if(action==='cost'){
   if(a.role!=='财务')fail('仅财务可核对实际寄样成本',403);const s=shipments.find(s=>s.id===p.shipmentId);if(!s)fail('费用必须关联本单实际出库');if(!['sample','freight'].includes(p.kind))fail('请选择样品成本或寄样运费');
   const previous=await one(db,'SELECT * FROM marketing_sample_costs WHERE shipment_id=? AND kind=? ORDER BY revision DESC LIMIT 1',[s.id,p.kind]);if(Number(p.revision||0)!==(previous?.revision||0))fail('费用版本已更新，请刷新',409);if(previous)await assertFinanceOpen(db,previous.business_date);const businessDate=day(p.businessDate,'费用业务日期');if(businessDate<s.business_date)fail('费用日期不能早于实际出库');await assertFinanceOpen(db,businessDate);
   const currency=required(p.currency,'原币种',3);if(!['CNY','IDR','MYR','THB','VND','PHP','USD'].includes(currency))fail('币种无效');let amount,breakdown;
   if(p.kind==='sample'){
    const actual=json(s.items_json);if(!Array.isArray(p.items)||p.items.length!==actual.length||new Set(p.items.map(i=>i.itemId)).size!==actual.length)fail('请逐项核对本次实际出库的样品成本');breakdown=actual.map(i=>{const input=p.items.find(x=>x.itemId===i.itemId);if(!input)fail('样品成本 SKU 与实际出库不匹配');const unitMinor=minor(input.unitCost,'实际单件成本');return {...i,unitMinor,amountMinor:i.qty*unitMinor};});amount=breakdown.reduce((n,i)=>n+i.amountMinor,0);
   }else{amount=minor(p.amount,'实际寄样运费');breakdown=[];}
   if(!Number.isSafeInteger(amount)||amount>1e14)fail('费用金额超出范围');
   const source=required(p.sourceRef,'费用唯一凭据行号',200),priorSource=await one(db,'SELECT * FROM marketing_sample_cost_sources WHERE source_ref=?',[source]);if(priorSource&&(priorSource.shipment_id!==s.id||priorSource.kind!==p.kind))fail('该费用凭据行已用于其他寄样费用',409);if(!priorSource)put('marketing_sample_cost_sources',{source_ref:source,shipment_id:s.id,kind:p.kind});
   put('marketing_sample_costs',{id:uid(),order_id:o.id,shipment_id:s.id,kind:p.kind,revision:(previous?.revision||0)+1,business_date:businessDate,currency,amount_minor:amount,source_ref:source,evidence:required(p.evidence,'实际费用凭证',1000),data_json:JSON.stringify({items:breakdown,reason:required(p.reason,'核对或修订原因',1000),site:'印尼',channel:'TikTok',costCenter:'印尼 TikTok 运营'}),actor_id:a.id,created_at:now});bump({status:o.status});sql('UPDATE creator_rounds SET version=version+1,updated_at=? WHERE id=?',now,o.round_id);detail={shipmentId:s.id,kind:p.kind,amountMinor:amount,currency};
  }else fail('不支持的营销寄样操作');
 }
 put('marketing_sample_events',{id:uid(),order_id:orderId,action,detail_json:JSON.stringify(detail),actor_id:a.id,actor_name:a.name,created_at:now});
 const guard="COALESCE((SELECT version FROM creator_clock WHERE id='global'),0)=? AND "+fg.sql+(extra.length?' AND '+extra.join(' AND '):'');
 try{await atomicBatch(db,[guardStatement(db,a,'marketing-sample.'+action,guard,[clock?.version||0,...fg.args,...args],operationId,{hash,id:orderId}),...statements]);}catch(e){const replayed=await replay();if(replayed)return replayed;if(/UNIQUE/.test(String(e)))fail('单据或凭据已登记，请刷新核对',409);throw e;}
 return {ok:true,id:orderId};
}
export async function readMarketingSampleFile(db,identity,id){const a=await actorFor(db,identity),c=await context(db),f=await one(db,'SELECT order_id FROM marketing_sample_files WHERE id=?',[id]),o=f&&await one(db,'SELECT * FROM marketing_sample_orders WHERE id=?',[f.order_id]);if(!o||!readAllowed(a,c,o))fail('附件不存在或无权查看',404);return one(db,'SELECT filename,mime,payload FROM marketing_sample_files WHERE id=?',[id]);}
// A lightweight next-action projection; it never loads image payloads or financial amounts.
export async function marketingSampleTasks(db,identity){
 if(!identity||!roles.includes(identity.role))return [];
 const a=await actorFor(db,identity),c=await context(db),[orders,ships,receipts,costs]=await Promise.all([rows(db,"SELECT * FROM marketing_sample_orders WHERE status NOT IN ('rejected','cancelled')"),rows(db,'SELECT id,order_id FROM marketing_sample_shipments'),rows(db,'SELECT shipment_id FROM marketing_sample_receipts'),rows(db,'SELECT DISTINCT shipment_id,kind FROM marketing_sample_costs')]);
 const tasks=[],add=(o,kind,title,detail,tab='marketing-samples',entity=o.id)=>tasks.push({tab,entity,title,detail:o.order_no+' · '+detail,level:'amber',kind,taskKey:'marketing-sample:'+o.id+':'+kind});
 for(const o of orders.filter(o=>readAllowed(a,c,o))){
  const shipments=ships.filter(s=>s.order_id===o.id).map(s=>({...s,receipt:receipts.some(r=>r.shipment_id===s.id)})),caps=capabilities(a,c,o,shipments),round=c.rounds.find(r=>r.id===o.round_id);
  if(caps.review)add(o,'review','核对营销寄样库存','协议、SKU 与可用库存');
  const warehouseReady=c.users.some(u=>u.id===o.warehouse_user_id&&u.active&&u.role==='供应链')&&c.warehouses.some(w=>w.id===o.warehouse_id&&w.active);
  if(caps.assign&&(o.status==='approved'||!warehouseReady))add(o,'assign','安排营销寄样派仓','指定仓库和执行账号');
  if(caps.ship&&warehouseReady)add(o,'ship','打包并发出营销样品','上传照片及运单，按实际数量出库');
  const awaiting=shipments.filter(s=>!s.receipt).length;if(caps.receipt)add(o,'receipt','确认营销样品签收',String(awaiting)+' 批待签收');
  if(bdAllowed(a,c,o)&&round&&json(o.terms_json).sampleOnly!==true&&['approved','executing'].includes(round.status))add(o,'content','跟进样品合作内容交付','签收与视频 / 直播交付分别跟进','creators',o.creator_id);
  if(caps.cost){const pending=shipments.reduce((n,s)=>n+['sample','freight'].filter(kind=>!costs.some(k=>k.shipment_id===s.id&&k.kind===kind)).length,0);if(pending)add(o,'cost','核对营销样品成本与运费',String(pending)+' 项实际出库费用待核');}
 }
 return tasks;
}
