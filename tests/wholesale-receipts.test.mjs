import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {readWholesale,mutateWholesale,indonesiaDate} from '../lib/wholesale.mjs';
const day=indonesiaDate(),month=day.slice(0,7);
const shipments=(f,id)=>f.sqlite.prepare('SELECT * FROM wholesale_shipments WHERE order_id=? ORDER BY rowid').all(id);
const entries=(f,id)=>f.sqlite.prepare('SELECT * FROM wholesale_customer_receipts WHERE order_id=? ORDER BY rowid').all(id);
const fields=(f,id,extra={})=>({shipmentId:shipments(f,id)[0]?.id,businessDate:day,receiver:'客户签收人',proofRef:'客户消息确认收到整批货物',receivedConfirmed:true,...extra});
const confirm=(f,id,extra={},who=f.users.sales)=>f.change(who,id,'customerReceiptConfirm',fields(f,id,extra));
const view=async(f,id,who=f.users.admin)=>(await readWholesale(f.db,who,month)).orders.find(o=>o.id===id);

test('仓库发货不自动确认客户收货；分批确认不改变库存、回款、寄售结算或发货状态',async()=>{
 const f=fixture(),id=await f.create({saleType:'consignment'});await f.approve(id);await f.ship(id,2);
 assert.equal((await view(f,id)).customerReceipt.status,'待客户收货');const order=f.orderRow(id),stock=f.sqlite.prepare('SELECT * FROM inventory_balances').all();
 await confirm(f,id);let o=await view(f,id);assert.equal(o.customerReceipt.status,'已发批次全部收货');assert.equal(o.status,'partial');assert.equal(o.paid,0);assert.equal(o.financial.salesAmount,0);
 assert.deepEqual(f.sqlite.prepare('SELECT * FROM inventory_balances').all(),stock);assert.equal(f.orderRow(id).total_amount,order.total_amount);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM wholesale_finance_entries').get().n,0);
 await f.ship(id,3);o=await view(f,id);assert.equal(o.customerReceipt.status,'部分批次已收货');assert.equal(o.customerReceipt.pending,1);
 await confirm(f,id,{shipmentId:shipments(f,id)[1].id},f.users.supply);o=await view(f,id);assert.equal(o.customerReceipt.confirmed,2);assert.equal(o.customerReceipt.status,'已发批次全部收货');assert.equal(o.status,'completed');assert.equal(o.customerReceipts.length,2);
 assert.equal(entries(f,id)[0].actor_name,f.users.sales.name);
});

test('拒绝未发货、跨订单批次、未来或早于出库日期、缺少签收人与依据或确认勾选',async()=>{
 const f=fixture(),id=await f.create();await assert.rejects(confirm(f,id),/已实际发货/);await f.approve(id);await f.ship(id,5);
 for(const extra of [{receiver:''},{proofRef:' '},{receivedConfirmed:false}])await assert.rejects(confirm(f,id,extra),/收货人、核对依据/);
 await assert.rejects(confirm(f,id,{businessDate:'2099-01-01'}),/业务日期/);
 await assert.rejects(confirm(f,id,{businessDate:'2026-02-30'}),/业务日期/);
 await assert.rejects(confirm(f,id,{businessDate:'2026-08-01'}),/不能早于/);
 const other=await f.create();await f.approve(other);await f.ship(other,1);await assert.rejects(confirm(f,id,{shipmentId:shipments(f,other)[0].id}),/本订单/);assert.equal(entries(f,id).length,0);
});

test('本人责任范围及岗位在服务器校验，其他销售/供应链不能读取或代确认',async()=>{
 const f=fixture(),id=await f.create();await f.approve(id);await f.ship(id,5);
 for(const who of [f.users.sales2,f.users.supply2]){await assert.rejects(confirm(f,id,{},who),/责任范围/);assert.equal(await view(f,id,who),undefined);}
 await assert.rejects(confirm(f,id,{},f.users.malaysia),/无权/);await assert.rejects(confirm(f,id,{},{id:'factory',role:'工厂'}),/无权/);
 await confirm(f,id,{},f.users.finance);for(const who of [f.users.sales,f.users.supply,f.users.admin,f.users.finance])assert.equal((await view(f,id,who)).customerReceipt.confirmed,1);
});

test('重复提交幂等，同版并发或新操作重复确认不产生多条有效记录',async()=>{
 const f=fixture(),id=await f.create();await f.approve(id);await f.ship(id,5);
 const p={action:'customerReceiptConfirm',orderId:id,version:f.orderRow(id).version,operationId:crypto.randomUUID(),...fields(f,id)};
 await mutateWholesale(f.db,f.users.sales,p);assert.equal((await mutateWholesale(f.db,f.users.sales,p)).replayed,true);
 await assert.rejects(mutateWholesale(f.db,f.users.sales,{...p,operationId:crypto.randomUUID()}),/已被其他人更新/);await assert.rejects(confirm(f,id),/已确认收货/);
 assert.equal(entries(f,id).length,1);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='customerReceiptConfirm'").get().n,1);
});

test('仅原确认人或财务管理员可撤销，保留原始依据和撤销原因，可重新确认',async()=>{
 const f=fixture(),id=await f.create();await f.approve(id);await f.ship(id,5);await confirm(f,id);const r=entries(f,id)[0];
 const revoke=(who,reason='选择了错误的发货批次')=>f.change(who,id,'customerReceiptRevoke',{receiptId:r.id,reason});
 await assert.rejects(revoke(f.users.supply),/仅原确认人/);await assert.rejects(revoke(f.users.sales,''),/至少4/);
 await revoke(f.users.finance);assert.equal((await view(f,id)).customerReceipt.status,'待客户收货');assert.equal(entries(f,id)[0].proof_ref,r.proof_ref);assert.equal(entries(f,id)[0].revoked_by_name,'财务');
 await assert.rejects(revoke(f.users.sales),/已撤销/);await confirm(f,id,{receiver:'正确签收人'});assert.equal(entries(f,id).length,2);assert.equal((await view(f,id)).customerReceipt.confirmed,1);
 assert.throws(()=>f.sqlite.prepare('UPDATE wholesale_customer_receipts SET receiver=? WHERE id=?').run('覆盖原确认人',r.id),/immutable/);
});

test('事务竞争及维护期间不写入确认记录，数据库拒绝跨单关联和无原因撤销',async()=>{
 const f=fixture(),id=await f.create();await f.approve(id);await f.ship(id,5);
 const original=f.db.batch;f.db.batch=async statements=>{f.sqlite.prepare('UPDATE wholesale_orders SET version=version+1 WHERE id=?').run(id);return original(statements)};
 await assert.rejects(confirm(f,id),/已变化/);assert.equal(entries(f,id).length,0);f.db.batch=original;
 f.sqlite.prepare("INSERT INTO system_maintenance(id,mode,expires_at,updated_at) VALUES('global','backup',?,'now')").run(new Date(Date.now()+60000).toISOString());await assert.rejects(confirm(f,id),/备份或迁移/);
 f.sqlite.prepare("UPDATE system_maintenance SET mode='normal' WHERE id='global'").run();await confirm(f,id);const r=entries(f,id)[0];
 assert.throws(()=>f.sqlite.prepare("UPDATE wholesale_customer_receipts SET revoked_at='now',revoked_by='x',revoked_by_name='x' WHERE id=?").run(r.id),/CHECK/);
 const other=await f.create();assert.throws(()=>f.sqlite.prepare('INSERT INTO wholesale_customer_receipts(id,order_id,shipment_id,business_date,receiver,proof_ref,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run('wrong',other,r.shipment_id,day,'人','错误跨单凭证','x','x','now'),/guard_wh_receipt/);
});
