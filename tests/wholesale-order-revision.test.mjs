import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures.mjs';
import { mutateWholesale,readWholesale,indonesiaDate } from '../lib/wholesale.mjs';

const items=(f,id)=>f.sqlite.prepare('SELECT * FROM wholesale_order_items WHERE order_id=? ORDER BY sku').all(id);
const correction=(f,id,quantities)=>({orderId:id,version:f.orderRow(id).version,reason:'缺货商品延后采购，已核对销售',items:items(f,id).map(i=>({itemId:i.id,qty:quantities[i.sku]??i.qty}))});
const revise=(f,id,quantities)=>f.call(f.users.admin,'orderRevise',correction(f,id,quantities));
const balances=f=>f.sqlite.prepare('SELECT * FROM inventory_balances ORDER BY site,channel,sku').all();

test('out-of-stock SKU can be removed before approval; original order and immutable quotes remain, replacement alone reserves stock',async()=>{
  const f=fixture();try{
    const original=await f.create({saleType:'cash',items:[{sku:'BAG-A',qty:3,unitPrice:100000},{sku:'BAG-B',qty:2,unitPrice:100000}]});
    f.stock('BAG-B',0,0);
    const before=balances(f),originalItems=items(f,original),snapshots=f.sqlite.prepare('SELECT * FROM wholesale_price_snapshots WHERE order_id=?').all(original);
    await assert.rejects(f.approve(original),/BAG-B.*库存不足/);
    const result=await revise(f,original,{'BAG-B':0}),replacement=f.orderRow(result.id);
    assert.notEqual(result.id,original);assert.equal(f.orderRow(original).status,'cancelled');
    assert.equal(replacement.status,'pending');assert.equal(replacement.total_qty,3);assert.equal(replacement.total_amount,300000);
    assert.equal(replacement.creator_id,f.users.sales.id);assert.equal(replacement.customer_id,f.orderRow(original).customer_id);
    assert.deepEqual(items(f,original),originalItems);assert.deepEqual(f.sqlite.prepare('SELECT * FROM wholesale_price_snapshots WHERE order_id=?').all(original),snapshots);
    assert.deepEqual(balances(f),before);
    const audit=JSON.parse(f.sqlite.prepare("SELECT detail_json FROM audit_logs WHERE action='wholesale.order.revised' AND entity_id=?").get(original).detail_json);
    assert.equal(audit.replacementOrderId,result.id);assert.equal(audit.changes.find(i=>i.sku==='BAG-B').afterQty,0);
    await f.approve(result.id);assert.equal(f.orderRow(result.id).status,'approved');
    assert.equal(f.sqlite.prepare("SELECT SUM(reserved_qty) n FROM inventory_balances WHERE site='印尼'").get().n,3);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM wholesale_allocations WHERE order_item_id IN (SELECT id FROM wholesale_order_items WHERE order_id=?)').get(original).n,0);
    const view=await readWholesale(f.db,f.users.admin,indonesiaDate().slice(0,7));
    assert.equal(view.orders.find(o=>o.id===result.id).revisions[0].originalOrderId,original);
    assert.equal(view.orders.find(o=>o.id===original).revisions[0].replacementOrderId,result.id);
    assert.deepEqual(view.checks.issues,[]);
  }finally{f.sqlite.close();}
});

test('decrease quantities does not bypass remaining stock check or change price and business terms',async()=>{
  const f=fixture();try{
    const original=await f.create({saleType:'consignment',qty:8});f.stock('BAG-A',1,1);
    const {id}=await revise(f,original,{'BAG-A':3});assert.equal(f.orderRow(id).payment_terms,'credit');assert.equal(f.orderRow(id).sale_type,'consignment');assert.equal(items(f,id)[0].unit_price,100000);
    await assert.rejects(f.approve(id),/库存不足/);
    const second=await revise(f,id,{'BAG-A':2});await f.approve(second.id);
    assert.equal(f.sqlite.prepare("SELECT SUM(reserved_qty) n FROM inventory_balances WHERE site='印尼'").get().n,2);
    assert.equal(items(f,original)[0].qty,8);assert.equal(items(f,id)[0].qty,3);
  }finally{f.sqlite.close();}
});

test('only administrators may revise; self-approval restrictions and creator ownership remain',async()=>{
  const f=fixture();try{
    const id=await f.create({qty:5});const p=correction(f,id,{'BAG-A':3});
    for(const actor of [f.users.sales,f.users.finance,f.users.supply,f.users.indonesia])await assert.rejects(f.call(actor,'orderRevise',p),e=>e.status===403);
    const own=await f.create({qty:5,who:f.users.admin});const revised=await revise(f,own,{'BAG-A':3});
    await assert.rejects(f.approve(revised.id),/不能审批自己的订单/);
    assert.equal(f.orderRow(id).status,'pending');
  }finally{f.sqlite.close();}
});

test('approved, packed, shipped, cancelled and rejected records cannot use pending revision',async()=>{
  const f=fixture();try{
    for(const state of ['approved','packing','partial','completed','cancelled','rejected']){
      const id=await f.create();f.sqlite.prepare('UPDATE wholesale_orders SET status=? WHERE id=?').run(state,id);
      await assert.rejects(revise(f,id,{'BAG-A':3}),/仅未审批/);assert.equal(f.orderRow(id).status,state);
    }
  }finally{f.sqlite.close();}
});

test('reject increases, substitutions, changed prices, empty orders, missing or duplicate lines and unchanged requests',async()=>{
  const f=fixture();try{
    const id=await f.create({items:[{sku:'BAG-A',qty:5,unitPrice:100000},{sku:'BAG-B',qty:2,unitPrice:100000}]});
    for(const quantities of [{'BAG-A':6},{'BAG-A':1.5},{'BAG-A':-1},{'BAG-A':0,'BAG-B':0},{},{'BAG-A':''}])await assert.rejects(revise(f,id,quantities),e=>e.status===400);
    const p=correction(f,id,{'BAG-A':3});
    for(const lines of [p.items.slice(0,1),[p.items[0],p.items[0]],[{...p.items[0],sku:'BAG-B'},p.items[1]],[{...p.items[0],unitPrice:1},p.items[1]],[{...p.items[0],itemId:'other-order'},p.items[1]]])await assert.rejects(f.call(f.users.admin,'orderRevise',{...p,items:lines}),e=>e.status===400);
    await assert.rejects(f.call(f.users.admin,'orderRevise',{...p,reason:'x'}),/至少4/);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM wholesale_orders').get().n,1);assert.equal(f.orderRow(id).version,1);
  }finally{f.sqlite.close();}
});

test('existing financial records, proofs and allocations are protected even on legacy pending orders',async()=>{
  const f=fixture();try{
    const money=await f.create();f.sqlite.prepare("INSERT INTO wholesale_finance_entries(id,order_id,kind,amount,reference,business_date,note,actor_id,created_at) VALUES ('paid',?,'receipt',1,'LEGACY-PAID','2026-08-01','历史收款','finance-1','2026-08-01')").run(money);
    await assert.rejects(revise(f,money,{'BAG-A':3}),/财务凭据/);
    const proof=await f.create();f.sqlite.prepare("INSERT INTO wholesale_files(id,order_id,object_key,name,content_type,size,actor_id,created_at,purpose) VALUES ('proof',?,'test/proof','photo.jpg','image/jpeg',100,'finance-1','2026-08-01','finance')").run(proof);
    await assert.rejects(revise(f,proof,{'BAG-A':3}),/财务凭据/);
    const allocated=await f.create();f.sqlite.prepare("INSERT INTO wholesale_allocations(id,order_item_id,channel,qty) VALUES ('alloc',?,'TikTok',5)").run(items(f,allocated)[0].id);
    await assert.rejects(revise(f,allocated,{'BAG-A':3}),/库存预留/);
    for(const id of [money,proof,allocated])assert.equal(f.orderRow(id).status,'pending');
    assert.equal(f.sqlite.prepare('SELECT amount FROM wholesale_finance_entries WHERE id=\'paid\'').get().amount,1);
  }finally{f.sqlite.close();}
});

test('idempotent retry returns same replacement; stale or concurrent revision rolls back without extra orders',async()=>{
  const f=fixture();try{
    const id=await f.create(),payload={action:'orderRevise',...correction(f,id,{'BAG-A':3}),operationId:crypto.randomUUID()};
    const first=await mutateWholesale(f.db,f.users.admin,payload),replay=await mutateWholesale(f.db,f.users.admin,payload);
    assert.equal(first.id,replay.id);assert.equal(replay.replayed,true);
    await assert.rejects(mutateWholesale(f.db,f.users.admin,{...payload,operationId:crypto.randomUUID()}),/订单已被其他人更新/);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM wholesale_orders').get().n,2);
    const next=await f.create(),data=correction(f,next,{'BAG-A':2});const batch=f.db.batch;
    f.db.batch=async statements=>{f.sqlite.prepare('UPDATE wholesale_orders SET version=version+1 WHERE id=?').run(next);return batch(statements);};
    await assert.rejects(f.call(f.users.admin,'orderRevise',data),/订单或库存已变化/);
    assert.equal(f.orderRow(next).status,'pending');assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM wholesale_orders').get().n,3);
  }finally{f.sqlite.close();}
});

test('finance proof appearing between review and commit prevents revision atomically',async()=>{
  const f=fixture();try{
    const id=await f.create(),batch=f.db.batch;
    f.db.batch=async statements=>{f.sqlite.prepare("INSERT INTO wholesale_files(id,order_id,object_key,name,content_type,size,actor_id,created_at,purpose) VALUES ('race-proof',?,'test/race-proof','proof.pdf','application/pdf',100,'finance-1','2026-08-01','finance')").run(id);return batch(statements);};
    await assert.rejects(revise(f,id,{'BAG-A':3}),/订单或库存已变化/);
    assert.equal(f.orderRow(id).status,'pending');assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM wholesale_orders').get().n,1);
  }finally{f.sqlite.close();}
});

test('closed accounting period does not get a silent replacement or cancellation',async()=>{
  const f=fixture();try{
    const id=await f.create();f.sqlite.prepare("INSERT INTO wholesale_finance_periods(month,status,snapshot_json,note,actor_id,updated_at) VALUES ('2026-08','closed','{}','测试关账','finance-1','2026-09-01')").run();
    await assert.rejects(revise(f,id,{'BAG-A':3}),/订单或库存已变化/);
    assert.equal(f.orderRow(id).status,'pending');assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM wholesale_orders').get().n,1);
  }finally{f.sqlite.close();}
});

test('distributor relationship and original request replay mapping are retained',async()=>{
  const f=fixture();try{
    const id=await f.create(),o=f.orderRow(id);f.sqlite.prepare('INSERT INTO distributor_orders(order_id,customer_id,request_id,fingerprint) VALUES (?,?,?,?)').run(id,o.customer_id,'original-request','original-fingerprint');
    const revised=await revise(f,id,{'BAG-A':3});
    assert.equal(f.sqlite.prepare("SELECT order_id FROM distributor_orders WHERE request_id='original-request'").get().order_id,id);
    assert.equal(f.sqlite.prepare('SELECT customer_id FROM distributor_orders WHERE order_id=?').get(revised.id).customer_id,o.customer_id);
    const data=await readWholesale(f.db,f.users.admin,indonesiaDate().slice(0,7),'distribution');assert.equal(data.orders.length,2);assert.equal(data.orders.find(o=>o.id===revised.id).revisions.length,1);
  }finally{f.sqlite.close();}
});

test('special price remains single-use and follows the reduced replacement while original quote evidence stays immutable',async()=>{
  const f=fixture();try{
    const c=await f.call(f.users.sales,'customerCreate',{name:'Special revision customer',contact:'Test',phone:'0812',city:'Jakarta',address:'Test warehouse'});
    const r=await f.call(f.users.sales,'priceRequestCreate',{customerId:c.id,sku:'BAG-A',qty:5,unitPrice:85000,reason:'客户已沟通特价'});
    await f.call(f.users.admin,'priceRequestDecide',{requestId:r.id,version:1,decision:'approve',priceVersion:1,unitPrice:85000,validUntil:'2099-01-01',reason:'已核实订单特价',priceExceptionConfirmed:true});
    const original=await f.call(f.users.sales,'orderCreate',{customerId:c.id,saleType:'cash',businessDate:indonesiaDate(),items:[{sku:'BAG-A',qty:5,unitPrice:85000,priceRequestId:r.id}]});
    const revised=await revise(f,original.id,{'BAG-A':3});
    assert.equal(f.sqlite.prepare('SELECT used_order_id FROM wholesale_price_requests WHERE id=?').get(r.id).used_order_id,revised.id);
    assert.equal(items(f,original.id)[0].price_request_id,r.id);assert.equal(items(f,revised.id)[0].price_request_id,r.id);
    await f.approve(revised.id);assert.equal(f.sqlite.prepare("SELECT status FROM wholesale_price_snapshots WHERE order_id=? AND phase='approval'").get(revised.id).status,'special_approved');
  }finally{f.sqlite.close();}
});
