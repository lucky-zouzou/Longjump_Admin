import test from 'node:test';
import assert from 'node:assert/strict';
import {classifySiteProducts,siteRuleSet,validateSiteRules,SITE_RULE_DEFAULTS} from '../lib/site-product-classification.mjs';
import {readProductCosts,mutateProductCosts} from '../lib/product-costs.mjs';
import {fixture} from './fixtures.mjs';
import {shiftDay} from '../lib/promotion-model.mjs';
import {validateRules,DEFAULT_RULES} from '../lib/product-cost-model.mjs';
const now=new Date('2026-11-02T07:00:00Z'),cutoff='2026-11-01',days=Array.from({length:28},(_,i)=>shiftDay(cutoff,i-27));
function sample(site='印尼',daily=10){
 const stocks=[],sales=[],imports=[],availability=[];
 for(const channel of ['TikTok','Shopee']){
  const scope={site,channel,sku:'BAG-A'};stocks.push({...scope,qty:100,reserved_qty:10});availability.push({...scope,listed_since:'2026-09-01',available_since:'2026-09-01',verified_through:cutoff});
  for(const date of days){const id=site+channel+date;imports.push({...scope,id,business_date:date,report_kind:'complete'});sales.push({...scope,id:'s'+id,import_id:id,business_date:date,qty:daily});}
 }
 return {stocks,sales,imports,availability,observations:[]};
}
const result=(input,rules=siteRuleSet(),at=now)=>classifySiteProducts(input,rules,at)[0].performance;
test('五国使用独立参数，同一SKU合并双平台销量、预留和可售，不产生两条分类',()=>{
 const all={stocks:[],sales:[],imports:[],availability:[]};for(const site of Object.keys(SITE_RULE_DEFAULTS)){const s=sample(site,3);for(const k of Object.keys(all))all[k].push(...s[k]);}
 const rows=classifySiteProducts(all,siteRuleSet(),now);assert.equal(rows.length,5);
 const map=Object.fromEntries(rows.map(r=>[r.site,r.performance]));assert.equal(map.印尼.category,'hot');assert.equal(map.泰国.category,'hot');assert.equal(map.马来西亚.category,'hero');assert.equal(map.菲律宾.category,'hero');assert.equal(map.越南.category,'hero');
 for(const r of rows){assert.equal(r.performance.qty28,168);assert.equal(r.performance.qty7,42);assert.equal(r.performance.available,180);assert.equal(r.performance.daily28,6);assert.equal(r.performance.missing.length,0);}
});
test('7天与28天独立分级，持续爆款、近期起量和放缓有清晰区别',()=>{
 const s=sample('印尼',0);s.sales.forEach(r=>r.qty=r.business_date>=days[21]?10:0);let p=result(s);assert.equal(p.period7.category,'hero');assert.equal(p.period28.category,'hot');assert.equal(p.category,'hot');assert.equal(p.momentum,'近期起量');
 s.sales.forEach(r=>r.qty=r.business_date>=days[21]?0:14);p=result(s);assert.equal(p.period28.category,'hero');assert.equal(p.period7.category,'steady');assert.equal(p.category,'slow');assert.equal(p.momentum,'近期放缓');
 s.sales.forEach(r=>r.qty=r.business_date>=days[21]?1:14);p=result(s);assert.equal(p.category,'hero');assert.equal(p.period7.category,'steady');
 assert.equal(result(sample()).momentum,'持续爆款');
});
test('任何平台缺报或部分日报都不计零，只有28天缺报时7天仍可单独成立',()=>{
 const s=sample();s.imports.find(r=>r.channel==='Shopee'&&r.business_date===days[0]).report_kind='partial';let p=result(s);assert.equal(p.category,null);assert.equal(p.daily28,null);assert.equal(p.period28.category,null);assert.equal(p.period28.candidate,'hero');assert.equal(p.period7.category,'hero');assert.deepEqual(p.missing,[days[0]]);
 s.imports=s.imports.filter(r=>r.channel!=='Shopee'||r.business_date!==cutoff);p=result(s);assert.equal(p.period7.category,null);assert.deepEqual(p.period7.missing,[cutoff]);assert.equal(p.missingByChannel.find(r=>r.channel==='TikTok').missing.length,0);
});
test('跨平台正常同SKU不误报重叠，同平台重叠批次暂停本站分类',()=>{
 const s=sample();assert.equal(result(s).category,'hero');s.sales.push({...s.sales[0],id:'overlap',import_id:'different'});assert.equal(result(s).category,null);assert.deepEqual(result(s).missing,[days[0]]);
});
test('库存不明、负数、预留超限不被另一平台抵消或默认为零',()=>{
 for(const change of [s=>s.stocks.pop(),s=>s.stocks[0].qty=-1,s=>s.stocks[0].reserved_qty=101]){const s=sample();change(s);const p=result(s);assert.equal(p.available,null);assert.equal(p.cover,null);assert.equal(p.category,null);assert.equal(p.period28.category,'hero');}
});
test('站点连续有货须有证据；一平台有货即可，两个平台都无证据不可判滞销',()=>{
 const s=sample('印尼',0);s.availability.pop();assert.equal(result(s).category,'slow');s.observations=days.slice(-7).map(day=>({site:'印尼',channel:'TikTok',sku:'BAG-A',day,min_available:0}));assert.equal(result(s).category,null);
 s.availability=[];assert.equal(result(s).age,null);assert.equal(result(s).category,null);
});
test('同一时刻不同国家按当地昨日截止，销量不串到今天',()=>{
 const at=new Date('2026-11-01T16:30:00Z');assert.equal(result(sample('印尼'),siteRuleSet(),at).cutoff,'2026-10-31');assert.equal(result(sample('菲律宾'),siteRuleSet(),at).cutoff,'2026-11-01');
});
test('旧全局规则留痕，读取使用新站点初始参数；7天阈值可独立高于28天',()=>{
 const old={heroDaily:100,hotDaily:50,heroRecentDaily:70,slowDaily:.5,slowCover:90,minAge:28};assert.equal(siteRuleSet(old).印尼.heroDaily,18);
 assert.equal(validateSiteRules({...SITE_RULE_DEFAULTS.印尼,heroRecentDaily:30}).heroRecentDaily,30);
 for(const rules of [{...SITE_RULE_DEFAULTS.印尼,hotRecentDaily:18},{...SITE_RULE_DEFAULTS.印尼,minAge:7},{...SITE_RULE_DEFAULTS.印尼,hotDaily:''}])assert.throws(()=>validateSiteRules(rules));
});
test('保存仅影响所选站点；缺站点、非管理员和旧版本拒绝，历史版本可追溯',async()=>{
 const f=fixture();try{
  const before=f.sqlite.prepare('SELECT * FROM inventory_balances').all();const p={action:'rules',site:'印尼',rules:{...SITE_RULE_DEFAULTS.印尼,heroDaily:20},reason:'按本月本站销量复核',version:0};
  await assert.rejects(mutateProductCosts(f.db,f.users.finance,p),e=>e.status===403);await assert.rejects(mutateProductCosts(f.db,f.users.admin,{...p,site:undefined}),/站点/);
  await mutateProductCosts(f.db,f.users.admin,p);await assert.rejects(mutateProductCosts(f.db,f.users.admin,{...p,site:'泰国'}),e=>e.status===409);
  await mutateProductCosts(f.db,f.users.admin,{...p,site:'泰国',rules:{...SITE_RULE_DEFAULTS.泰国,heroDaily:8},version:1});
  const data=await readProductCosts(f.db,f.users.admin,{},now);assert.equal(data.rulesBySite.印尼.heroDaily,20);assert.equal(data.rulesBySite.泰国.heroDaily,8);assert.equal(data.rulesBySite.越南.heroDaily,3);assert.deepEqual(data.reviewedSites,['印尼','泰国']);assert.equal(data.ruleVersion,2);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM product_class_rules').get().n,2);assert.deepEqual(f.sqlite.prepare('SELECT * FROM inventory_balances').all(),before);
  const stored=JSON.parse(f.sqlite.prepare('SELECT data_json FROM product_class_rules ORDER BY version DESC LIMIT 1').get().data_json);assert.deepEqual(validateRules(stored),DEFAULT_RULES);
  const audit=f.sqlite.prepare("SELECT detail_json FROM audit_logs WHERE action='product-cost.rules' ORDER BY rowid DESC LIMIT 1").get();assert.equal(JSON.parse(audit.detail_json).site,'泰国');
 }finally{f.sqlite.close();}
});
test('运营只见自己已有SKU的本站汇总，未获授权SKU及其他国家不返回，原始金额不暴露',async()=>{
 const f=fixture();try{
  f.sqlite.prepare("INSERT INTO inventory_balances(site,channel,sku,qty,updated_at) VALUES('印尼','Shopee','PRIVATE-SKU',10,'2026-11-01')").run();
  const admin=await readProductCosts(f.db,f.users.admin,{},now),ops=await readProductCosts(f.db,f.users.indonesia,{},now);
  assert.equal(ops.items.length,2);assert.equal(ops.items.find(r=>r.sku==='BAG-A').performance.available,20);assert.equal(admin.items.find(r=>r.sku==='BAG-A'&&r.site==='印尼').performance.available,20);assert.equal(ops.classificationScope,'site');
  assert(!JSON.stringify(ops).includes('马来西亚'));assert(!JSON.stringify(ops).includes('PRIVATE-SKU'));assert.deepEqual(Object.keys(ops.rulesBySite),['印尼']);assert(!Object.hasOwn(ops,'sales'));
 }finally{f.sqlite.close();}
});
