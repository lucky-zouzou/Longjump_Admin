import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {uploadWholesaleFile} from '../lib/wholesale-files.mjs';
import {readWholesale,indonesiaDate,mutateWholesale} from '../lib/wholesale.mjs';
const today=indonesiaDate(),month=today.slice(0,7);
const pdf=()=>new File(['%PDF-1.7\nTest payment evidence'],'payment.pdf',{type:'application/pdf'});
const bucket=()=>({objects:new Map(),async put(key,bytes){this.objects.set(key,bytes)},async delete(key){this.objects.delete(key)}});
const upload=(f,b,id,extra={})=>uploadWholesaleFile(f.db,b,f.users.finance,{orderId:id,purpose:'finance',file:pdf(),...extra});
const pay=(f,id,proofIds=[],extra={})=>f.change(f.users.finance,id,'financeAdd',{kind:'receipt',amount:100000,reference:crypto.randomUUID(),businessDate:today,note:'核对公司账户到账',proofIds,...extra});

test('待审订单可上传财务PDF，原状态与金额不变；只向财务及管理员返回凭证元数据',async()=>{
 const f=fixture(),id=await f.create(),b=bucket(),before=f.orderRow(id),file=await upload(f,b,id);
 assert.deepEqual(f.orderRow(id),before);assert.equal(file.actor_name,'财务');assert.equal(file.finance_entry_id,null);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='wholesaleFileUpload'").get().n,1);
 for(const who of ['finance','admin']){const o=(await readWholesale(f.db,f.users[who],month)).orders[0];assert.equal(o.financeFiles[0].id,file.id);assert.equal(o.files.length,0);assert.ok(!JSON.stringify(o.financeFiles).includes('object_key'));}
 let o=(await readWholesale(f.db,f.users.sales,month)).orders[0];assert.deepEqual(o.financeFiles,[]);assert.ok(!JSON.stringify(o).includes('payment.pdf'));
 await f.approve(id);o=(await readWholesale(f.db,f.users.supply,month)).orders[0];assert.deepEqual(o.financeFiles,[]);
 for(const who of ['sales','supply'])await assert.rejects(uploadWholesaleFile(f.db,b,f.users[who],{orderId:id,purpose:'finance',file:pdf()}),/仅财务/);
});

test('回款与附件关联原子保存，重复提交不重复收款，已绑定附件不能改挂',async()=>{
 const f=fixture(),id=await f.create(),b=bucket();await f.approve(id);const file=await upload(f,b,id);
 const p={action:'financeAdd',orderId:id,version:f.orderRow(id).version,operationId:crypto.randomUUID(),kind:'receipt',amount:100000,reference:'PAY-ONE',businessDate:today,note:'已核对实际到账',proofIds:[file.id]};
 await mutateWholesale(f.db,f.users.finance,p);assert.equal((await mutateWholesale(f.db,f.users.finance,p)).replayed,true);
 const entry=f.sqlite.prepare('SELECT * FROM wholesale_finance_entries WHERE order_id=?').get(id);
 assert.equal(f.sqlite.prepare('SELECT finance_entry_id FROM wholesale_files WHERE id=?').get(file.id).finance_entry_id,entry.id);
 assert.equal((await readWholesale(f.db,f.users.finance,month)).orders[0].paid,100000);
 await assert.rejects(pay(f,id,[file.id]),/已关联/);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM wholesale_finance_entries').get().n,1);
 assert.throws(()=>f.sqlite.prepare('UPDATE wholesale_files SET finance_entry_id=NULL WHERE id=?').run(file.id),/immutable/);
});

test('拒绝跨单凭证、发货凭证和无效ID，失败不登记金额；回款凭证不能用于发货',async()=>{
 const f=fixture(),id=await f.create(),other=await f.create(),b=bucket();await f.approve(id);await f.approve(other);
 const file=await upload(f,b,other);
 await assert.rejects(pay(f,id,[file.id]),/不属于/);await assert.rejects(pay(f,id,['missing']),/不存在/);await assert.rejects(pay(f,id,[{}]),/不存在/);
 const shipment=await uploadWholesaleFile(f.db,b,f.users.supply,{orderId:id,file:new File([new Uint8Array([255,216,255,1])],'shipment.jpg',{type:'image/jpeg'})});
 await assert.rejects(pay(f,id,[shipment.id]),/不属于/);
 const own=await upload(f,b,id);await assert.rejects(f.ship(id,1,today,{proofIds:[own.id],trackingNo:''}),/出库凭证不存在/);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM wholesale_finance_entries').get().n,0);
});

test('已完成订单可补充历史回款凭证，数量上限和格式验证有效，补充不改金额库存',async()=>{
 const f=fixture(),id=await f.create(),b=bucket();await f.approve(id);await f.ship(id,5);await pay(f,id);
 const entry=f.sqlite.prepare('SELECT * FROM wholesale_finance_entries WHERE order_id=?').get(id),before=f.orderRow(id);
 for(let i=0;i<10;i++)await upload(f,b,id,{entryId:entry.id});
 await assert.rejects(upload(f,b,id,{entryId:entry.id}),/最多关联10/);
 assert.deepEqual(f.orderRow(id),before);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM wholesale_files').get().n,10);
 await assert.rejects(upload(f,b,id,{file:new File(['not a pdf'],'fake.pdf',{type:'application/pdf'})}),/格式不符/);
 await assert.rejects(upload(f,b,id,{file:new File(['<script>'],'bad.svg',{type:'image/svg+xml'})}),/支持/);
 await assert.rejects(upload(f,b,id,{entryId:'missing'}),/不属于/);
 assert.equal(b.objects.size,10);
});

test('维护锁和关联并发冲突会终止上传，失败清理文件，原财务记录不变',async()=>{
 const f=fixture(),id=await f.create(),b=bucket();await f.approve(id);await pay(f,id);const entry=f.sqlite.prepare('SELECT * FROM wholesale_finance_entries').get();
 f.sqlite.prepare("INSERT INTO system_maintenance(id,mode,expires_at,updated_at) VALUES('global','backup',?,'now')").run(new Date(Date.now()+60000).toISOString());
 await assert.rejects(upload(f,b,id),/备份或迁移/);assert.equal(b.objects.size,0);
 f.sqlite.prepare("UPDATE system_maintenance SET mode='normal' WHERE id='global'").run();
 // Simulate another upload filling the record after validation but before the batch commits.
 b.put=async function(key,bytes){this.objects.set(key,bytes);for(let i=0;i<10;i++)f.sqlite.prepare("INSERT INTO wholesale_files (id,order_id,object_key,name,content_type,size,actor_id,created_at,purpose,finance_entry_id) VALUES(?,?,?,'other.pdf','application/pdf',1,?,'now','finance',?)").run('race'+i,id,'race/'+i,f.users.finance.id,entry.id);};
 await assert.rejects(upload(f,b,id,{entryId:entry.id}),/超过10份/);assert.equal(b.objects.size,0);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='wholesaleFileUpload'").get().n,0);
 assert.equal(f.sqlite.prepare('SELECT amount FROM wholesale_finance_entries').get().amount,100000);
});
