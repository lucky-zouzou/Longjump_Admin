import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture} from './fixtures.mjs';
import {fileBucket} from '../server/storage.mjs';
import {previewCleanup,applyCleanup,undoCleanup} from '../server/test-cleanup.mjs';
async function setup(fn){const root=mkdtempSync(join(tmpdir(),'lj-test-clean-')),prior=process.env.LOONGJUMP_BACKUP_DIR;process.env.LOONGJUMP_BACKUP_DIR=root;const f=fixture();f.db.sqlite=f.sqlite;const env={DB:f.db,WHOLESALE_FILES:fileBucket(join(root,'files'))};try{for(const month of ['2026-09','2026-10']){f.sqlite.prepare("INSERT INTO monthly_submissions(id,month,site,channel,items_json,total_qty,actor_id,submitted_at) VALUES(?,?,'印尼','TikTok','[]',0,'id-ops','2026-09-30')").run(month,month);f.sqlite.prepare("INSERT INTO approval_requests(id,type,month,status,stage,creator_id,creator_role,payload_json,created_at,updated_at) VALUES(?,'monthly_plan',?,'pending','admin_review','supply-1','供应链','{}','2026-09-30','2026-09-30')").run(month,month);f.sqlite.prepare("INSERT INTO new_product_projects(id,cycle_month,sku,stage_started_at,current_due_at,created_by,created_at,updated_at) VALUES(?,?,'BAG-A','2026-09-01','2026-09-04','id-ops','2026-09-01','2026-09-01')").run(month,month);f.sqlite.prepare("INSERT INTO new_product_stage_records(id,project_id,stage_key,data_json,actor_id,actor_name,submitted_at,updated_at) VALUES(?,?,'candidate','{}','id-ops','运营','2026-09-01','2026-09-01')").run(month,month);}await fn(f,env);}finally{f.sqlite.close();if(prior===undefined)delete process.env.LOONGJUMP_BACKUP_DIR;else process.env.LOONGJUMP_BACKUP_DIR=prior;rmSync(root,{recursive:true,force:true});}}
test('测试计划及新品清理保留10月记录和库存，可恢复且留痕',()=>setup(async(f,env)=>{const stock=JSON.stringify(f.sqlite.prepare('SELECT * FROM inventory_balances').all());const p=previewCleanup(f.sqlite);assert.equal(p.counts.monthly_submissions,1);const r=await applyCleanup(env,f.users.admin,p);for(const t of ['monthly_submissions','approval_requests','new_product_projects','new_product_stage_records'])assert.deepEqual(f.sqlite.prepare(`SELECT id FROM ${t}`).all().map(r=>r.id),['2026-10']);assert.equal(JSON.stringify(f.sqlite.prepare('SELECT * FROM inventory_balances').all()),stock);undoCleanup(env,f.users.admin,r.id);assert.equal(previewCleanup(f.sqlite).counts.new_product_stage_records,1);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE entity_type='test-cleanup'").get().n,2);}));
test('拒绝非管理员、过期预览、关联生产或批准计划、清理后的新业务覆盖',()=>setup(async(f,env)=>{const p=previewCleanup(f.sqlite);await assert.rejects(applyCleanup(env,f.users.supply,p),/管理员/);await assert.rejects(applyCleanup(env,f.users.admin,{fingerprint:'stale'}),/变化/);f.sqlite.exec("UPDATE approval_requests SET status='approved' WHERE month='2026-09'");assert.throws(()=>previewCleanup(f.sqlite),/关联/);f.sqlite.exec("UPDATE approval_requests SET status='pending';UPDATE new_product_projects SET production_batch_id='linked' WHERE cycle_month='2026-09'");assert.throws(()=>previewCleanup(f.sqlite),/关联/);f.sqlite.exec("UPDATE new_product_projects SET production_batch_id=NULL");const r=await applyCleanup(env,f.users.admin,previewCleanup(f.sqlite));f.sqlite.exec("UPDATE monthly_submissions SET total_qty=1 WHERE month='2026-10'");assert.throws(()=>undoCleanup(env,f.users.admin,r.id),/业务变化/);}));
test('中途失败整体回滚',()=>setup(async(f,env)=>{f.sqlite.exec("CREATE TRIGGER test_fail BEFORE DELETE ON approval_requests BEGIN SELECT RAISE(ABORT,'forced failure'); END");await assert.rejects(applyCleanup(env,f.users.admin,previewCleanup(f.sqlite)),/forced failure/);assert.equal(previewCleanup(f.sqlite).counts.new_product_projects,1);assert.equal(previewCleanup(f.sqlite).counts.monthly_submissions,1);}));

const september='september_products';
function addProject(f,id,month){
 f.sqlite.prepare("INSERT INTO new_product_projects(id,cycle_month,sku,stage_started_at,current_due_at,created_by,created_at,updated_at) VALUES(?,?,'BAG-A','2026-09-01','2026-09-04','id-ops','2026-09-01','2026-09-01')").run(id,month);
 f.sqlite.prepare("INSERT INTO new_product_stage_records(id,project_id,stage_key,data_json,actor_id,actor_name,submitted_at,updated_at) VALUES(?,?,'candidate','{}','id-ops','运营','2026-09-01','2026-09-01')").run(id,id);
}
function preservedTables(db){return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('new_product_projects','new_product_stage_records','audit_logs','system_maintenance') ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));}
test('仅9月新品清理保留8月10月项目及全部其他业务，允许在10月新业务后恢复',()=>setup(async(f,env)=>{
 addProject(f,'2026-08','2026-08');
 const order=await f.create({businessDate:'2026-10-02'});await f.approve(order);
 f.sqlite.exec("UPDATE approval_requests SET status='approved' WHERE month='2026-09'");
 const before=preservedTables(f.sqlite),auditBefore=f.sqlite.prepare('SELECT * FROM audit_logs ORDER BY rowid').all(),projects=f.sqlite.prepare('SELECT * FROM new_product_projects ORDER BY id').all();
 const p=previewCleanup(f.sqlite,september);assert.deepEqual(p.counts,{new_product_stage_records:1,new_product_projects:1});assert.deepEqual(p.projects.map(r=>r.month),['2026-09']);
 const r=await applyCleanup(env,f.users.admin,p,september);
 assert.deepEqual(preservedTables(f.sqlite),before);assert.equal(f.sqlite.prepare("SELECT mode FROM system_maintenance WHERE id='global'").get().mode,'normal');
 assert.deepEqual(f.sqlite.prepare('SELECT id FROM new_product_projects ORDER BY id').all().map(r=>r.id),['2026-08','2026-10']);
 assert.deepEqual(f.sqlite.prepare('SELECT id FROM new_product_stage_records ORDER BY id').all().map(r=>r.id),['2026-08','2026-10']);
 assert.deepEqual(f.sqlite.prepare('SELECT * FROM audit_logs ORDER BY rowid').all().slice(0,auditBefore.length),auditBefore);
 const detail=JSON.parse(f.sqlite.prepare("SELECT detail_json FROM audit_logs WHERE action='testCleanupApply'").get().detail_json);assert.equal(detail.scope,september);assert.equal(detail.month,'2026-09');assert.deepEqual(detail.counts,p.counts);
 f.sqlite.exec("UPDATE monthly_submissions SET total_qty=19 WHERE month='2026-10'");const afterOctober=preservedTables(f.sqlite);
 undoCleanup(env,f.users.admin,r.id);assert.deepEqual(f.sqlite.prepare('SELECT * FROM new_product_projects ORDER BY id').all(),projects);assert.deepEqual(preservedTables(f.sqlite),afterOctober);
}));
test('9月新品关联采购或生产时阻止定向清理，无关计划不扩大范围',()=>setup(async(f,env)=>{
 f.sqlite.exec("UPDATE new_product_projects SET production_batch_id='linked' WHERE cycle_month='2026-09'");assert.throws(()=>previewCleanup(f.sqlite,september),/关联/);
 f.sqlite.exec("UPDATE new_product_projects SET production_batch_id=NULL");
 f.sqlite.exec("INSERT INTO series_purchase_orders(id,month,series_name,total_qty,sku_count,approval_id,creator_id,created_at,updated_at) VALUES('linked','2026-10','Bags',1,1,'2026-09','admin-1','2026-10-01','2026-10-01')");
 assert.throws(()=>previewCleanup(f.sqlite,september),/关联/);
 f.sqlite.exec("UPDATE series_purchase_orders SET approval_id='unrelated'");assert.equal(previewCleanup(f.sqlite,september).counts.new_product_projects,1);
}));
test('定向清理拒绝非管理员、范围切换、无效范围和过期预览',()=>setup(async(f,env)=>{
 const p=previewCleanup(f.sqlite,september);
 await assert.rejects(applyCleanup(env,f.users.supply,p,september),/管理员/);
 await assert.rejects(applyCleanup(env,f.users.admin,p,'prelaunch_all'),/范围/);
 assert.throws(()=>previewCleanup(f.sqlite,'2026-10'),/范围/);
 assert.throws(()=>previewCleanup(f.sqlite,'constructor'),/范围/);
 f.sqlite.exec("UPDATE new_product_projects SET name='changed' WHERE cycle_month='2026-09'");await assert.rejects(applyCleanup(env,f.users.admin,p,september),/变化/);
 assert.equal(previewCleanup(f.sqlite,september).counts.new_product_projects,1);
}));
test('9月新品清理中途失败完整回滚，恢复同月SKU冲突不覆盖新记录',()=>setup(async(f,env)=>{
 f.sqlite.exec("CREATE TRIGGER scoped_fail BEFORE DELETE ON new_product_projects BEGIN SELECT RAISE(ABORT,'scoped failure'); END");
 await assert.rejects(applyCleanup(env,f.users.admin,previewCleanup(f.sqlite,september),september),/scoped failure/);assert.equal(previewCleanup(f.sqlite,september).counts.new_product_stage_records,1);
 f.sqlite.exec('DROP TRIGGER scoped_fail');const r=await applyCleanup(env,f.users.admin,previewCleanup(f.sqlite,september),september);
 await assert.rejects(applyCleanup(env,f.users.admin,previewCleanup(f.sqlite,september),september),/没有待清理/);
 addProject(f,'replacement','2026-09');assert.throws(()=>undoCleanup(env,f.users.admin,r.id),/冲突/);
 assert.deepEqual(f.sqlite.prepare("SELECT id FROM new_product_projects WHERE cycle_month='2026-09'").all().map(r=>r.id),['replacement']);
}));
