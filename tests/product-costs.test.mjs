import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {classifyProduct,DEFAULT_RULES,parseProductCostSheet,mergeProductCostSheets,validateRules} from '../lib/product-cost-model.mjs';
import {previewProductCosts,mutateProductCosts,readProductCosts} from '../lib/product-costs.mjs';
import {shiftDay} from '../lib/promotion-model.mjs';
const now=new Date('2026-11-05T05:00:00Z');
const payload=(rows=[{sku:'bag-a',site:'印尼',purchase:20,freight:2.3863,total:22.39,source:{sheet:'Sheet2',row:3}}])=>({rows,currency:'CNY',currencyConfirmed:true,basis:'unconfirmed',effectiveDate:'2026-10-28',fileName:'TEST-ONLY-cost.xlsx',fileHash:'a'.repeat(64),reason:'测试核对成本表'});
async function commit(f,p=payload(),actor=f.users.admin){const v=await previewProductCosts(f.db,actor,p);return mutateProductCosts(f.db,actor,{...p,action:'commit',version:v.version,fingerprint:v.fingerprint});}
async function scenario(fn){const f=fixture();try{await fn(f);}finally{f.sqlite.close();}}
test('原表按表头定位；Sheet2优先，Sheet1仅补缺失并保留字段来源，无表头不猜测',()=>{
 const header=['序号','*商品编码SKU','商品采购成本','印尼海运费用','印尼综合成本'];
 const a=parseProductCostSheet([['标题'],header,[1,'bag-a',20,null,23]],'Sheet2'),b=parseProductCostSheet([header,[1,'BAG-A',99,3,102],[2,'BAG-B',10,1,11]],'Sheet1');
 const merged=mergeProductCostSheets(a,b);assert.equal(merged.length,2);assert.equal(merged[0].purchase,20);assert.equal(merged[0].total,23);assert.equal(merged[0].freight,3);assert.equal(merged[0].source.fields.freight.sheet,'Sheet1');assert.equal(merged[0].source.fields.total.sheet,'Sheet2');assert.throws(()=>parseProductCostSheet([['BAG-A',20,3,23]],'Sheet3'),/表头/);assert.throws(()=>mergeProductCostSheets([...a,...a],[]),/重复/);
 const conflict=mergeProductCostSheets(a,[{...b[0],freight:9}])[0];assert.equal(conflict.freight,null);assert.equal(conflict.total,23);assert.match(conflict.source.warning,/未补入/);
});
test('成本空白非零，差异和未知SKU逐行预警；未经确认不跳过异常',()=>scenario(async f=>{
 const p=payload([{sku:'BAG-A',site:'印尼',purchase:null,freight:null,total:22,source:{sheet:'S',row:3}},{sku:'BAG-B',site:'印尼',purchase:20,freight:2,total:25,source:{sheet:'S',row:4}},{sku:'TYPO',site:'印尼',total:9,source:{sheet:'S',row:5}}]);
 const v=await previewProductCosts(f.db,f.users.admin,p);assert.equal(v.ready.length,1);assert.equal(v.issues.length,2);assert.equal(v.ready[0].purchase,null);
 await assert.rejects(mutateProductCosts(f.db,f.users.admin,{...p,...v,action:'commit'}),/异常|未匹配/);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM product_cost_versions').get().n,0);
 await mutateProductCosts(f.db,f.users.admin,{...p,...v,action:'commit',skipIssues:true});const d=await readProductCosts(f.db,f.users.finance,{},now);assert.equal(d.costs[0].unit,220000);assert.equal(d.costs[0].basis,'unconfirmed');
}));
test('导入原子留痕，改文件名不重复；修订保留旧成本，库存和销售不变',()=>scenario(async f=>{
 const before=f.sqlite.prepare('SELECT * FROM inventory_balances').all();await commit(f);const first=(await readProductCosts(f.db,f.users.admin,{},now)).costs[0];assert.equal(first.freight,23863);assert.equal(first.version,1);
 await assert.rejects(commit(f,{...payload(),fileName:'renamed.xlsx',fileHash:'b'.repeat(64)}),/重复|没有新增/);
 const p=payload([{sku:'BAG-A',site:'印尼',purchase:21,freight:2,total:23,source:{sheet:'Sheet2',row:3}}]);await commit(f,p,f.users.finance);
 const d=await readProductCosts(f.db,f.users.indonesia,{},now);assert.equal(d.costs[0].version,2);assert.equal(d.costs[0].unit,230000);assert.equal((await readProductCosts(f.db,f.users.admin,{history:'BAG-A',site:'印尼'},now)).history.length,2);assert.deepEqual(f.sqlite.prepare('SELECT * FROM inventory_balances').all(),before);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM sales_records').get().n,0);assert.throws(()=>f.sqlite.exec("UPDATE product_cost_versions SET total=0"),/immutable/);
}));
test('财务运营可读，运营只能看本站已有SKU；工厂线下销售供应链无成本访问，不能越权写入',()=>scenario(async f=>{
 await commit(f,payload([{sku:'BAG-A',site:'印尼',total:21,source:{sheet:'S',row:3}},{sku:'BAG-A',site:'马来西亚',total:99,source:{sheet:'S',row:4}}]));
 assert.equal((await readProductCosts(f.db,f.users.finance,{},now)).costs.length,2);const ops=await readProductCosts(f.db,f.users.indonesia,{},now);assert.equal(ops.costs.length,1);assert.equal(ops.costs[0].site,'印尼');assert(!JSON.stringify(ops).includes('马来西亚'));assert.equal((await readProductCosts(f.db,f.users.indonesia,{history:'BAG-A',site:'马来西亚'},now)).history.length,0);
 for(const actor of [f.users.sales,f.users.supply,{...f.users.admin,role:'工厂'}])await assert.rejects(readProductCosts(f.db,actor,{},now),e=>e.status===403);
 await assert.rejects(previewProductCosts(f.db,f.users.indonesia,payload()),e=>e.status===403);f.sqlite.prepare("UPDATE users SET active=0 WHERE id=?").run(f.users.finance.id);await assert.rejects(readProductCosts(f.db,f.users.finance,{},now),e=>e.status===403);
}));
test('预览变更与并发不覆盖，生效日前不提前替换，维护锁拒绝写入',()=>scenario(async f=>{
 const p=payload(),stale=await previewProductCosts(f.db,f.users.admin,p);await commit(f);await assert.rejects(mutateProductCosts(f.db,f.users.admin,{...p,...stale,action:'commit'}),e=>e.status===409);
 await commit(f,{...payload([{sku:'BAG-A',site:'印尼',total:30,source:{sheet:'S',row:4}}]),effectiveDate:'2026-12-01'});const d=await readProductCosts(f.db,f.users.admin,{},now);assert.equal(d.costs[0].version,1);assert.equal(d.scheduled.length,1);
 f.sqlite.prepare("UPDATE system_maintenance SET mode='backup',expires_at='2999-01-01' WHERE id='global'").run();if(!f.sqlite.prepare("SELECT id FROM system_maintenance WHERE id='global'").get())f.sqlite.prepare("INSERT INTO system_maintenance(id,mode,token_hash,actor_id,expires_at,updated_at) VALUES('global','backup','t','admin-1','2999-01-01','2026-10-28')").run();
 await assert.rejects(commit(f,{...p,effectiveDate:'2026-11-01'}),/备份|迁移/);
}));
const sample=(daily=5)=>{const cutoff='2026-11-04',dates=Array.from({length:28},(_,i)=>shiftDay(cutoff,i-27));return {stock:{sku:'BAG-A',site:'印尼',channel:'TikTok',qty:500,reserved_qty:0},sales:dates.map((d,i)=>({business_date:d,sku:'BAG-A',qty:daily,import_id:'i'+i})),completeDates:dates,availability:{listed_since:'2026-09-01',available_since:'2026-09-01',verified_through:cutoff},observations:[]};};
test('四类阈值及边界、连续7天零销量与库存证据；销量不等于利润',()=>{
 for(const [daily,kind] of [[10,'hero'],[9.99,'hot'],[3,'hot'],[2.99,'steady'],[0,'slow']])assert.equal(classifyProduct(sample(daily),DEFAULT_RULES,now).category,kind);
 const declining=sample(10);declining.sales.slice(-7).forEach(s=>s.qty=1);assert.equal(classifyProduct(declining,DEFAULT_RULES,now).category,'hot');assert.equal(classifyProduct(declining,DEFAULT_RULES,now).trend,-.9);
 const slow=sample(0.4);assert.equal(classifyProduct(slow,DEFAULT_RULES,now).category,'slow');slow.stock.qty=1;assert.equal(classifyProduct(slow,DEFAULT_RULES,now).category,'steady');
});
test('缺报、缺货、新品不被伪判滞销；站点午夜边界正确',()=>{
 const s=sample(0);s.completeDates.pop();assert.equal(classifyProduct(s,DEFAULT_RULES,now).category,null);s.completeDates=sample().completeDates;s.availability=null;assert.equal(classifyProduct(s,DEFAULT_RULES,now).category,null);
 s.availability={...sample().availability,listed_since:'2026-11-01'};assert.equal(classifyProduct(s,DEFAULT_RULES,now).category,null);s.availability=sample().availability;s.observations=[{day:'2026-11-03',min_available:0}];assert.equal(classifyProduct(s,DEFAULT_RULES,now).category,null);s.observations=[];s.stock.qty=-1;assert.equal(classifyProduct(s,DEFAULT_RULES,now).category,null);
 const id=classifyProduct(sample(),DEFAULT_RULES,new Date('2026-11-05T16:30:00Z'));assert.equal(id.cutoff,'2026-11-04');assert.equal(classifyProduct({...sample(),stock:{...sample().stock,site:'菲律宾'}},DEFAULT_RULES,new Date('2026-11-05T16:30:00Z')).cutoff,'2026-11-05');
});
test('真实读取按日报完整度分类；部分日报和重叠批次暂停分类，撤销重叠后恢复',()=>scenario(async f=>{
 const s=sample(10);
 f.sqlite.prepare("INSERT INTO promotion_availability VALUES('印尼','TikTok','BAG-A','2026-09-01','2026-09-01','2026-11-04','TEST-ONLY','测试连续有货','id-ops','2026-11-04')").run();
 for(const d of s.completeDates){
  f.sqlite.prepare("INSERT INTO sales_imports(id,import_key,business_date,site,channel,row_count,total_qty,actor_id,created_at,report_kind) VALUES(?,?,?,'印尼','TikTok',1,10,'id-ops',?,'complete')").run('i-'+d,'k-'+d,d,d);
  f.sqlite.prepare("INSERT INTO sales_records(id,import_id,business_date,site,channel,sku,qty,currency,actor_id,created_at) VALUES(?,?,?,'印尼','TikTok','BAG-A',10,'IDR','id-ops',?)").run('s-'+d,'i-'+d,d,d);
 }
 const perf=async()=>(await readProductCosts(f.db,f.users.indonesia,{},now)).items.find(r=>r.sku==='BAG-A').performance;
 assert.equal((await perf()).category,'hero');
 f.sqlite.prepare("UPDATE sales_imports SET report_kind='partial' WHERE business_date='2026-11-04'").run();
 assert.equal((await perf()).category,null);assert.deepEqual((await perf()).missing,['2026-11-04']);
 f.sqlite.prepare("UPDATE sales_imports SET report_kind='complete' WHERE business_date='2026-11-04'").run();
 f.sqlite.exec('DROP TRIGGER sales_summary_overlap_insert'); // Simulate legacy rows created before the duplicate-import guard.
 f.sqlite.prepare("INSERT INTO sales_records(id,import_id,business_date,site,channel,sku,qty,currency,actor_id,created_at) VALUES('overlap','other','2026-11-04','印尼','TikTok','BAG-A',10,'IDR','id-ops','2026-11-04')").run();
 assert.equal((await perf()).category,null);assert.deepEqual((await perf()).missing,['2026-11-04']);
 f.sqlite.prepare("UPDATE sales_records SET reversed_at='2026-11-05' WHERE id='overlap'").run();
 assert.equal((await perf()).category,'hero');assert.equal((await perf()).qty28,280);
}));
test('规则修改仅管理员，版本冲突与无效阈值被拒绝',()=>scenario(async f=>{
 const p={action:'rules',version:0,rules:DEFAULT_RULES,reason:'测试规则确认'};await assert.rejects(mutateProductCosts(f.db,f.users.finance,p),e=>e.status===403);await mutateProductCosts(f.db,f.users.admin,p);await assert.rejects(mutateProductCosts(f.db,f.users.admin,p),e=>e.status===409);assert.throws(()=>validateRules({...DEFAULT_RULES,hotDaily:20}));assert.throws(()=>validateRules({...DEFAULT_RULES,minAge:7}));assert.equal((await readProductCosts(f.db,f.users.admin,{},now)).ruleVersion,1);
}));
test('商品成本及规则随完整备份恢复，时钟不产生初始行冲突',()=>scenario(async f=>{
 const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{createBackup,restoreBackup}=await import('../server/backup.mjs'),{fileBucket,openDatabase}=await import('../server/storage.mjs');const root=mkdtempSync(join(tmpdir(),'product-cost-backup-'));
 try{await commit(f);await mutateProductCosts(f.db,f.users.admin,{action:'rules',version:0,rules:DEFAULT_RULES,reason:'备份规则验证'});const path=join(root,'archive.tar');await createBackup({DB:f.db,WHOLESALE_FILES:fileBucket(join(root,'files'))},path);await restoreBackup(path,join(root,'restore'));const db=openDatabase(join(root,'restore/business.sqlite'));try{const d=await readProductCosts(db,f.users.admin,{},now);assert.equal(d.costs[0].total,223900);assert.equal(d.ruleVersion,1);}finally{db.sqlite.close();}}finally{rmSync(root,{recursive:true,force:true});}
}));

test('全局健康视图包含仅建档SKU且库存未知，运营不获得未授权商品',()=>scenario(async f=>{
 f.sqlite.prepare("INSERT INTO sku_settings(sku,name,updated_at) VALUES('MASTER-ONLY','仅建档商品','2026-10-30')").run();
 const admin=await readProductCosts(f.db,f.users.admin,{},now),r=admin.items.find(r=>r.sku==='MASTER-ONLY');
 assert.equal(r.performance.available,null);assert.equal(r.performance.qty28,null);assert.equal(r.performance.category,null);assert.match(r.performance.reasons[0],/尚无站点/);
 assert(!(await readProductCosts(f.db,f.users.indonesia,{},now)).items.some(r=>r.sku==='MASTER-ONLY'));
}));
