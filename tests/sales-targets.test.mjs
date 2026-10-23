import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {systemFixture,svc,race} from './system-fixture.mjs';
import {readSalesTargets,saveSalesTarget,salesTargetHistory} from '../lib/sales-targets.mjs';
import {monthWindow} from '../lib/sales-target-model.mjs';
import {navigationForRole} from '../lib/permissions.mjs';
import {createBackup,restoreBackup} from '../server/backup.mjs';
import {openDatabase,fileBucket} from '../server/storage.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readSalesDashboard} from '../lib/sales-dashboard.mjs';
import {convertSalesSummary} from '../lib/sales-fx.mjs';
const fx={status:'fresh',rates:{CNY:1,IDR:2000,MYR:.6,THB:5,PHP:8,VND:3500},effectiveAt:'2026-10-03T00:00:00Z'},opts={fx,now:new Date('2026-10-03T04:00:00Z')};
const read=(f,a=f.users.admin,month='2026-10',options=opts)=>readSalesTargets(f.db,a,month,options);
const target=(f,more={})=>({month:'2026-10',site:'印尼',channel:'TikTok',ownerId:f.users.indonesia.id,revenueCny:1000,quantity:100,budgetCny:100,note:'每周核对转化',reason:'本月经营目标',version:0,...more});
function report(f,date='2026-10-01',more={}){
 const r={site:'印尼',channel:'TikTok',currency:'IDR',sku:'BAG-A',qty:2,revenue:200000,cost:20000,kind:'complete',...more},id=crypto.randomUUID();
 f.sqlite.prepare('INSERT INTO sales_imports(id,import_key,business_date,site,channel,row_count,total_qty,actor_id,created_at,report_kind) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,id,date,r.site,r.channel,1,r.qty,f.users.indonesia.id,date,r.kind);
 if(!r.zero)f.sqlite.prepare('INSERT INTO sales_records(id,import_id,business_date,site,channel,sku,qty,currency,reported_amount,ad_cost,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,id,date,r.site,r.channel,r.sku,r.qty,r.currency,r.revenue,r.cost,f.users.indonesia.id,date);
 return id;
}
function spend(f,date,amount=10000,currency='IDR'){f.sqlite.prepare('INSERT INTO sales_ad_spend(id,business_date,site,channel,currency,amount,note,actor_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(crypto.randomUUID(),date,'印尼','TikTok',currency,amount,'店铺总费用',f.users.indonesia.id,date);}
test('管理员分配月度任务；同月同站平台唯一，调整保留历史与独立审计',async()=>{const f=fixture();try{
 const p=target(f),s=await saveSalesTarget(f.db,f.users.admin,p),r=(await read(f)).rows.find(r=>r.key==='印尼|TikTok');assert.equal(r.target.revenue_cny,1000);assert.equal(r.ownerName,'印尼运营');
 await assert.rejects(saveSalesTarget(f.db,f.users.admin,p),e=>e.status===409);
 await saveSalesTarget(f.db,f.users.admin,{...p,version:1,revenueCny:2000,reason:'补充调整本月销售目标'});
 const h=await salesTargetHistory(f.db,f.users.finance,s.id);assert.equal(h.length,2);assert.equal(h[0].before.revenue_cny,1000);assert.equal(h[0].after.revenue_cny,2000);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE entity_type='sales_monthly_target'").get().n,2);
 }finally{f.sqlite.close();}});
test('财务和运营只能看授权范围；工厂供应链等不能取得销售目标、预算及个人贡献',async()=>{const f=fixture();try{
 const s=await saveSalesTarget(f.db,f.users.admin,target(f));for(const role of ['工厂','供应链','海运','销售','新品开发']){await assert.rejects(read(f,{id:'x',role}),e=>e.status===403);assert.equal(navigationForRole(role).includes('sales-targets'),false);}
 for(const a of [f.users.finance,f.users.indonesia,{id:'lead',role:'运营主管'}])await assert.rejects(saveSalesTarget(f.db,a,target(f)),e=>e.status===403);
 const r=await read(f,f.users.malaysia);assert.equal(r.rows.length,1);assert.equal(r.rows[0].site,'马来西亚');assert.equal(r.users.length,0);assert.ok(!JSON.stringify(r).includes('印尼运营'));
 await assert.rejects(salesTargetHistory(f.db,f.users.malaysia,s.id),e=>e.status===404);
 }finally{f.sqlite.close();}});
test('负责人限定同站点平台有效运营，金额空白/非法与非整数销量不保存',async()=>{const f=fixture();try{
 for(const more of [{ownerId:f.users.malaysia.id},{ownerId:f.users.finance.id},{revenueCny:''},{budgetCny:-1},{budgetCny:'2.001'},{quantity:1.1},{month:'2026-99'},{channel:'线下分销'},{reason:''}])await assert.rejects(saveSalesTarget(f.db,f.users.admin,target(f,more)),e=>e.status===400);
 f.sqlite.prepare('UPDATE users SET active=0 WHERE id=?').run(f.users.indonesia.id);await assert.rejects(saveSalesTarget(f.db,f.users.admin,target(f)),/有效运营/);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM sales_monthly_targets').get().n,0);
 }finally{f.sqlite.close();}});
test('五站十任务不分配不虚构负责人，未知销售和成本不是零，未来月份不生成完成率',async()=>{const f=fixture();try{
 const r=await read(f);assert.equal(r.rows.length,10);assert.equal(r.total.assigned,0);assert.equal(r.total.revenueCny,null);assert.equal(r.total.adCostCny,null);assert.equal(r.total.achievement,null);assert.equal(r.people.length,1);assert.equal(r.people[0].id,'unassigned');
 assert.equal((await read(f,f.users.admin,'2026-11')).total.qty,null);
 }finally{f.sqlite.close();}});
test('销售和消耗按原币折算；店铺费用覆盖SKU成本不叠加；任务完成率和ROAS可追溯',async()=>{const f=fixture();try{
 report(f);report(f,'2026-10-02');spend(f,'2026-10-01',10000);spend(f,'2026-10-02',20000);
 await saveSalesTarget(f.db,f.users.admin,target(f));const r=await read(f),s=r.rows.find(r=>r.key==='印尼|TikTok');
 assert.equal(s.revenueCny,200);assert.equal(s.adCostCny,15);assert.equal(s.qty,4);assert.equal(s.achievement,.2);assert.equal(s.budgetUse,.15);assert.equal(s.roas,200/15);assert.equal(s.completeDays,2);assert.equal(s.original[0].adCost,30000);assert.equal(s.original[0].revenue,400000);
 }finally{f.sqlite.close();}});
test('完整零销量日报为零收入；没有广告费用证明仍为待核实；广告零必须显式登记',async()=>{const f=fixture();try{
 report(f,'2026-10-01',{zero:true,kind:'zero',qty:0});report(f,'2026-10-02',{zero:true,kind:'zero',qty:0});let s=(await read(f,f.users.indonesia)).rows[0];assert.equal(s.revenueCny,0);assert.equal(s.qty,0);assert.equal(s.revenueComplete,true);assert.equal(s.adCostCny,null);assert.equal(s.costComplete,false);
 spend(f,'2026-10-01',0);spend(f,'2026-10-02',0);s=(await read(f,f.users.indonesia)).rows[0];assert.equal(s.adCostCny,0);assert.equal(s.costComplete,true);assert.equal(s.roas,null);
 }finally{f.sqlite.close();}});
test('漏报、部分导入、缺失金额、疑似重复整店成本和缺失汇率不生成完整ROAS',async()=>{const f=fixture();try{
 report(f,'2026-10-01',{kind:'partial'});let s=(await read(f,f.users.indonesia)).rows[0];assert.equal(s.completeDays,0);assert.equal(s.revenueCny,100);assert.equal(s.revenueComplete,false);assert.equal(s.roas,null);
 report(f,'2026-10-02',{revenue:null,cost:null});s=(await read(f,f.users.indonesia)).rows[0];assert.ok(s.revenueMissing>0);assert.ok(s.costMissing>0);
 const missing=(await read(f,f.users.indonesia,'2026-10',{...opts,fx:{rates:{CNY:1}}})).rows[0];assert.equal(missing.revenueCny,null);assert.ok(missing.unconverted>0);
 }finally{f.sqlite.close();}});
test('重复广告费提示待核实，整店总额登记后消除重复与费用归属疑点',async()=>{const f=fixture();try{
 for(const sku of ['A','B','C'])report(f,'2026-10-01',{sku});report(f,'2026-10-02');let r=(await read(f,f.users.indonesia)).rows[0];assert.equal(r.repeatedDays,1);assert.equal(r.roas,null);
 spend(f,'2026-10-01',20000);r=(await read(f,f.users.indonesia)).rows[0];assert.equal(r.repeatedDays,0);assert.equal(r.adCostCny,20);assert.equal(r.roas,20);
 }finally{f.sqlite.close();}});
test('撤销、当日未完结及跨月销售排除；独立广告未出单仍计入实际消耗',async()=>{const f=fixture();try{
 const id=report(f);f.sqlite.prepare('UPDATE sales_records SET reversed_at=? WHERE id=?').run('reversed',id);f.sqlite.prepare('UPDATE sales_imports SET reversed_at=? WHERE id=?').run('reversed',id);
 report(f,'2026-09-30');report(f,'2026-10-03');spend(f,'2026-10-02',40000);const r=(await read(f,f.users.indonesia)).rows[0];assert.equal(r.qty,null);assert.equal(r.revenueCny,null);assert.equal(r.adCostCny,20);assert.equal(r.roas,null);
 }finally{f.sqlite.close();}});
test('个人按月度负责人归属而非上传人；未分配站点实际额不抬高已分配目标完成率',async()=>{const f=fixture();try{
 report(f);report(f,'2026-10-01',{site:'马来西亚',currency:'MYR',revenue:600,cost:60});await saveSalesTarget(f.db,f.users.admin,target(f));const r=await read(f);
 assert.equal(r.total.revenueCny,1100);assert.equal(r.total.achievement,.1);assert.equal(r.people.find(p=>p.id==='id-ops').revenueCny,100);assert.equal(r.people.find(p=>p.id==='unassigned').revenueCny,1000);assert.equal(r.rows.find(r=>r.site==='印尼'&&r.channel==='TikTok').revenueShare,100/1100);
 }finally{f.sqlite.close();}});
test('库存份额含待上架及隔离；预留不重复增加；负库存不会抵消其他站点实际占用',async()=>{const f=fixture();try{
 f.sqlite.prepare('DELETE FROM inventory_balances').run();f.stock('BAG-A',10,20);f.sqlite.prepare("UPDATE inventory_balances SET reserved_qty=3,pending_shelf_qty=4,quarantine_qty=2 WHERE channel='TikTok'").run();f.stock('BAG-B',-5,0);const r=await read(f);assert.equal(r.total.held,36);assert.equal(r.total.available,27);assert.equal(r.total.reserved,3);assert.equal(r.total.inventoryAnomalies,1);assert.equal(r.rows.find(r=>r.key==='印尼|TikTok').inventoryShare,16/36);
 }finally{f.sqlite.close();}});
test('跨时区月末和闰年只包含已结束自然日',()=>{
 const at=new Date('2028-03-01T00:00:00Z');assert.equal(monthWindow('2028-02','印尼',at).expectedDays,29);
 const edge=new Date('2026-10-02T16:30:00Z');assert.equal(monthWindow('2026-10','印尼',edge).to,'2026-10-01');assert.equal(monthWindow('2026-10','菲律宾',edge).to,'2026-10-02');
});
test('同站多币种逐项折算到分后合计，与既有人民币销售看板完全对账',async()=>{const f=fixture();try{
 report(f,'2026-10-01',{revenue:10,cost:10});report(f,'2026-10-01',{currency:'PHP',revenue:.04,cost:.04,sku:'BAG-B'});
 const row=(await read(f,f.users.indonesia)).rows[0],base=convertSalesSummary(await readSalesDashboard(f.db,f.users.indonesia,{from:'2026-10-01',to:'2026-10-02'},'2026-10-03'),fx).total;
 assert.equal(row.revenueCny,.02);assert.equal(row.revenueCny,base.revenueCny);assert.equal(row.adCostCny,base.adCostCny);
 }finally{f.sqlite.close();}});
test('任务和调整历史完整备份后可恢复，且不改变现有销售和库存',async()=>{const f=fixture(),root=mkdtempSync(join(tmpdir(),'targets-backup-'));try{
 report(f);const before=f.sqlite.prepare('SELECT * FROM inventory_balances').all();const saved=await saveSalesTarget(f.db,f.users.admin,target(f));await saveSalesTarget(f.db,f.users.admin,target(f,{version:1,budgetCny:200,reason:'测试预算变更留痕'}));
 const path=join(root,'backup.tar');await createBackup({DB:f.db,WHOLESALE_FILES:fileBucket(join(root,'files'))},path);await restoreBackup(path,join(root,'restored'));
 const db=openDatabase(join(root,'restored/business.sqlite'));try{assert.equal(db.sqlite.prepare('SELECT budget_cny FROM sales_monthly_targets WHERE id=?').get(saved.id).budget_cny,200);assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM sales_target_events').get().n,2);assert.deepEqual(db.sqlite.prepare('SELECT * FROM inventory_balances').all(),before);assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM sales_records').get().n,1);}finally{db.sqlite.close();}
 }finally{f.sqlite.close();rmSync(root,{recursive:true,force:true});}});
test('并发中负责人被停用时整笔分配回滚，不留下孤立任务和审计',async()=>{const f=fixture();try{
 const results=await race(f,()=>saveSalesTarget(f.db,f.users.admin,target(f)),async()=>f.sqlite.prepare('UPDATE users SET active=0 WHERE id=?').run(f.users.indonesia.id));assert.equal(results[0].ok,false);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM sales_monthly_targets').get().n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM sales_target_events').get().n,0);
 }finally{f.sqlite.close();}});
test('并发分配与维护锁保证任务、历史和审计原子提交',async()=>{const f=fixture();try{
 const p=target(f),r=await race(f,()=>saveSalesTarget(f.db,f.users.admin,p),()=>saveSalesTarget(f.db,f.users.admin,p));assert.equal(r.filter(r=>r.ok).length,1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM sales_target_events').get().n,1);
 f.sqlite.prepare("INSERT INTO system_maintenance(id,mode,expires_at,updated_at) VALUES('global','backup','2099-01-01','2026-10-01') ON CONFLICT(id) DO UPDATE SET mode='backup',expires_at='2099-01-01'").run();await assert.rejects(saveSalesTarget(f.db,f.users.admin,{...p,version:1}),e=>e.status===409);
 }finally{f.sqlite.close();}});
test('新增工作区走独立API，工厂无法透过系统模块获得任务',async()=>{const f=systemFixture();try{
 svc.setActor(f.users.admin);const r=await svc.GET(new Request('http://localhost/api/system?module=sales-targets'));assert.equal(r.status,200);assert.equal((await r.json()).module,'sales-targets');
 svc.setActor({id:'factory',role:'工厂'});assert.equal((await svc.GET(new Request('http://localhost/api/system?module=sales-targets'))).status,403);
 }finally{f.sqlite.close();}});
