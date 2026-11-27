import {allocate,fail} from './cost-profit-model.mjs';
import {required,minor} from './creator-model.mjs';
import {financeMode} from './finance-scope.mjs';
import {financialRates,financeClock,financeGuardSql,assertFinanceOpen} from './finance-periods.mjs';
import {atomicBatch,assertWritable,guardStatement} from './atomic.mjs';
const rows=async(db,sql,args=[])=>(await db.prepare(sql).bind(...args).all()).results||[];
const today=()=>new Date(Date.now()+7*3600000).toISOString().slice(0,10);
const currencies=['CNY','IDR','MYR','THB','VND','PHP','USD'];
const endOf=month=>new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),0)).toISOString().slice(0,10);
const stores=db=>rows(db,"SELECT s.id,s.shop,s.operator_id,s.version,u.name operator_name FROM creator_scopes s JOIN users u ON u.id=s.operator_id WHERE s.site='印尼' AND s.platform='TikTok' ORDER BY s.id");
const latest=(db,month)=>db.prepare('SELECT * FROM marketing_sample_revenue_bases WHERE month=? ORDER BY revision DESC LIMIT 1').bind(month).first();
function monthValue(month){if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month||'')||month>today().slice(0,7))fail('请选择当前或过去月份');return month;}
function sameStores(items,scopes){return items.length===scopes.length&&items.every(x=>scopes.some(s=>s.id===x.scopeId&&s.shop===x.shop&&s.operator_id===x.operatorId&&s.version===x.scopeVersion));}

// Site/platform sales cannot identify a shop. Finance verifies a complete shop-month
// basis with source evidence; allocation is a projection, never another expense.
export async function mutateSampleAllocationBasis(db,identity,p){
 await assertWritable(db);
 const actor=await db.prepare('SELECT id,role,active FROM users WHERE id=?').bind(identity?.id).first();
 if(!actor?.active||actor.role!==identity.role||actor.role!=='财务'||await financeMode(db,actor)!=='headquarters')fail('仅总部财务可核对寄样销售额分摊依据',403);
 const month=monthValue(p.month);await assertFinanceOpen(db,month+'-01');
 const version=await financeClock(db),clock=await db.prepare("SELECT version FROM creator_clock WHERE id='global'").first(),scopes=await stores(db),previous=await latest(db,month),revision=previous?.revision||0;
 if(Number(p.revision)!==revision)fail('销售额依据已更新，请刷新后再核对',409);
 if(p.confirmed!==true)fail('请确认各店铺销售额完整且口径一致');
 const through=String(p.throughDate||'');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(through)||!Number.isFinite(Date.parse(through))||new Date(through).toISOString().slice(0,10)!==through||through.slice(0,7)!==month||through>today()||through>endOf(month))fail('销售额截止日期须为本月已发生日期');
 if(!scopes.length||!Array.isArray(p.items)||p.items.length!==scopes.length||new Set(p.items.map(x=>x?.scopeId)).size!==scopes.length)fail('请逐店填写全部印尼 TikTok 店铺，零销售须明确填0');
 const items=scopes.map(s=>{
  const x=p.items.find(x=>x?.scopeId===s.id);if(!x)fail('店铺范围已变化，请刷新');
  if(!currencies.includes(x.currency))fail('销售额币种无效');
  const revenueMinor=minor(x.revenue,'店铺销售额');if(revenueMinor>1e12)fail('店铺销售额超出范围');
  return {scopeId:s.id,scopeVersion:s.version,shop:s.shop,operatorId:s.operator_id,operatorName:s.operator_name,revenueMinor,currency:x.currency,evidence:required(x.evidence,'店铺销售额依据',1000)};
 });
 const id=crypto.randomUUID(),data={items,method:'shop_revenue_share',confirmed:true,reason:required(p.reason,'销售额核对或修订说明',1000)},fg=financeGuardSql(version);
 await atomicBatch(db,[guardStatement(db,actor,'marketing-sample.allocationBasis',fg.sql+" AND COALESCE((SELECT version FROM creator_clock WHERE id='global'),0)=? AND COALESCE((SELECT MAX(revision) FROM marketing_sample_revenue_bases WHERE month=?),0)=?",[...fg.args,clock?.version||0,month,revision]),db.prepare('INSERT INTO marketing_sample_revenue_bases VALUES(?,?,?,?,?,?,?)').bind(id,month,revision+1,through,JSON.stringify(data),actor.id,new Date().toISOString())]);
 return {ok:true,id,revision:revision+1};
}

export async function sampleCostAllocations(db,summary,{from,to}){
 const months=[...new Set([...summary.lines.map(l=>l.business_date.slice(0,7)),...summary.pending.map(l=>l.businessDate.slice(0,7)),...(from.slice(0,7)===to.slice(0,7)?[from.slice(0,7)]:[])])].sort();
 const scopes=await stores(db),result=[];
 for(const month of months){
  const basis=await latest(db,month),saved=basis?JSON.parse(basis.data_json):null,rates=await financialRates(db,month),cutoff=[endOf(month),to,today()].sort()[0],issues=[];
  if(!basis)issues.push('待财务核对各店铺月销售额');
  if(!scopes.length)issues.push('尚未配置印尼 TikTok 店铺');
  if(saved&&!sameStores(saved.items,scopes))issues.push('店铺或负责运营已变化，需重新核对销售额范围');
  if(basis&&basis.through_date<cutoff)issues.push('销售额截止日期早于费用统计截点');
  const entries=scopes.map(s=>{
   const x=saved?.items.find(x=>x.scopeId===s.id),rate=x?rates[x.currency]:null,revenueCnyMinor=x&&rate?Math.round(x.revenueMinor*rate.rate):null;
   if(x&&!rate)issues.push(s.shop+' 缺销售额财务汇率');
   if(revenueCnyMinor!=null&&(!Number.isSafeInteger(revenueCnyMinor)||revenueCnyMinor>1e12))issues.push(s.shop+' 折算销售额超出范围');
   return {scopeId:s.id,shop:s.shop,operatorId:s.operator_id,operatorName:s.operator_name,revenueMinor:x?.revenueMinor??null,currency:x?.currency||'IDR',evidence:x?.evidence||'',revenueCnyMinor,rate:rate?.rate??null,rateId:rate?.id??null,share:null,sampleCnyMinor:null,freightCnyMinor:null,totalCnyMinor:null};
  });
  const denominator=entries.some(x=>x.revenueCnyMinor==null)?null:entries.reduce((n,x)=>n+x.revenueCnyMinor,0);
  if(denominator!=null&&!Number.isSafeInteger(denominator))issues.push('销售额合计超出安全计算范围');
  if(basis&&!(denominator>0))issues.push('已核销售额合计为零或不完整，暂不分摊');
  const sourceLines=summary.lines.filter(l=>l.business_date.slice(0,7)===month),pendingCount=summary.pending.filter(l=>l.businessDate.slice(0,7)===month).length,allocated=[];
  if(!issues.length){
   const weights=entries.map(x=>x.revenueCnyMinor);
   entries.forEach(x=>{x.share=x.revenueCnyMinor/denominator;x.sampleCnyMinor=0;x.freightCnyMinor=0;});
   for(const cost of sourceLines){
    const native=allocate(cost.amount_minor,weights),cny=cost.cnyMinor==null?null:allocate(cost.cnyMinor,weights);
    entries.forEach((entry,index)=>{
     const key=cost.kind==='sample'?'sampleCnyMinor':'freightCnyMinor';entry[key]=entry[key]===null||!cny?null:entry[key]+cny[index];
     allocated.push({scopeId:entry.scopeId,shop:entry.shop,operatorName:entry.operatorName,sourceId:cost.id,orderId:cost.order_id,orderNo:cost.order_no,shipmentNo:cost.shipment_no,kind:cost.kind,currency:cost.currency,amountMinor:native[index],cnyMinor:cny?.[index]??null,share:entry.share,sourceRevision:cost.revision});
    });
   }
   entries.forEach(x=>{if(summary.pending.some(p=>p.businessDate.slice(0,7)===month&&p.kind==='sample'))x.sampleCnyMinor=null;if(summary.pending.some(p=>p.businessDate.slice(0,7)===month&&p.kind==='freight'))x.freightCnyMinor=null;x.totalCnyMinor=x.sampleCnyMinor==null||x.freightCnyMinor==null?null:x.sampleCnyMinor+x.freightCnyMinor;});
  }
  result.push({month,revision:basis?.revision||0,basisId:basis?.id||null,basisActorId:basis?.actor_id||null,basisCreatedAt:basis?.created_at||null,throughDate:basis?.through_date||cutoff,cutoff,reason:saved?.reason||'',rows:entries,denominatorCnyMinor:denominator,issues:[...new Set(issues)],status:issues.length?'pending':pendingCount||sourceLines.some(l=>l.cnyMinor==null)?'partial':cutoff<endOf(month)?'provisional':'ready',sourceCount:sourceLines.length,pendingCostCount:pendingCount,lines:allocated});
 }
 return {scope:'印尼 TikTok',method:'同月各店铺已核销售额折合人民币后计算占比；实际样品成本与运费分列分摊，尾差按最大余数分配，合计与原费用一致。本表不新增费用、应付或现金，也不重复扣逐日利润。',months:result};
}
