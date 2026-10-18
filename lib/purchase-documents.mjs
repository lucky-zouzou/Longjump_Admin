import {atomicBatch,guardStatement,assertWritable} from './atomic.mjs';
export class FactoryDocumentError extends Error{constructor(status,message){super(message);this.status=status;}}
export const fail=(status,message)=>{throw new FactoryDocumentError(status,message)};
export const rows=async(db,sql,args=[]) => (await db.prepare(sql).bind(...args).all()).results||[];
export const parse=(value,fallback=[])=>{try{return JSON.parse(value||'')}catch{return fallback}};
export const text=(v,n=500)=>String(v??'').trim().slice(0,n);
export const keyOf=g=>JSON.stringify([g.supplierName,g.factoryName,g.seriesName]);
export const dateValid=v=>/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
export const today=()=>new Date(Date.now()+8*3600000).toISOString().slice(0,10);
export const TERMS='1、应及时通知采购订单上所有已确认的变化事项。\n2、收到订单后，请在48小时内确认交期并回复。\n3、必须保证所有产品质量符合要求，如有任何质量问题，72小时内回复纠正预防措施。\n4、由于供方原因的重大品质问题导致的所有损失由供方承担，且执行一赔五方案。\n5、必须在回签交期内准时交货，延误导致的损失将全部转稼供方。\n6、所有订单按交期排期生产，要求在指定共享文档保持更新。\n7、按我司发货通知单进行要求包装标识及防护。\n8、开票税率及付款条件以本单填写并审批的约定为准。';
export async function purchasePreparation(db,month){
 if(!/^\d{4}-\d{2}$/.test(month)||+month.slice(5)>12||+month.slice(5)<1)fail(400,'请选择有效月份');
 const submissions=await rows(db,'SELECT * FROM monthly_submissions WHERE month=? ORDER BY site,channel',[month]);
 const settings=await rows(db,'SELECT sku,name,product_series,supplier_name,factory_name FROM sku_settings ORDER BY sku');
 const settingsMap=new Map(settings.map(s=>[s.sku,s])),items=new Map(),groups=new Map();
 for(const submission of submissions)for(const line of parse(submission.items_json)){
  const item=items.get(line.sku)||{sku:line.sku,name:line.name,total:0,allocations:[]};
  item.total+=Number(line.qty);item.allocations.push({site:submission.site,channel:submission.channel,qty:Number(line.qty)});items.set(line.sku,item);
 }
 for(const item of [...items.values()].sort((a,b)=>a.sku.localeCompare(b.sku))){
  const s=settingsMap.get(item.sku)||{};
  if(!s.product_series||s.product_series==='待归类'||!s.supplier_name||!s.factory_name)fail(409,`${item.sku}需先维护产品系列、供应商和工厂`);
  const g={seriesName:s.product_series,supplierName:s.supplier_name,factoryName:s.factory_name};const key=keyOf(g),group=groups.get(key)||{...g,key,items:[]};group.items.push(item);groups.set(key,group);
 }
 const list=[...groups.values()];
 const sourceKey=JSON.stringify({submissions:submissions.map(s=>[s.id,s.version,s.items_json]),groups:list});
 const draft=await db.prepare('SELECT * FROM purchase_plan_drafts WHERE month=?').bind(month).first();
 const partners=await rows(db,"SELECT type,name,contact FROM business_partners WHERE active=1");
 return {month,sourceKey,groups:list,submittedCount:submissions.length,partners,draft:draft?{version:draft.version,sourceKey:draft.source_key,documents:parse(draft.documents_json),updatedAt:draft.updated_at}:null};
}
export function normalizePurchaseDocuments(groups,raw,{strict=false,month=''}={}){
 if(!Array.isArray(raw)||raw.length!==groups.length)fail(400,'采购单数量与最新工厂分组不一致，请重新汇总');
 const map=new Map(raw.map(d=>[d.key,d]));if(map.size!==groups.length)fail(400,'采购单分组重复');
 const numbers=new Set();
 return groups.map((g,index)=>{
  const r=map.get(g.key||keyOf(g));if(!r)fail(400,'采购单分组已变化');
  const d={key:g.key||keyOf(g),company:text(r.company,120)||'湖南品链创新科技有限公司',buyerInfo:text(r.buyerInfo,1500),number:text(r.number,100)||`PL-PO-${month.replace('-','')}-${String(index+1).padStart(3,'0')}`,orderDate:text(r.orderDate,10),currency:text(r.currency,3)||'CNY',supplierName:g.supplierName,factoryName:g.factoryName,seriesName:g.seriesName,supplierAddress:text(r.supplierAddress),contact:text(r.contact,120),phone:text(r.phone,80),taxRate:text(r.taxRate,20),paymentTerms:text(r.paymentTerms,500),terms:text(r.terms,4000),termsReviewed:r.termsReviewed===true,preparedBy:'',items:[]};
  if(numbers.has(d.number))fail(400,'采购单号重复');numbers.add(d.number);
  if(!['CNY','USD','IDR','MYR','THB','VND','PHP'].includes(d.currency))fail(400,'采购币种无效');
  if(strict&&(!dateValid(d.orderDate)||d.orderDate>today()||!d.taxRate||!d.paymentTerms||!d.terms||!d.termsReviewed||!d.contact||!d.phone))fail(400,`${d.number}请填写日期、联系人、电话、税率及付款条件，并逐单确认条款`);
  if(d.taxRate&&(!/^\d{1,2}(\.\d{1,2})?$/.test(d.taxRate)||Number(d.taxRate)>99))fail(400,'税率请填写0—99之间的百分比数字');
  if(!Array.isArray(r.items)||r.items.length!==g.items.length||new Set(r.items.map(i=>i.sku)).size!==g.items.length)fail(400,'采购SKU明细已变化，请重新汇总');
  d.items=g.items.map(source=>{
   const i=r.items.find(i=>i.sku===source.sku);if(!i)fail(400,'采购SKU不匹配');
   const price=text(i.purchasePrice,24),dueDate=text(i.dueDate,10);
   if(price&&!/^\d{1,7}(\.\d{1,2})?$/.test(price))fail(400,`${source.sku}采购价应为非负金额，最多两位小数`);
   if(strict&&(!price||!dateValid(dueDate)||dueDate<today()))fail(400,`${source.sku}请填写不含税采购价及不早于今天的交期`);
   const purchasePrice=price===''?null:Math.round(Number(price)*100)/100;
   return {...source,color:text(i.color,100),specification:text(i.specification,100),purchasePrice,dueDate,remark:text(i.remark),lineAmount:purchasePrice===null?null:Math.round(purchasePrice*100)*source.total/100};
  });
  if(strict&&d.items.some(i=>!Number.isSafeInteger(Math.round(i.lineAmount*100))))fail(400,'采购总金额超出系统范围');
  d.totalQty=d.items.reduce((s,i)=>s+i.total,0);d.totalAmount=d.items.some(i=>i.lineAmount===null)?null:d.items.reduce((s,i)=>s+Math.round(i.lineAmount*100),0)/100;
  if(strict&&!Number.isSafeInteger(Math.round(d.totalAmount*100)))fail(400,'采购总金额超出系统范围');
  return d;
 });
}
export async function savePurchaseDraft(db,actor,payload){
 if(actor.role!=='供应链')fail(403,'采购单由供应链准备');await assertWritable(db);
 const current=await purchasePreparation(db,text(payload.month,7));
 if(payload.sourceKey!==current.sourceKey)fail(409,'运营需求或工厂配置已变化，请重新汇总');
 const version=current.draft?.version||0;if(Number(payload.version||0)!==version)fail(409,'采购草稿已被其他人修改，请刷新');
 const documents=normalizePurchaseDocuments(current.groups,payload.documents,{month:current.month});
 await atomicBatch(db,[guardStatement(db,actor,'savePurchaseDraft',"NOT EXISTS (SELECT 1 FROM approval_requests WHERE type='monthly_plan' AND month=? AND status IN ('pending','approved')) AND COALESCE((SELECT version FROM purchase_plan_drafts WHERE month=?),0)=?",[current.month,current.month,version]),
 db.prepare('INSERT INTO purchase_plan_drafts(month,source_key,documents_json,version,actor_id,updated_at) VALUES(?,?,?,1,?,?) ON CONFLICT(month) DO UPDATE SET source_key=excluded.source_key,documents_json=excluded.documents_json,version=version+1,actor_id=excluded.actor_id,updated_at=excluded.updated_at').bind(current.month,current.sourceKey,JSON.stringify(documents),actor.id,new Date().toISOString())]);
 return {ok:true,version:version+1};
}
export async function purchaseDocumentsForSubmission(db,actor,month,seriesOrders){
 if(!seriesOrders.length)return {documents:[],guards:[]};
 const source=await purchasePreparation(db,month);
 if(!source.draft||source.draft.sourceKey!==source.sourceKey)fail(409,'请先在月度计划准备采购单；需求变化后需重新核对并保存');
 const documents=normalizePurchaseDocuments(seriesOrders,source.draft.documents,{strict:true,month}).map(d=>({...d,preparedBy:actor.name}));
 return {documents,guards:[guardStatement(db,actor,'purchaseDraftVersion','EXISTS(SELECT 1 FROM purchase_plan_drafts WHERE month=? AND version=? AND source_key=?)',[month,source.draft.version,source.sourceKey])]};
}
