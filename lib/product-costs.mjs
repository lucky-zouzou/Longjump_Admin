import {compareEffectiveCosts} from './effective-cost.mjs';
import {atomicBatch,assertWritable,guardStatement} from './atomic.mjs';
import {completeSalesDates} from './sales-completeness.mjs';
import {localDay,shiftDay,validDay} from './promotion-model.mjs';
import {COST_SITES,COST_BASIS,DEFAULT_RULES,validateRules,normalizeCost,classifyProduct,clean,fail,skuCode} from './product-cost-model.mjs';
export {ProductCostError} from './product-cost-model.mjs';
const rows=async(db,sql,args=[])=>(await db.prepare(sql).bind(...args).all()).results||[];
const hash=async v=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(v)))),n=>n.toString(16).padStart(2,'0')).join('');
const clock=async db=>(await db.prepare("SELECT version FROM product_cost_clock WHERE id='global'").first())?.version||0;
const salesClock=async db=>(await db.prepare("SELECT version FROM business_action_source_clock WHERE id='global'").first())?.version||0;
const group=(rs,key)=>{const m=new Map();for(const r of rs){const k=key(r);m.set(k,[...(m.get(k)||[]),r]);}return m;};
const scopeKey=r=>r.site+'|'+r.channel,skuKey=r=>scopeKey(r)+'|'+r.sku,costKey=r=>r.site+'|'+r.sku;
const canManage=a=>['管理员','财务'].includes(a.role);
export async function productCostAccess(db,a,write=false){
 if(!a||!['管理员','财务','运营','运营主管'].includes(a.role)||write&&!canManage(a))fail('当前岗位无商品成本操作权限',403);
 const live=await db.prepare('SELECT active,role,site,channel FROM users WHERE id=?').bind(a.id).first();
 if(!live||live.active!==1||live.role!==a.role||a.role==='运营'&&(live.site!==a.site||live.channel!==a.channel||!COST_SITES.includes(a.site)||!['TikTok','Shopee'].includes(a.channel)))fail('账号权限或站点已变化，请重新登录',403);
 return {canManage:canManage(a),canSetRules:a.role==='管理员'};
}
function actorGuard(db,a,version){return guardStatement(db,a,'product-cost.write',"COALESCE((SELECT version FROM product_cost_clock WHERE id='global'),0)=? AND EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND role=?)",[version,a.id,a.role]);}
const audit=(db,a,id,action,data)=>db.prepare('INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),action,'product_cost',id,JSON.stringify(data),a.id,a.name||'',new Date().toISOString());
const sourceData=r=>{try{return JSON.parse(r.source_json);}catch{return {};}};
const publicCost=r=>({...r,source:sourceData(r),source_json:undefined,unit:r.total??(r.purchase!=null&&r.freight!=null?r.purchase+r.freight:null),basisLabel:COST_BASIS[r.basis]});
export async function previewProductCosts(db,a,p){
 await productCostAccess(db,a,true);
 if(p.currency!=='CNY'||p.currencyConfirmed!==true)fail('请确认原表为人民币／件，不能仅切换币种标签');
 if(!Object.hasOwn(COST_BASIS,p.basis)||!validDay(p.effectiveDate))fail('请填写费用范围及有效的成本生效日期');
 if(!clean(p.reason)||!clean(p.fileName)||!/^([a-f0-9]{64})$/.test(p.fileHash||''))fail('请提供文件、校验值和导入依据');
 if(!Array.isArray(p.rows)||!p.rows.length||p.rows.length>5000)fail('请选择1至5000条站点成本');
 const version=await clock(db),settings=await rows(db,'SELECT sku,name FROM sku_settings'),existing=await rows(db,'SELECT * FROM product_cost_versions ORDER BY version DESC');
 const latest=new Map();for(const r of existing)if(!latest.has(costKey(r)))latest.set(costKey(r),r);
 const counts=new Map();for(const r of p.rows){const k=r.site+'|'+skuCode(r.sku);counts.set(k,(counts.get(k)||0)+1);}
 const ready=[],issues=[],unchanged=[];
 for(const raw of p.rows){try{
  const r=normalizeCost(raw,settings);if(counts.get(r.site+'|'+skuCode(r.sku))>1)fail('同站点SKU重复，请核对后只保留一行');
  const source={sheet:clean(raw.source?.sheet,100),row:Number(raw.source?.row),fileName:clean(p.fileName),fileHash:p.fileHash,fields:{},warning:clean(raw.source?.warning,600)};if(!source.sheet||!Number.isSafeInteger(source.row)||source.row<1)fail('缺少原表行号');
  for(const field of ['purchase','freight','total']){const loc=raw.source?.fields?.[field];if(loc&&Number.isSafeInteger(Number(loc.row))&&Number(loc.row)>0)source.fields[field]={sheet:clean(loc.sheet,100),row:Number(loc.row)};}
  const prev=latest.get(costKey(r)),data={...r,currency:'CNY',basis:p.basis,effective_date:p.effectiveDate};
  if(prev&&Object.entries(data).every(([k,v])=>prev[k]===v)){unchanged.push({sku:r.sku,site:r.site,version:prev.version});continue;}
  ready.push({...data,version:(prev?.version||0)+1,source,previous:prev?publicCost(prev):null});
 }catch(e){issues.push({sku:skuCode(raw.sku),site:clean(raw.site),source:raw.source,message:e.message});}}
 const fingerprint=await hash(ready.map(r=>({sku:r.sku,site:r.site,purchase:r.purchase,freight:r.freight,total:r.total,currency:r.currency,basis:r.basis,effective_date:r.effective_date})).sort((a,b)=>costKey(a).localeCompare(costKey(b))));
 if(await clock(db)!==version)fail('成本已更新，请重新预览',409);
 return {version,fingerprint,ready,issues,unchanged,summary:{ready:ready.length,issues:issues.length,unchanged:unchanged.length}};
}
export async function mutateProductCosts(db,a,p){
 await productCostAccess(db,a,true);await assertWritable(db);
 if(p.action==='preview')return previewProductCosts(db,a,p);
 if(p.action==='rules'){
  if(a.role!=='管理员')fail('分类阈值仅管理员可修改',403);const r=validateRules(p.rules),version=await clock(db),current=(await db.prepare('SELECT MAX(version) version FROM product_class_rules').first()).version||0;
  if(p.version!==current)fail('分类规则已更新，请刷新',409);if(clean(p.reason).length<4)fail('请填写阈值调整依据');
  await atomicBatch(db,[actorGuard(db,a,version),db.prepare('INSERT INTO product_class_rules VALUES(?,?,?,?,?)').bind(current+1,JSON.stringify(r),clean(p.reason,1000),a.id,new Date().toISOString()),audit(db,a,String(current+1),'product-cost.rules',{rules:r,reason:clean(p.reason,1000)})]);return {ok:true};
 }
 if(p.action!=='commit')fail('不支持的商品成本动作');
 const v=await previewProductCosts(db,a,p);if(v.version!==p.version||v.fingerprint!==p.fingerprint)fail('成本预览过期，请重新核对',409);
 if(!v.ready.length)fail('没有新增或变化的有效成本，重复内容未写入',409);
 if(v.ready.length>900)fail('单次原子导入最多900条站点成本，请拆分文件；本次未写入');
 if(v.issues.length&&p.skipIssues!==true)fail('存在未匹配或异常行，请修正或明确确认只导入有效行');
 const id=crypto.randomUUID(),at=new Date().toISOString(),statements=[actorGuard(db,a,v.version)];
 statements.push(db.prepare('INSERT INTO product_cost_imports VALUES(?,?,?,?,?,?,?)').bind(id,v.fingerprint,clean(p.fileName),p.fileHash,at,a.id,JSON.stringify({summary:v.summary,issues:v.issues,reason:clean(p.reason,1000)})));
 for(const r of v.ready)statements.push(db.prepare('INSERT INTO product_cost_versions(id,sku,site,version,purchase,freight,total,currency,basis,effective_date,source_json,import_id,reason,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),r.sku,r.site,r.version,r.purchase,r.freight,r.total,r.currency,r.basis,r.effective_date,JSON.stringify(r.source),id,clean(p.reason,1000),a.id,a.name||'',at));
 statements.push(audit(db,a,id,'product-cost.import',{...v.summary,fileHash:p.fileHash,fingerprint:v.fingerprint}));
 try{await atomicBatch(db,statements);}catch(e){if(/UNIQUE/.test(String(e)))fail('内容已导入或版本变化，请刷新；未重复写入',409);throw e;}return {ok:true,id,...v.summary};
}
export async function readProductCosts(db,a,q={},now=new Date()){
 const permissions=await productCostAccess(db,a),version=await clock(db),sourceVersion=await salesClock(db);
 const isOps=a.role==='运营',args=isOps?[a.site,a.channel]:[],where=isOps?' AND site=? AND channel=?':'',supported="site IN ('印尼','马来西亚','菲律宾','泰国','越南') AND channel IN ('TikTok','Shopee')";
 const start=shiftDay(localDay(now,'印尼'),-28),end=shiftDay(localDay(now,'马来西亚'),-1);
 const [stocks,sales,imports,availability,observations,costs,rule,settings]=await Promise.all([
  rows(db,'SELECT * FROM inventory_balances WHERE '+supported+where,args),
  rows(db,'SELECT id,import_id,site,channel,sku,business_date,qty FROM sales_records WHERE reversed_at IS NULL AND '+supported+' AND business_date BETWEEN ? AND ?'+where,[start,end,...args]),
  rows(db,'SELECT id,site,channel,business_date,report_kind FROM sales_imports WHERE reversed_at IS NULL AND '+supported+' AND business_date BETWEEN ? AND ?'+where,[start,end,...args]),
  rows(db,'SELECT * FROM promotion_availability WHERE '+supported+where,args),
  rows(db,'SELECT * FROM promotion_stock_days WHERE '+supported+' AND day>=?'+where,[start,...args]),
  rows(db,'SELECT * FROM product_cost_versions'+(isOps?' WHERE site=?':'')+' ORDER BY effective_date DESC,version DESC',isOps?[a.site]:[]),
  db.prepare('SELECT * FROM product_class_rules ORDER BY version DESC LIMIT 1').first(),rows(db,'SELECT sku,name FROM sku_settings')]);
 const allowedSkus=new Set([...stocks,...sales].map(s=>s.sku)),visibleCosts=costs.filter(c=>!isOps||allowedSkus.has(c.sku));
 if(q.history){const history=visibleCosts.filter(c=>c.sku===q.history&&c.site===q.site).map(publicCost);return {history};}
 const current=new Map();for(const c of [...visibleCosts].sort(compareEffectiveCosts))if(c.effective_date<=localDay(now,c.site)&&!current.has(costKey(c)))current.set(costKey(c),publicCost(c));
 const rules=rule?JSON.parse(rule.data_json):DEFAULT_RULES,sm=group(sales,skuKey),ss=group(sales,scopeKey),im=group(imports,scopeKey),om=group(observations,skuKey),am=new Map(availability.map(r=>[skuKey(r),r])),names=new Map(settings.map(s=>[s.sku,s.name]));
 const completeness=new Map();for(const [k,rs] of im)completeness.set(k,completeSalesDates(rs,ss.get(k)||[]));
 const stockMap=new Map(stocks.map(s=>[skuKey(s),s]));for(const s of sales)if(!stockMap.has(skuKey(s)))stockMap.set(skuKey(s),{...s,qty:null,reserved_qty:0});
 const items=[...stockMap.values()].map(stock=>{const cost=current.get(costKey(stock))||null,performance=classifyProduct({stock,sales:sm.get(skuKey(stock))||[],completeDates:completeness.get(scopeKey(stock))||[],availability:am.get(skuKey(stock)),observations:om.get(skuKey(stock))||[]},rules,now);
  const stockCost=cost?.unit!=null&&performance.available!=null?cost.unit*performance.available:null;
  return {sku:stock.sku,site:stock.site,channel:stock.channel,name:names.get(stock.sku)||stock.name||'',cost,performance,stockCost:Number.isSafeInteger(stockCost)?stockCost:null};
 });
 // Master SKUs without any stock or sales scope remain visible to global readers, not invented as zero stock.
 if(!isOps){const represented=new Set(items.map(r=>r.sku));for(const setting of settings)if(!represented.has(setting.sku))items.push({sku:setting.sku,name:setting.name||'',site:'未关联站点',channel:'未关联平台',cost:null,stockCost:null,performance:{category:null,label:'待核实／观察',start,cutoff:end,qty28:null,qty7:null,previous7:null,daily28:null,daily7:null,cover:null,available:null,age:null,missing:[],reasons:['主数据已建档，尚无站点平台库存或近期销售；请核实商品经营范围'],trend:null,zeroDays:0}});}
 if(await clock(db)!==version||await salesClock(db)!==sourceVersion)fail('数据已变化，请刷新',409);
 return {actor:{id:a.id,role:a.role,site:a.site,channel:a.channel},...permissions,items,costs:[...current.values()],scheduled:visibleCosts.filter(c=>c.effective_date>localDay(now,c.site)).map(publicCost),rules,ruleVersion:rule?.version||0,generatedAt:now.toISOString(),version};
}
