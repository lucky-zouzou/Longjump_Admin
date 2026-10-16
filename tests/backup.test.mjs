import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {fixture} from './fixtures.mjs';import {fileBucket,openDatabase} from '../server/storage.mjs';import {createBackup,restoreBackup,verifyArchive} from '../server/backup.mjs';import {backupStream} from '../lib/full-backup.mjs';import {releaseMigrations} from '../lib/backup-version.mjs';
test('全量备份恢复数据库及凭证原文件，验证哈希并拒绝破损包和覆盖已有目录',async()=>{const root=mkdtempSync(join(tmpdir(),'lj-backup-'));try{const f=fixture(),id=await f.create(),bucket=fileBucket(join(root,'files')),bytes=new Uint8Array([137,80,78,71,1,2,3]);await bucket.put('wholesale/proof',bytes);f.sqlite.prepare('INSERT INTO wholesale_files(id,order_id,object_key,name,content_type,size,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?)').run('proof',id,'wholesale/proof','evidence.png','image/png',bytes.length,f.users.supply.id,'2026-09-01');const path=join(root,'backup.tar');await createBackup({DB:f.db,WHOLESALE_FILES:bucket},path);const verified=await verifyArchive(path);assert.equal(verified.files.length,1);assert.equal(f.sqlite.prepare("SELECT mode FROM system_maintenance WHERE id='global'").get().mode,'normal');const out=join(root,'restored');await restoreBackup(path,out);const db=openDatabase(join(out,'business.sqlite'));assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM wholesale_orders').get().n,1);db.sqlite.close();const object=await fileBucket(join(out,'files')).get('wholesale/proof');assert.deepEqual(new Uint8Array(await new Response(object.body).arrayBuffer()),bytes);await assert.rejects(restoreBackup(path,out),/new directory/);const corrupt=readFileSync(path);corrupt[520]^=1;writeFileSync(join(root,'bad.tar'),corrupt);await assert.rejects(verifyArchive(join(root,'bad.tar'))); }finally{rmSync(root,{recursive:true,force:true})}});
test('备份期间数据库写入受锁保护，取消下载后释放锁',async()=>{const f=fixture(),stream=await backupStream(f.db,{get:async()=>null},f.users.admin,releaseMigrations);assert.throws(()=>f.sqlite.prepare("UPDATE inventory_balances SET qty=qty+1").run(),/maintenance/);await stream.cancel();assert.equal(f.sqlite.prepare("SELECT mode FROM system_maintenance WHERE id='global'").get().mode,'normal');});

test('外勤照片和合同附件随全量备份恢复，维护锁同时保护新表',async()=>{const root=mkdtempSync(join(tmpdir(),'lj-field-backup-'));try{const f=fixture(),bucket=fileBucket(join(root,'files')),bytes=new Uint8Array([1,2,3]),now=new Date().toISOString();f.sqlite.prepare('INSERT INTO field_records(id,kind,sales_user_id,business_date,end_date,data_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('field-backup','visit',f.users.sales.id,'2026-09-01','2026-09-01','{}',now,now);f.sqlite.prepare('INSERT INTO field_files(id,record_id,object_key,name,content_type,size,sha256,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run('ff-backup','field-backup','field/proof','shop.png','image/png',3,'test',f.users.sales.id,now);await bucket.put('field/proof',bytes);const stream=await backupStream(f.db,bucket,f.users.admin,releaseMigrations);assert.throws(()=>f.sqlite.prepare("UPDATE field_records SET status='valid'").run(),/maintenance/);await stream.cancel();const path=join(root,'backup.tar');await createBackup({DB:f.db,WHOLESALE_FILES:bucket},path);assert.equal((await verifyArchive(path)).files.length,1);const target=join(root,'restore');await restoreBackup(path,target);const db=openDatabase(join(target,'business.sqlite'));assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM field_records').get().n,1);db.sqlite.close();const object=await fileBucket(join(target,'files')).get('field/proof');assert.deepEqual(new Uint8Array(await new Response(object.body).arrayBuffer()),bytes);}finally{rmSync(root,{recursive:true,force:true})}});


test('售后证据与台账随备份恢复，新表受维护锁保护',async()=>{
 const {mutateAfterSales}=await import('../lib/after-sales.mjs');const {uploadAfterEvidence}=await import('../lib/after-sales-files.mjs');
 const root=mkdtempSync(join(tmpdir(),'lj-after-backup-'));try{
  const f=fixture(),bucket=fileBucket(join(root,'files'));
  const {id}=await mutateAfterSales(f.db,f.users.indonesia,{action:'create',businessDate:'2026-09-01',caseNo:'BACKUP-AFTER',orderNo:'ORDER',sku:'BAG-A',qty:1,reason:'商品质量问题',description:'拉链损坏申请售后',refundAmount:10});
  const bytes=new Uint8Array([255,216,255,1]);await uploadAfterEvidence(f.db,bucket,f.users.indonesia,id,new File([bytes],'proof.jpg'));
  const stream=await backupStream(f.db,bucket,f.users.admin,releaseMigrations);assert.throws(()=>f.sqlite.prepare("UPDATE after_sales SET status='submitted'").run(),/maintenance/);await stream.cancel();
  const path=join(root,'backup.tar');await createBackup({DB:f.db,WHOLESALE_FILES:bucket},path);assert.equal((await verifyArchive(path)).files.length,1);
  const target=join(root,'restore');await restoreBackup(path,target);const db=openDatabase(join(target,'business.sqlite'));const file=db.sqlite.prepare('SELECT * FROM after_sales_files').get();assert.equal(db.sqlite.prepare('SELECT count(*) n FROM after_sales').get().n,1);db.sqlite.close();
  const object=await fileBucket(join(target,'files')).get(file.object_key);assert.deepEqual(new Uint8Array(await new Response(object.body).arrayBuffer()),bytes);
 }finally{rmSync(root,{recursive:true,force:true})}
});


test('财务凭证原文件、上传人及回款关联随备份恢复',async()=>{
 const {uploadWholesaleFile}=await import('../lib/wholesale-files.mjs');
 const {indonesiaDate}=await import('../lib/wholesale.mjs');
 const root=mkdtempSync(join(tmpdir(),'lj-finance-proof-backup-'));try{
  const f=fixture(),id=await f.create(),bucket=fileBucket(join(root,'files'));await f.approve(id);
  const file=await uploadWholesaleFile(f.db,bucket,f.users.finance,{orderId:id,purpose:'finance',file:new File(['%PDF-1.7\nBank receipt'],'payment.pdf',{type:'application/pdf'})});
  await f.change(f.users.finance,id,'financeAdd',{kind:'receipt',amount:100000,reference:'BACKUP-PAY',businessDate:indonesiaDate(),note:'核实公司账户到账',proofIds:[file.id]});
  const path=join(root,'backup.tar');await createBackup({DB:f.db,WHOLESALE_FILES:bucket},path);assert.equal((await verifyArchive(path)).files.length,1);
  const target=join(root,'restore');await restoreBackup(path,target);const db=openDatabase(join(target,'business.sqlite'));
  const restored=db.sqlite.prepare('SELECT f.*,e.reference FROM wholesale_files f JOIN wholesale_finance_entries e ON e.id=f.finance_entry_id WHERE f.id=?').get(file.id);assert.equal(restored.reference,'BACKUP-PAY');assert.equal(restored.actor_name,'财务');assert.equal(restored.purpose,'finance');db.sqlite.close();
  const object=await fileBucket(join(target,'files')).get(restored.object_key);assert.equal(await new Response(object.body).text(),'%PDF-1.7\nBank receipt');
 }finally{rmSync(root,{recursive:true,force:true})}
});
