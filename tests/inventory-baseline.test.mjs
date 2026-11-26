import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture} from './fixtures.mjs';
import {fileBucket} from '../server/storage.mjs';
import {validateBaseline,previewBaseline,applyBaseline,undoBaseline,businessFingerprint} from '../server/inventory-baseline.mjs';
import {marketingSamplesFixture} from './marketing-samples-fixture.mjs';
import {mutateDomesticDistribution} from '../lib/domestic-distribution.mjs';
import {verifyArchive} from '../server/backup.mjs';

function input(){return {asOf:'2026-09-30',sha256:'a'.repeat(64),source:'test.xlsx',rows:Object.keys({'越南仓库':1,'印尼仓库':1,'菲律宾仓库':1,'马来仓库':1,'泰国仓库':1}).flatMap(sheet=>[{sheet,row:3,warehouse:'仓一',sku:'NEW-A',name:'新商品A',available:3,returnInTransit:2},{sheet,row:4,warehouse:'仓二',sku:'NEW-A',name:'新商品A',available:4,returnInTransit:0},{sheet,row:5,warehouse:'仓一',sku:'NEW-B',name:'新商品B',available:2,returnInTransit:0}])};}
async function setup(fn){const root=mkdtempSync(join(tmpdir(),'lj-baseline-')),prior=process.env.LOONGJUMP_BACKUP_DIR;process.env.LOONGJUMP_BACKUP_DIR=root;const f=fixture();f.db.sqlite=f.sqlite;const env={DB:f.db,WHOLESALE_FILES:fileBucket(join(root,'files'))};try{await fn(f,env,root);}finally{f.sqlite.close();if(prior===undefined)delete process.env.LOONGJUMP_BACKUP_DIR;else process.env.LOONGJUMP_BACKUP_DIR=prior;rmSync(root,{recursive:true,force:true});}}
// Existing pre-0073 orders had no modern workflow row; model that history explicitly.
async function legacyOrder(f){const id=await f.create();f.sqlite.prepare('DELETE FROM wholesale_workflows WHERE order_id=?').run(id);return id;}
test('期初分配：合并同站多仓，五站独立，奇数交替守恒，退货不计可售',()=>{const p=validateBaseline(input());assert.equal(p.total,45);assert.equal(p.balances.length,20);assert.ok(p.summary.every(r=>r.total===9&&r.skus===2&&Math.abs(r.TikTok-r.Shopee)===1&&r.returnInTransit===2));assert.equal(p.balances.reduce((s,r)=>s+r.qty,0),45);});
test('期初校验：缺站、重复源行、负数和非整数均拒绝',()=>{for(const modify of [p=>p.rows.pop()&&p.rows.splice(-2),p=>p.rows.push(p.rows[0]),p=>p.rows[0].available=-1,p=>p.rows[0].available=1.5]){const p=input();modify(p);assert.throws(()=>validateBaseline(p));}});
test('期初切换完整备份、线上线下清零、保留客户和审计、撤销恢复与防旧日期扣库',async()=>setup(async(f,env,root)=>{
 const id=await legacyOrder(f);await f.approve(id);await f.ship(id,2,'2026-09-20');
 await f.change(f.users.finance,id,'financeAdd',{kind:'receipt',amount:100000,reference:'BANK-BASE',businessDate:'2026-09-20',note:'期初前回款'});
 const d=f.sqlite;d.prepare("INSERT INTO sales_imports(id,import_key,business_date,site,channel,row_count,total_qty,actor_id,created_at) VALUES('old','old','2026-09-29','印尼','TikTok',1,3,'id-ops','2026-09-29')").run();
 d.prepare("INSERT INTO sales_records(id,import_id,business_date,site,channel,sku,qty,actor_id,created_at) VALUES('old','old','2026-09-29','印尼','TikTok','BAG-A',3,'id-ops','2026-09-29')").run();
 d.prepare("INSERT INTO inventory_count_requests(id,site,channel,sku,system_qty,counted_qty,reason,creator_id,created_at,updated_at) VALUES('count','印尼','TikTok','BAG-A',1,5,'旧盘点','id-ops','2026-09-29','2026-09-29')").run();
 const before=JSON.stringify(d.prepare('SELECT * FROM inventory_balances ORDER BY site,channel,sku').all()),customerCount=d.prepare('SELECT COUNT(*) n FROM wholesale_customers').get().n;
 const p=input(),preview=previewBaseline(d,p);assert.equal(preview.clearCounts.wholesale_orders,1);const result=await applyBaseline(env,f.users.admin,p,preview);
 assert.equal(d.prepare('SELECT SUM(qty) n FROM inventory_balances').get().n,45);assert.equal(d.prepare('SELECT SUM(reserved_qty) n FROM inventory_balances').get().n,0);
 for(const t of ['sales_imports','sales_records','wholesale_orders','wholesale_shipments','wholesale_finance_entries'])assert.equal(d.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n,0);
 assert.equal(d.prepare('SELECT COUNT(*) n FROM wholesale_customers').get().n,customerCount);assert.equal(d.prepare("SELECT status FROM inventory_count_requests WHERE id='count'").get().status,'rejected');
 assert.equal((await verifyArchive(join(root,'inventory-baselines',result.id+'.tar'))).format,'loongjump-backup-v1');
 assert.throws(()=>previewBaseline(d,p),/不可重复/);
 const insert=d.prepare("INSERT INTO sales_imports(id,import_key,business_date,site,channel,row_count,total_qty,actor_id,created_at) VALUES('new','new',?,'印尼','TikTok',1,1,'id-ops','now')");assert.throws(()=>insert.run('2026-09-30'),/inventory_baseline_date/);
 // A transaction proves the first official date works, without changing undo state.
 d.exec('BEGIN');insert.run('2026-10-01');d.exec('ROLLBACK');
 assert.equal(undoBaseline(env,f.users.admin,result.id).restored,true);
 assert.equal(JSON.stringify(d.prepare('SELECT * FROM inventory_balances ORDER BY site,channel,sku').all()),before);assert.equal(d.prepare('SELECT COUNT(*) n FROM wholesale_orders').get().n,1);
 assert.equal(d.prepare("SELECT status FROM inventory_count_requests WHERE id='count'").get().status,'pending');insert.run('2026-09-30');
 assert.throws(()=>d.exec('DELETE FROM inventory_movements'),/immutable/);assert.throws(()=>d.exec('DELETE FROM wholesale_finance_entries'),/immutable/);
}));
test('期初权限与过期预览不会修改数据，备份前拒绝10月新交易',async()=>setup(async(f,env)=>{const p=input(),expected=previewBaseline(f.sqlite,p),before=businessFingerprint(f.sqlite);await assert.rejects(applyBaseline(env,f.users.sales,p,expected),/仅管理员/);assert.equal(businessFingerprint(f.sqlite),before);f.sqlite.exec("UPDATE inventory_balances SET qty=qty+1");await assert.rejects(applyBaseline(env,f.users.admin,p,expected),/已变化/);f.sqlite.prepare("INSERT INTO sales_imports(id,import_key,business_date,site,channel,row_count,total_qty,actor_id,created_at) VALUES('future','future','2026-10-01','印尼','TikTok',1,1,'id-ops','now')").run();assert.throws(()=>previewBaseline(f.sqlite,p),/之后/);}));
test('备份证据丢失则终止，正式库存不变',async()=>setup(async(f,env)=>{const id=await legacyOrder(f);f.sqlite.prepare("INSERT INTO wholesale_files(id,order_id,object_key,name,content_type,size,actor_id,created_at) VALUES('missing',?,'missing','test.png','image/png',3,'supply-1','now')").run(id);const p=input(),expected=previewBaseline(f.sqlite,p);await assert.rejects(applyBaseline(env,f.users.admin,p,expected),/备份缺少/);assert.equal(businessFingerprint(f.sqlite),expected.fingerprint);}));
test('业务有新变化后拒绝撤销，不覆盖新数据',async()=>setup(async(f,env)=>{const p=input(),result=await applyBaseline(env,f.users.admin,p,previewBaseline(f.sqlite,p));f.sqlite.exec('UPDATE inventory_balances SET qty=qty-1');const before=businessFingerprint(f.sqlite);assert.throws(()=>undoBaseline(env,f.users.admin,result.id),/已有业务变化/);assert.equal(businessFingerprint(f.sqlite),before);}));
test('清零中途失败会回滚库存、销售和触发器',async()=>setup(async(f,env)=>{await legacyOrder(f);f.sqlite.exec("CREATE TRIGGER test_failure BEFORE DELETE ON inventory_balances BEGIN SELECT RAISE(ABORT,'intentional_failure'); END");const p=input(),expected=previewBaseline(f.sqlite,p);await assert.rejects(applyBaseline(env,f.users.admin,p,expected),/intentional_failure/);assert.equal(businessFingerprint(f.sqlite),expected.fingerprint);assert.ok(f.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='immutable_wholesale_finance_entries_delete'").get());}));

test('新版分销工作流阻止旧期初清零，拒绝发生在备份前且保留原单与审计',async()=>setup(async(f,env,root)=>{
 const p=input(),expected=previewBaseline(f.sqlite,p),id=await f.create(),before=businessFingerprint(f.sqlite);
 assert.throws(()=>previewBaseline(f.sqlite,p),/新版印尼线下流程.*拒绝清零/);await assert.rejects(applyBaseline(env,f.users.admin,p,expected),/新版印尼线下流程/);assert.equal(businessFingerprint(f.sqlite),before);assert.equal(f.orderRow(id).id,id);assert.equal(readdirSync(root).includes('inventory-baselines'),false);
}));
test('保留的客户签收与旧销售相连时拒绝切换，不能静默删除关联事实',async()=>setup(async(f,env)=>{
 const id=await legacyOrder(f);await f.approve(id);await f.ship(id,2,'2026-09-20');const ship=f.sqlite.prepare('SELECT id FROM wholesale_shipments WHERE order_id=?').get(id).id;
 f.sqlite.prepare('INSERT INTO wholesale_customer_receipts(id,order_id,shipment_id,business_date,receiver,proof_ref,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run('receipt-keep',id,ship,'2026-09-21','TEST RECEIVER','TEST-PROOF',f.users.sales.id,f.users.sales.name,'2026-09-21');const before=businessFingerprint(f.sqlite);
 assert.throws(()=>previewBaseline(f.sqlite,input()),/保留业务记录关联/);await assert.rejects(applyBaseline(env,f.users.admin,input(),{}),/保留业务记录关联/);assert.equal(businessFingerprint(f.sqlite),before);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM wholesale_customer_receipts').get().n,1);
}));
test('国内订单与实际营销样品成本均阻止旧期初清零，不覆盖新财务和库存事实',async()=>{
 await setup(async(f,env)=>{const call=(action,p)=>mutateDomesticDistribution(f.db,f.users.supply,{action,...p,operationId:crypto.randomUUID()});const c=await call('customerCreate',{companyName:'TEST COMPANY',companyShortName:'TEST',contact:'TEST',phone:'TEST',address:'TEST ONLY',supplyUserId:f.users.supply.id});await call('orderCreate',{customerId:c.id,businessDate:'2026-09-01',items:[{sku:'BAG-A',qty:1,unitPrice:'1.00'}]});const before=businessFingerprint(f.sqlite);assert.throws(()=>previewBaseline(f.sqlite,input()),/国内分销订单/);await assert.rejects(applyBaseline(env,f.users.admin,input(),{}),/国内分销订单/);assert.equal(businessFingerprint(f.sqlite),before);});
 await setup(async(f,env)=>{const m=marketingSamplesFixture(f),{id}=await m.create();await m.approve(id);await m.assign(id);await m.ship(id);await m.cost(id);await m.cost(id,'freight');const before=businessFingerprint(f.sqlite);assert.throws(()=>previewBaseline(f.sqlite,input()),/营销寄样单/);await assert.rejects(applyBaseline(env,f.users.admin,input(),{}),/营销寄样单/);assert.equal(businessFingerprint(f.sqlite),before);assert.equal(m.stock().qty,6);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM marketing_sample_costs').get().n,2);assert.ok(f.sqlite.prepare('SELECT COUNT(*) n FROM marketing_sample_events').get().n);});
});
