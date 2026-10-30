import {atomicBatch,assertWritable,guardStatement} from './atomic.mjs';
import {claimFinanceState,claimWriteGuard} from './claim-finance.mjs';
import {financeClock,assertFinanceOpen} from './finance-periods.mjs';
import {validDay,localDay} from './promotion-model.mjs';
const rows=async(db,sql,args=[])=>(await db.prepare(sql).bind(...args).all()).results||[];
const fail=(m,status=400)=>{throw Object.assign(new Error(m),{status});};
const text=(v,label)=>{const s=String(v||'').trim();if(s.length<4||s.length>2000)fail('请填写'+label+'（至少4字）');return s;};
const deliverySql=`SELECT COALESCE(SUM(ri.received_qty),0) qty FROM transport_receipt_items ri JOIN transport_receipts rec ON rec.id=ri.receipt_id JOIN transport_leg_items li ON li.id=ri.leg_item_id JOIN transport_legs l ON l.id=li.leg_id JOIN transport_batch_items bi ON bi.id=li.batch_item_id JOIN series_production_orders pr ON pr.id=bi.production_order_id WHERE pr.purchase_order_id=? AND substr(datetime(rec.received_at,CASE WHEN l.site IN ('印尼','泰国','越南') THEN '+7 hours' ELSE '+8 hours' END),1,7)=?`;
const quality=r=>r.record_kind==='quality'||r.data.reason==='商品质量问题';
export async function canonicalFactory(db,r){
 const name=r.data.responsibility==='工厂'?r.data.liableName:r.data.factory;
 if(r.data.factoryId)return db.prepare("SELECT * FROM business_partners WHERE id=? AND type='supplier'").bind(r.data.factoryId).first();
 return db.prepare("SELECT p.* FROM quality_factory_aliases a JOIN business_partners p ON p.id=a.factory_id WHERE a.alias=? AND p.type='supplier'").bind(name||'').first();
}
export async function canSupplement(db,a,r){
 if(r.status==='void')return false;if(r.status==='draft')return a.id===r.owner_id;
 if(a.id===r.owner_id||['管理员','财务','供应链'].includes(a.role))return true;
 return a.role==='工厂'&&(await canonicalFactory(db,r))?.assigned_user_id===a.id;
}
export function settlementProgress(d){const live=(d.payments||[]).filter(p=>!p.reversed);return {recorded:live.reduce((n,p)=>n+p.amountCents,0),verified:live.filter(p=>p.allocationId).reduce((n,p)=>n+p.amountCents,0),unverified:live.filter(p=>!p.allocationId).reduce((n,p)=>n+p.amountCents,0)};}
export const closureActions=['linkFactory','linkSource','rectifyPlan','rectifyReview','payment','reversePayment'];
export async function recordQualityDelivery(db,a,p){
 if(!['管理员','供应链'].includes(a.role))fail('由管理员或供应链核对交付分母',403);await assertWritable(db);
 const factory=await db.prepare("SELECT * FROM business_partners WHERE id=? AND type='supplier' AND active=1").bind(p.factoryId||'').first();if(!factory)fail('请选择已核实工厂');
 if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(p.month||''))fail('月份无效');
 const po=await db.prepare('SELECT * FROM series_purchase_orders WHERE id=?').bind(p.reference||'').first();if(!po||po.supplier_name!==factory.name&&!await db.prepare('SELECT 1 FROM quality_factory_aliases WHERE alias=? AND factory_id=?').bind(po.supplier_name,factory.id).first())fail('请选择同主体采购单ID；未核实别名先核实主体');
 const delivered=await db.prepare(deliverySql).bind(po.id,p.month).first();
 if(!Number.isSafeInteger(p.qty)||p.qty<=0||p.qty!==delivered.qty)fail('分母须等于该采购单在所选月实际收货单登记数量（站点当地日）；到港日期不作到仓依据');
 const previous=await db.prepare('SELECT * FROM quality_delivery_evidence WHERE factory_id=? AND month=? AND reference=? ORDER BY revision DESC LIMIT 1').bind(factory.id,p.month,po.id).first();if((previous?.revision||0)!==p.revision)fail('分母已更新，请刷新',409);
 const note=text(p.note,'交付单及数量核对依据'),at=new Date().toISOString();
 await atomicBatch(db,[guardStatement(db,a,'quality.delivery',"COALESCE((SELECT MAX(revision) FROM quality_delivery_evidence WHERE factory_id=? AND month=? AND reference=?),0)=? AND EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND role=?)",[factory.id,p.month,po.id,p.revision,a.id,a.role]),guardStatement(db,a,'quality.delivery.sources',`(${deliverySql})=?`,[po.id,p.month,p.qty]),db.prepare('INSERT INTO quality_delivery_evidence VALUES(?,?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),factory.id,p.month,p.revision+1,p.qty,po.id,note,a.id,at)]);return {ok:true};
}
export async function mutateQualityClosure(db,a,p,r,audit){
 await assertWritable(db);if(['draft','void','closed'].includes(r.status))fail('请在已提交、未结案记录上处理');if(p.version!==r.version)fail('记录已更新，请刷新',409);
 const d=structuredClone(r.data),at=new Date().toISOString(),note=text(p.note,'处理及凭据依据'),extra=[];
 if(p.action==='linkFactory'){
  if(a.role!=='管理员')fail('工厂主体和别名由管理员核实',403);const factory=await db.prepare("SELECT * FROM business_partners WHERE id=? AND type='supplier' AND active=1").bind(p.factoryId||'').first();if(!factory)fail('请选择有效工厂主体');
  if(settlementProgress(d).recorded>0&&d.factoryId&&d.factoryId!==factory.id)fail('已有赔付，请先冲销核对，不可更换主体');
  d.factoryId=factory.id;d.factoryName=factory.name;d.factoryLinkEvidence=note;
  if(p.confirmAlias===true){const alias=String(d.responsibility==='工厂'?d.liableName:d.factory||'').trim();if(!alias)fail('当前记录没有可确认的原工厂名称');if(await db.prepare("SELECT 1 FROM business_partners WHERE type='supplier' AND name=? AND id<>?").bind(alias,factory.id).first())fail('该名称属于另一已登记工厂，不能作为别名合并');const old=await db.prepare('SELECT * FROM quality_factory_aliases WHERE alias=?').bind(alias).first();if(old&&old.factory_id!==factory.id)fail('该别名已关联其他工厂，请核实，不可直接覆盖');extra.push(guardStatement(db,a,'quality.alias',"NOT EXISTS(SELECT 1 FROM quality_factory_aliases WHERE alias=? AND factory_id<>?)",[alias,factory.id]),db.prepare('INSERT INTO quality_factory_aliases VALUES(?,?,?,?,?) ON CONFLICT(alias) DO NOTHING').bind(alias,factory.id,note,a.id,at));}
 }else if(p.action==='linkSource'){
  if(!['管理员','供应链'].includes(a.role)&&a.id!==r.owner_id)fail('由登记人、供应链或管理员关联原单',403);
  if(!['purchase','transport','sale'].includes(p.sourceKind))fail('请选择原单类型');let source;
  if(p.sourceKind==='purchase')source=await db.prepare('SELECT p.id,p.order_ref reference FROM series_purchase_orders p JOIN series_purchase_order_items i ON i.purchase_order_id=p.id WHERE p.id=? AND i.sku=?').bind(p.sourceId,r.sku).first();
  if(p.sourceKind==='transport')source=await db.prepare('SELECT l.id,l.leg_no reference FROM transport_legs l JOIN transport_leg_items i ON i.leg_id=l.id WHERE l.id=? AND i.sku=? AND l.site=? AND l.channel=?').bind(p.sourceId,r.sku,r.site,r.channel).first();
  if(p.sourceKind==='sale')source=await db.prepare('SELECT id,import_id reference FROM sales_records WHERE id=? AND sku=? AND site=? AND channel=? AND reversed_at IS NULL').bind(p.sourceId,r.sku,r.site,r.channel).first();
  if(!source)fail('原单不存在或与本站渠道SKU不匹配');d.sourceLinks=[...(d.sourceLinks||[]).filter(x=>x.kind!==p.sourceKind||x.id!==source.id),{...source,kind:p.sourceKind,note,actor:a.id,at}];
 }else if(p.action==='rectifyPlan'){
  if(!quality(r)||!['管理员','供应链'].includes(a.role))fail('管理员或供应链登记品质整改计划',403);
  const owner=await db.prepare("SELECT * FROM users WHERE id=? AND active=1 AND role IN ('供应链','工厂','运营')").bind(p.ownerId||'').first(),factory=await canonicalFactory(db,r);
  if(!owner||owner.role==='工厂'&&factory?.assigned_user_id!==owner.id||owner.role==='运营'&&(owner.site!==r.site||owner.channel!==r.channel))fail('请选择供应链、本工厂或本站渠道运营负责人');
  if(!validDay(p.reviewDate)||p.reviewDate<localDay(new Date(),'马来西亚'))fail('请选择今天或之后的复查日期');
  d.rectification={revision:(d.rectification?.revision||0)+1,rootCause:text(p.rootCause,'已核实根因或待核实原因'),measure:text(p.measure,'整改措施'),ownerId:owner.id,ownerName:owner.name,reviewDate:p.reviewDate,validationBatch:text(p.validationBatch,'验证批次'),source:note,authorId:a.id,createdAt:at,outcome:'pending'};
 }else if(p.action==='rectifyReview'){
  const plan=d.rectification;if(!quality(r)||!plan)fail('先登记结构化整改计划');if(!['管理员','供应链'].includes(a.role)||a.id===plan.ownerId||a.id===plan.authorId)fail('由独立管理员或供应链复查，不能自行确认整改有效',403);
  if(localDay(new Date(),'马来西亚')<plan.reviewDate)fail('未到计划复查日期，不能提前认定有效');if(!['effective','failed'].includes(p.outcome))fail('请选择复查有效或继续整改');
  if(!Array.isArray(p.fileIds)||!p.fileIds.length)fail('请关联本记录的复查附件');const files=await rows(db,'SELECT id,created_at FROM after_sales_files WHERE record_id=?',[r.id]);if(p.fileIds.some(id=>!files.some(f=>f.id===id&&f.created_at>=plan.createdAt)))fail('请补充本次整改计划后的验证批次附件');
  d.rectification={...plan,outcome:p.outcome,review:{actorId:a.id,actorName:a.name,at,note,fileIds:[...new Set(p.fileIds)],validationBatch:plan.validationBatch}};
 }else if(p.action==='payment'){
  if(a.role!=='财务'||r.status!=='confirmed')fail('管理员定责后，由财务核对实收或应付抵扣来源',403);if(d.responsibility!=='工厂')fail('此财务来源用于工厂索赔，其他责任方需另核实');
  const version=await financeClock(db),state=await claimFinanceState(db),s=state.sources.find(s=>s.id===p.sourceId&&!s.voided),factory=await canonicalFactory(db,r);
  if(!factory||!s||s.factory_id!==factory.id||s.currency!==d.currency)fail('赔付须关联同工厂主体、同原币的有效到账/抵扣凭据');
  if(!/^\d+(\.\d{1,2})?$/.test(String(p.amount)))fail('请输入实赔金额');const n=Math.round(Number(p.amount)*100);if(!Number.isSafeInteger(n)||n<=0||n>s.remaining)fail('金额超过凭据未分配余额');
  const date=p.date;if(!validDay(date)||date<s.business_date||date>localDay(new Date(),'马来西亚'))fail('分配日期不得早于来源或晚于今天');await assertFinanceOpen(db,date);
  const old=p.existingPaymentId?(d.payments||[]).find(x=>x.id===p.existingPaymentId&&!x.reversed&&!x.allocationId):null;if(p.existingPaymentId&&!old)fail('原赔付记录无效或已关联');if(old&&old.amountCents!==n)fail('补关联金额必须等于原赔付登记金额');
  if(settlementProgress(d).recorded+(old?0:n)>d.claimCents)fail('累计赔付不能超过已确认应赔');
  const id=crypto.randomUUID();extra.push(claimWriteGuard(db,a,version),db.prepare('INSERT INTO finance_claim_allocations VALUES(?,?,?,?,?,?,?,?)').bind(id,s.id,r.id,n,date,note,a.id,at));
  const payment={id:old?.id||crypto.randomUUID(),amountCents:n,reference:s.reference,date,note,actor:a.name,at,allocationId:id,sourceId:s.id,kind:s.kind};d.payments=old?d.payments.map(x=>x.id===old.id?{...x,...payment,original:x}:x):[...(d.payments||[]),payment];d.factoryId=factory.id;d.factoryName=factory.name;
 }else if(p.action==='reversePayment'){
  if(a.role!=='财务')fail('由财务冲销错误分配',403);const pay=d.payments?.find(x=>x.id===p.paymentId&&!x.reversed);if(!pay)fail('有效赔付记录不存在');const date=p.date;if(!validDay(date)||date<pay.date||date>localDay(new Date(),'马来西亚'))fail('请填写有效冲销日期');await assertFinanceOpen(db,date);await assertFinanceOpen(db,pay.date);const version=await financeClock(db);extra.push(claimWriteGuard(db,a,version));
  if(pay.allocationId)extra.push(db.prepare('INSERT INTO finance_claim_reversals VALUES(?,?,NULL,?,?,?,?)').bind(crypto.randomUUID(),pay.allocationId,date,note,a.id,at));
  d.payments=d.payments.map(x=>x.id===pay.id?{...x,reversed:{date,note,actor:a.id,at}}:x);
 }
 await atomicBatch(db,[guardStatement(db,a,'quality.'+p.action,"EXISTS(SELECT 1 FROM after_sales WHERE id=? AND version=? AND status=?) AND EXISTS(SELECT 1 FROM users WHERE id=? AND role=? AND active=1)",[r.id,r.version,r.status,a.id,a.role]),...extra,db.prepare('UPDATE after_sales SET data_json=?,version=version+1,updated_at=? WHERE id=?').bind(JSON.stringify(d),at,r.id),audit(db,a,r.id,p.action,{note,data:d,version:r.version+1})]);return {ok:true,id:r.id};
}
export async function qualityClosureData(db,actor,records,month){
 const factories=await rows(db,"SELECT id,name,assigned_user_id FROM business_partners WHERE type='supplier' AND active=1"),aliases=await rows(db,'SELECT * FROM quality_factory_aliases'),users=await rows(db,"SELECT id,name,role,site,channel FROM users WHERE active=1 AND role IN ('供应链','工厂','运营')");
 const denominators=await rows(db,'SELECT d.* FROM quality_delivery_evidence d WHERE revision=(SELECT MAX(x.revision) FROM quality_delivery_evidence x WHERE x.factory_id=d.factory_id AND x.month=d.month AND x.reference=d.reference)');
 for(const d of denominators){const current=await db.prepare(deliverySql).bind(d.reference,d.month).first();d.stale=current.qty!==d.qty;d.currentQty=current.qty;}
 const deliveryChoices=[];
 if(month&&['管理员','供应链'].includes(actor.role)){
  const pos=await rows(db,"SELECT p.id,p.order_ref,p.supplier_name FROM series_purchase_orders p WHERE EXISTS(SELECT 1 FROM series_production_orders pr JOIN transport_batch_items bi ON bi.production_order_id=pr.id JOIN transport_leg_items li ON li.batch_item_id=bi.id WHERE pr.purchase_order_id=p.id AND li.received_qty>0) ORDER BY p.created_at DESC");
  for(const p of pos){
   const factory=factories.find(f=>f.name===p.supplier_name)||factories.find(f=>aliases.some(a=>a.alias===p.supplier_name&&a.factory_id===f.id)),received=await db.prepare(deliverySql).bind(p.id,month).first();
   if(factory&&received.qty>0)deliveryChoices.push({id:p.id,reference:p.order_ref||p.id,factoryId:factory.id,qty:received.qty});
  }
 }
 const claims=['管理员','财务'].includes(actor.role)?await claimFinanceState(db):null;
 const sourceChoices={};for(const r of records){if(!['管理员','供应链'].includes(actor.role)&&r.owner_id!==actor.id)continue;sourceChoices[r.id]=[...(await rows(db,"SELECT DISTINCT p.id,p.order_ref reference,'purchase' kind FROM series_purchase_orders p JOIN series_purchase_order_items i ON i.purchase_order_id=p.id WHERE i.sku=? ORDER BY p.created_at DESC LIMIT 50",[r.sku])),...(await rows(db,"SELECT DISTINCT l.id,l.leg_no reference,'transport' kind FROM transport_legs l JOIN transport_leg_items i ON i.leg_id=l.id WHERE i.sku=? AND l.site=? AND l.channel=? ORDER BY l.created_at DESC LIMIT 50",[r.sku,r.site,r.channel])),...(await rows(db,"SELECT id,business_date||' / '||import_id reference,'sale' kind FROM sales_records WHERE sku=? AND site=? AND channel=? AND reversed_at IS NULL ORDER BY business_date DESC LIMIT 50",[r.sku,r.site,r.channel]))];}
 return {factories,aliases,sourceChoices,deliveryChoices,users:users.filter(u=>actor.role!=='运营'||u.role!=='运营'||u.site===actor.site&&u.channel===actor.channel),denominators,claimSources:claims?.sources||[],records:records.map(r=>{const name=r.data.responsibility==='工厂'?r.data.liableName:r.data.factory,id=r.data.factoryId||aliases.find(a=>a.alias===name)?.factory_id,f=factories.find(f=>f.id===id);return {...r,data:{...r.data,...(f?{factoryId:f.id,factoryName:f.name}:{})},settlement:settlementProgress(r.data),requiresRectification:quality(r)};})};
}
