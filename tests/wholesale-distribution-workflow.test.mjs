import test from 'node:test';
import * as XLSX from 'xlsx';
import {toWholesaleWorkbook} from '../lib/wholesale-finance.mjs';
import assert from 'node:assert/strict';
import { fixture } from './fixtures.mjs';
import { readWholesale, indonesiaDate, mutateWholesale, wholesaleTasks } from '../lib/wholesale.mjs';
import { expireWholesaleReservations } from '../lib/wholesale-workflow.mjs';
import { loadWholesaleExportSnapshot } from '../lib/wholesale-export.mjs';
import { warehouseSheets } from '../lib/wholesale-outbound.mjs';
const future=()=>new Date(Date.now()+86400000).toISOString();
const due=()=>new Date(Date.now()+30*86400000).toISOString().slice(0,10);
async function setup(mode='prepaid',overrides={}){
 const f=fixture({workflowVersion:2}),c=await f.call(f.users.sales,'customerCreate',{name:'TEST 公司全称',companyShortName:'TEST简称',contact:'TEST',phone:crypto.randomUUID(),city:'Jakarta',address:'TEST ONLY'});
 const payload={customerId:c.id,businessDate:indonesiaDate(),saleType:mode==='consignment'?'consignment':'cash',settlementMode:mode,contractReference:mode==='prepaid'?'':'TEST 合同条款',dueDate:due(),items:[{sku:'BAG-A',qty:5,unitPrice:100000}],...overrides};
 const id=(await f.call(f.users.sales,'orderCreate',payload)).id;
 const approve=(extra={})=>f.change(f.users.supply,id,'orderApprove',{supplyUserId:f.users.supply.id,logisticsUserId:f.users.supply.id,reservationExpiresAt:future(),stockBasisConfirmed:true,reason:'TEST 库存价格及结算核对',...extra});
 const confirm=()=>f.change(f.users.sales,id,'orderCustomerConfirm',{proofRef:'TEST 客户确认合同、数量与价格'});
 const release=()=>f.change(f.users.supply,id,'orderRelease');
 const receipt=(amount=500000)=>f.change(f.users.finance,id,'financeAdd',{kind:'receipt',amount,reference:crypto.randomUUID(),businessDate:indonesiaDate(),note:'TEST 财务核对银行实际到账'});
 const assign=()=>f.change(f.users.supply,id,'orderAssignWarehouse',{warehouseUserId:f.users.supply2.id,warehouse:'TEST Jakarta仓',reason:'TEST 指定仓库执行'});
 const photo=()=>{const idPhoto='photo_'+crypto.randomUUID();f.sqlite.prepare("INSERT INTO wholesale_files(id,order_id,object_key,name,content_type,size,actor_id,created_at,purpose) VALUES (?,?,?,?,?,?,?,?,'shipment')").run(idPhoto,id,'test/'+idPhoto,'TEST包装.png','image/png',100,f.users.supply2.id,new Date().toISOString());return idPhoto;};
 const pack=()=>f.change(f.users.supply2,id,'orderPack',{proofIds:[photo()]});
 const ship=(extra={})=>f.change(f.users.supply2,id,'orderShip',{items:[{itemId:f.sqlite.prepare('SELECT id FROM wholesale_order_items WHERE order_id=?').get(id).id,qty:5}],businessDate:indonesiaDate(),warehouse:'TEST Jakarta仓',carrier:'Lalamove',trackingNo:'TEST-TRACK',handoverConfirmed:true,...extra});
 return {...f,id,c,payload,approve,confirm,release,receipt,assign,photo,pack,ship};
}
test('new orders force modern workflow; supply reviews stock and prices, finance cannot substitute',async()=>{
 const f=await setup();assert.equal(f.orderRow(f.id).workflow_version,2);assert.match(f.orderRow(f.id).order_no,/^ID-[0-9]{6}$/);assert.equal(JSON.parse(f.orderRow(f.id).customer_json).company_short_name,'TEST简称');
 const visible=await readWholesale(f.db,f.users.supply,indonesiaDate().slice(0,7));assert.equal(visible.orders.length,1);assert.equal(visible.orders[0].capabilities.review,true);
 await assert.rejects(f.change(f.users.finance,f.id,'orderApprove',{stockBasisConfirmed:true}),/无权/);
 await assert.rejects(f.approve({reservationExpiresAt:''}),/截止/);assert.equal(f.orderRow(f.id).status,'pending');
 await f.approve();assert.equal(f.sqlite.prepare('SELECT SUM(reserved_qty) n FROM inventory_balances WHERE site=\'印尼\' AND sku=\'BAG-A\'').get().n,5);
 await assert.rejects(f.ship(),/指定仓库|责任范围/);
 const created=await mutateWholesale(f.db,f.users.sales,{action:'orderCreate',...f.payload,workflowVersion:1,operationId:crypto.randomUUID()});assert.equal(f.orderRow(created.id).workflow_version,2);
});
test('prepaid confirmation, actual receipt, instruction, exact dispatch and receipt reversal remain one closed loop',async()=>{
 const f=await setup();await f.approve();await f.confirm();
 await assert.rejects(f.assign(),/净到账/);await assert.rejects(f.change(f.users.supply,f.id,'orderRelease'),/财务/);
 await f.receipt();const r=f.sqlite.prepare('SELECT * FROM wholesale_release_instructions WHERE order_id=?').get(f.id);assert.ok(r);assert.equal(r.instruction_no,f.orderRow(f.id).order_no+'-OUT-01');
 await f.assign();await assert.rejects(f.change(f.users.supply,f.id,'orderPack',{proofIds:[f.photo()]}),/指定仓库/);
 await assert.rejects(f.change(f.users.supply2,f.id,'orderPack',{proofIds:[]}),/照片/);await f.pack();
 await assert.rejects(f.ship({trackingNo:''}),/运单/);
 const entry=f.sqlite.prepare("SELECT id FROM wholesale_finance_entries WHERE order_id=? AND kind='receipt'").get(f.id);
 await f.change(f.users.finance,f.id,'financeReverse',{entryId:entry.id,businessDate:indonesiaDate(),reference:'TEST-REVERSE',note:'TEST 错误到账冲正'});
 await assert.rejects(f.ship(),/净到账/);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM wholesale_shipments').get().n,0);
 await f.receipt();await f.ship();assert.equal(f.orderRow(f.id).status,'completed');assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM wholesale_release_instructions').get().n,1);
 assert.equal(f.sqlite.prepare("SELECT SUM(qty) n FROM inventory_balances WHERE site='印尼' AND sku='BAG-A'").get().n,15);
});
test('credit and consignment need approved terms; no receipt invented and consignment stays unsold',async()=>{
 for(const mode of ['credit','consignment']){const f=await setup(mode);await assert.rejects(f.approve({contractReference:''}),/合同/);await assert.rejects(f.approve({dueDate:'2000-01-01'}),/到期/);await f.approve();await f.confirm();await assert.rejects(f.change(f.users.sales,f.id,'orderRelease'),/财务/);await f.release();await f.assign();await f.pack();await f.ship();
 const o=(await readWholesale(f.db,f.users.finance,indonesiaDate().slice(0,7))).orders[0];assert.equal(o.paid,0);assert.equal(o.payable,mode==='consignment'?0:500000);assert.equal(o.sale_type,mode==='consignment'?'consignment':'cash');}
});
test('return unshipped order releases stock; responsible sales resubmits a larger new linked order',async()=>{
 const f=await setup();await f.approve();await f.change(f.users.supply,f.id,'orderReturnToSales',{reason:'TEST 客户增加商品需要重签'});
 assert.equal(f.orderRow(f.id).status,'rejected');assert.equal(f.sqlite.prepare("SELECT SUM(reserved_qty) n FROM inventory_balances WHERE site='印尼' AND sku='BAG-A'").get().n,0);
 await assert.rejects(f.change(f.users.sales2,f.id,'orderResubmit',{...f.payload,reason:'TEST 重新申请'}),/范围/);
 const next=await f.change(f.users.sales,f.id,'orderResubmit',{...f.payload,reason:'TEST 原需求由5增至8',items:[{sku:'BAG-A',qty:8,unitPrice:100000}]});
 assert.equal(f.orderRow(f.id).status,'cancelled');assert.equal(f.orderRow(f.id).total_qty,5);assert.equal(f.orderRow(next.id).total_qty,8);assert.equal(f.orderRow(next.id).workflow_version,2);
 assert.equal(f.sqlite.prepare('SELECT original_order_id FROM wholesale_workflows WHERE order_id=?').get(next.id).original_order_id,f.id);
 await assert.rejects(f.change(f.users.sales,f.id,'orderResubmit',{...f.payload,reason:'TEST 重复申请'}),/退回/);
});
test('funds and pending proofs prevent returning or automatic timeout; clean unpaid reservation releases once',async()=>{
 const clean=await setup();await clean.approve();const result=await expireWholesaleReservations(clean.db,{now:new Date(Date.now()+2*86400000).toISOString()});assert.equal(result.released,1);assert.equal(clean.orderRow(clean.id).status,'cancelled');assert.equal((await expireWholesaleReservations(clean.db,{now:new Date(Date.now()+2*86400000).toISOString()})).released,0);
 const paid=await setup();await paid.approve();await paid.receipt(100000);await assert.rejects(paid.change(paid.users.supply,paid.id,'orderReturnToSales',{reason:'TEST 重新申请'}),/财务记录/);assert.equal((await expireWholesaleReservations(paid.db,{now:new Date(Date.now()+2*86400000).toISOString()})).review,1);assert.equal(paid.orderRow(paid.id).status,'approved');
 const proof=await setup();await proof.approve();proof.sqlite.prepare("INSERT INTO wholesale_files(id,order_id,object_key,name,content_type,size,actor_id,created_at,purpose) VALUES ('pending-proof',?,'test/pending','TEST.png','image/png',100,?,?,'finance')").run(proof.id,proof.users.finance.id,new Date().toISOString());assert.equal((await expireWholesaleReservations(proof.db,{now:new Date(Date.now()+2*86400000).toISOString()})).review,1);
});
test('a proof-blocked oldest reservation never starves later unpaid orders when the release batch is one',async(t)=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-24T02:00:00Z')});
 const f=await setup();await f.approve({reservationExpiresAt:'2026-11-24T03:00:00Z'});
 f.sqlite.prepare("INSERT INTO wholesale_files(id,order_id,object_key,name,content_type,size,actor_id,created_at,purpose) VALUES ('TEST-OLDEST-PROOF',?,'test/oldest-proof','TEST.png','image/png',100,?,?,'finance')").run(f.id,f.users.finance.id,new Date().toISOString());
 const later=[];
 for(const hour of ['04','05']){
  const id=(await f.call(f.users.sales,'orderCreate',f.payload)).id;later.push(id);
  await f.change(f.users.supply,id,'orderApprove',{supplyUserId:f.users.supply.id,logisticsUserId:f.users.supply.id,reservationExpiresAt:`2026-11-24T${hour}:00:00Z`,stockBasisConfirmed:true,reason:'TEST 库存与结算核对'});
 }
 t.mock.timers.setTime(Date.parse('2026-11-26T02:00:00Z'));
 const first=await expireWholesaleReservations(f.db,{limit:1});assert.deepEqual(first,{checked:2,released:1,review:1,conflicts:0});
 assert.equal(f.orderRow(later[0]).status,'cancelled');assert.equal(f.orderRow(later[1]).status,'approved');
 const second=await expireWholesaleReservations(f.db,{limit:1});assert.deepEqual(second,{checked:2,released:1,review:1,conflicts:0});
 const third=await expireWholesaleReservations(f.db,{limit:1});assert.deepEqual(third,{checked:1,released:0,review:1,conflicts:0});
 assert.equal(f.orderRow(later[1]).status,'cancelled');assert.equal(f.orderRow(f.id).status,'approved');
 const pending=(await readWholesale(f.db,f.users.supply,indonesiaDate().slice(0,7))).orders.find(o=>o.id===f.id);
 assert.match(pending.workflow.expiredReviewReason,/财务记录或付款凭证/);
 assert((await wholesaleTasks(f.db,f.users.supply)).some(task=>task.entity===f.id&&task.title==='核对到期锁库及未付款订单'));
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='wholesale.reservation.expired'").get().n,2);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='wholesale.reservation.expired' AND entity_id=?").get(f.id).n,0);
 assert.equal(f.sqlite.prepare("SELECT SUM(qty) n,SUM(reserved_qty) reserved FROM inventory_balances WHERE site='印尼' AND sku='BAG-A'").get().n,20);
 assert.equal(f.sqlite.prepare("SELECT SUM(reserved_qty) n FROM inventory_balances WHERE site='印尼' AND sku='BAG-A'").get().n,5);
});
test('confirmation export is not release and instruction export rechecks current money and exact version',async()=>{
 const f=await setup();await f.approve();let snapshot=await loadWholesaleExportSnapshot(f.db,f.users.sales);const options={orderId:f.id,version:f.orderRow(f.id).version};
 assert.match(warehouseSheets(snapshot,{...options,mode:'confirmation'})[0].note,/不是出库/);assert.throws(()=>warehouseSheets(snapshot,{...options,mode:'instruction'}),/客户|正式/);
 await f.confirm();await f.receipt();snapshot=await loadWholesaleExportSnapshot(f.db,f.users.supply);const sheets=warehouseSheets(snapshot,{...options,version:f.orderRow(f.id).version,mode:'instruction'});assert.match(sheets[0].title,/Instruksi/);const book=toWholesaleWorkbook(XLSX,sheets);const written=XLSX.read(XLSX.write(book,{type:'buffer'}),{type:'buffer'});assert.equal(written.SheetNames.length,2);assert.match(XLSX.utils.sheet_to_csv(written.Sheets[written.SheetNames[0]]),/Instruksi pengeluaran resmi/);assert.ok(sheets[0].rows.some(r=>r[1]===f.orderRow(f.id).order_no+'-OUT-01'));
});

test('a retained instruction cannot be exported as effective release after receipt reversal',async()=>{
 const f=await setup();await f.approve();await f.confirm();await f.receipt();
 const before=f.sqlite.prepare('SELECT * FROM wholesale_release_instructions WHERE order_id=?').get(f.id);
 const receipt=f.sqlite.prepare("SELECT id FROM wholesale_finance_entries WHERE order_id=? AND kind='receipt'").get(f.id);
 await f.change(f.users.finance,f.id,'financeReverse',{entryId:receipt.id,businessDate:indonesiaDate(),reference:'TEST-EXPORT-REVERSED',note:'TEST 错误回款冲正须暂停放货'});
 const snapshot=await loadWholesaleExportSnapshot(f.db,f.users.supply),order=snapshot.orders.find(o=>o.id===f.id),options={orderId:f.id,version:order.version};
 assert.equal(order.workflow.releaseInstruction.id,before.id);assert.match(order.workflow.releaseReason,/实际净到账尚未足额/);
 assert.throws(()=>warehouseSheets(snapshot,{...options,mode:'instruction'}),error=>error.status===409&&/实际净到账尚未足额/.test(error.message));
 // The confirmation remains clearly non-authorizing; immutable instruction facts remain available for audit.
 assert.match(warehouseSheets(snapshot,{...options,mode:'confirmation'})[0].note,/不是出库指令/);
 assert.deepEqual(f.sqlite.prepare('SELECT * FROM wholesale_release_instructions WHERE order_id=?').get(f.id),before);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM wholesale_shipments').get().n,0);
 await f.receipt();const recovered=await loadWholesaleExportSnapshot(f.db,f.users.supply);
 const sheets=warehouseSheets(recovered,{...options,version:f.orderRow(f.id).version,mode:'instruction'});
 assert.equal(sheets[0].name,'正式出库指令');assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM wholesale_release_instructions WHERE order_id=?').get(f.id).n,1);
});

test('distributor public ordering also creates version 2; finance cannot approve around supply review',async()=>{
 const f=await setup();
 const {storeInsert}=await import('../lib/distributor-accounts.mjs');
 const {manageDistributorLink,distributorIdentity,submitDistributorOrder}=await import('../lib/distributor-ordering.mjs');
 await storeInsert(f.db,f.c.id,f.users.admin,{approved:true}).run();
 const result=await manageDistributorLink(f.db,f.users.sales,{action:'issue',customerId:f.c.id,version:0});
 const identity=await distributorIdentity(f.db,'Bearer '+result.path.split('#')[1]);
 const placed=await submitDistributorOrder(f.db,identity,{requestId:crypto.randomUUID(),items:[{sku:'BAG-A',qty:2,version:1}]});
 const order=f.sqlite.prepare('SELECT * FROM wholesale_orders WHERE order_no=?').get(placed.orderNo);
 assert.equal(order.workflow_version,2);
 await assert.rejects(f.change(f.users.finance,order.id,'orderApprove',{supplyUserId:f.users.supply.id,stockBasisConfirmed:true}),/无权/);
 await f.change(f.users.supply,order.id,'orderApprove',{logisticsUserId:f.users.supply2.id,reservationExpiresAt:future(),stockBasisConfirmed:true,reason:'TEST 库存与现款结算'});
 await assert.rejects(f.change(f.users.supply,order.id,'orderShip',{}),/指定仓库/);
});
test('financial correction racing shipment and pending proof racing expiry roll back without stock loss',async()=>{
 const f=await setup();await f.approve();await f.confirm();await f.receipt();await f.assign();await f.pack();
 const batch=f.db.batch;let inject=true;
 f.db.batch=async statements=>{if(inject){inject=false;const e=f.sqlite.prepare("SELECT * FROM wholesale_finance_entries WHERE kind='receipt'").get();f.sqlite.prepare("INSERT INTO wholesale_finance_entries(id,order_id,kind,amount,reference,business_date,note,actor_id,created_at,reverses_id) VALUES ('TEST-RACE',?,'receipt_void',?,'TEST-RACE-REV',?,'TEST ONLY',?,?,?)").run(f.id,e.amount,indonesiaDate(),f.users.finance.id,new Date().toISOString(),e.id);f.sqlite.prepare('UPDATE wholesale_orders SET version=version+1 WHERE id=?').run(f.id);}return batch(statements);};
 await assert.rejects(f.ship(),/已变化/);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM wholesale_shipments').get().n,0);
 const g=await setup();await g.approve();const oldBatch=g.db.batch;let proof=true;
 g.db.batch=async statements=>{if(proof){proof=false;g.sqlite.prepare("INSERT INTO wholesale_files(id,order_id,object_key,name,content_type,size,actor_id,created_at,purpose) VALUES ('TEST-RACE-PROOF',?,'test/race','TEST.png','image/png',100,?,?,'finance')").run(g.id,g.users.finance.id,new Date().toISOString());}return oldBatch(statements);};
 const result=await expireWholesaleReservations(g.db,{now:new Date(Date.now()+2*86400000).toISOString()});assert.equal(result.conflicts,1);assert.equal(g.orderRow(g.id).status,'approved');assert.equal(g.sqlite.prepare("SELECT SUM(reserved_qty) n FROM inventory_balances WHERE site='印尼' AND sku='BAG-A'").get().n,5);
});
test('partial shipments require fresh pack photos; customer receipt belongs to responsible sales',async()=>{
 const f=await setup('credit');await f.approve();await f.confirm();await f.release();await f.assign();await f.pack();const oldPhoto=f.sqlite.prepare('SELECT pack_proof_json FROM wholesale_workflows WHERE order_id=?').get(f.id).pack_proof_json;
 const item=f.sqlite.prepare('SELECT id FROM wholesale_order_items WHERE order_id=?').get(f.id).id;
 await f.ship({items:[{itemId:item,qty:2}]});assert.equal(f.orderRow(f.id).status,'partial');await assert.rejects(f.ship({items:[{itemId:item,qty:3}]}),/打包/);
 await assert.rejects(f.change(f.users.supply2,f.id,'orderPack',{proofIds:JSON.parse(oldPhoto).map(f=>f.id)}),/尚未使用/);await f.pack();await f.ship({items:[{itemId:item,qty:3}]});
 const shipment=f.sqlite.prepare('SELECT id FROM wholesale_shipments WHERE order_id=? LIMIT 1').get(f.id).id;
 const confirmation={shipmentId:shipment,businessDate:indonesiaDate(),receiver:'TEST买家',proofRef:'TEST客户收货确认',receivedConfirmed:true};
 await assert.rejects(f.change(f.users.supply2,f.id,'customerReceiptConfirm',confirmation),/责任销售/);await f.change(f.users.sales,f.id,'customerReceiptConfirm',confirmation);
});

test('resubmission preserves original request idempotency when the order date is inherited',async()=>{
 const f=await setup();await f.change(f.users.supply,f.id,'orderReject',{reason:'TEST 商品需求待调整'});
 const p={action:'orderResubmit',orderId:f.id,version:f.orderRow(f.id).version,operationId:crypto.randomUUID(),saleType:'cash',settlementMode:'prepaid',items:[{sku:'BAG-A',qty:6,unitPrice:100000}],reason:'TEST 重新申请并继承原业务日期'};
 const a=await mutateWholesale(f.db,f.users.sales,p),b=await mutateWholesale(f.db,f.users.sales,p);assert.equal(a.id,b.id);assert.equal(b.replayed,true);assert.equal(f.orderRow(a.id).total_qty,6);
});
test('bank allocation issues one instruction only after complete verified funds and confirmed customer terms',async()=>{
 const f=await setup();await f.approve();await f.confirm();
 const bank=await f.call(f.users.finance,'bankReceiptCreate',{customerId:f.c.id,amount:500000,reference:'TEST-BANK-ALLOC',bankAccount:'TEST COMPANY ACCOUNT',businessDate:indonesiaDate(),note:'TEST 财务核对银行实际入账'});
 const allocate=amount=>f.call(f.users.finance,'bankReceiptAllocate',{receiptId:bank.id,version:f.sqlite.prepare('SELECT version FROM wholesale_bank_receipts WHERE id=?').get(bank.id).version,businessDate:indonesiaDate(),allocations:[{orderId:f.id,version:f.orderRow(f.id).version,amount}],note:'TEST 分配已核对银行到账'});
 await allocate(200000);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM wholesale_release_instructions').get().n,0);
 await allocate(300000);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM wholesale_release_instructions').get().n,1);
 const view=(await readWholesale(f.db,f.users.supply,indonesiaDate().slice(0,7))).orders[0];assert.equal(view.paid,500000);assert.equal(view.capabilities.assignWarehouse,true);
});
test('expired credit and consignment retain reservations; overdue tasks are scoped to responsible people',async()=>{
 const {wholesaleTasks}=await import('../lib/wholesale.mjs');const f=await setup('credit');await f.approve();
 assert.equal((await expireWholesaleReservations(f.db,{now:new Date(Date.now()+2*86400000).toISOString()})).released,0);
 f.sqlite.prepare("UPDATE wholesale_orders SET due_date='2020-01-01' WHERE id=?").run(f.id);
 const mine=await wholesaleTasks(f.db,f.users.sales),other=await wholesaleTasks(f.db,f.users.sales2);assert(mine.some(t=>t.title==='跟进本人客户账期逾期回款'));assert.equal(other.length,0);
 const supply=await wholesaleTasks(f.db,f.users.supply);assert(!supply.some(t=>t.title==='安排线下打包发货'));assert(!supply.some(t=>t.title==='跟进本人客户账期逾期回款'));
});

test('new customer requires an explicit short name; historical missing short names remain readable',async()=>{
 const f=await setup();const payload={action:'customerCreate',name:'TEST No abbreviation',contact:'TEST',phone:'080012345',city:'Jakarta',address:'TEST address',operationId:crypto.randomUUID()};
 await assert.rejects(mutateWholesale(f.db,f.users.sales,payload),/公司简称/);
 const created=await mutateWholesale(f.db,f.users.sales,{...payload,companyShortName:'TEST Explicit'});const c=f.sqlite.prepare('SELECT * FROM wholesale_customers WHERE id=?').get(created.id);assert.match(c.code,/^ID-[0-9]{6}$/);assert.equal(c.name,payload.name);assert.equal(c.company_short_name,'TEST Explicit');
 f.sqlite.prepare("UPDATE wholesale_customers SET company_short_name='' WHERE id=?").run(created.id);const view=await readWholesale(f.db,f.users.sales,indonesiaDate().slice(0,7));assert.equal(view.customers.find(c=>c.id===created.id).name,payload.name);
});

test('modern cancellation releases only unshipped reservations and keeps actual receipts awaiting a separate refund',async()=>{
 const f=await setup('credit');await f.approve();await f.confirm();await f.release();await f.receipt();await f.assign();await f.pack();await f.ship({items:[{itemId:f.sqlite.prepare('SELECT id FROM wholesale_order_items WHERE order_id=?').get(f.id).id,qty:2}]});
 for(const actor of [f.users.sales,f.users.supply])await assert.rejects(f.change(actor,f.id,'orderCloseRemainder',{reason:'TEST 客户取消未发余量'}),e=>e.status===403);
 await f.change(f.users.finance,f.id,'orderCloseRemainder',{reason:'TEST 客户确认不再需要未发余量'});
 const closed=(await readWholesale(f.db,f.users.finance,indonesiaDate().slice(0,7))).orders.find(o=>o.id===f.id);assert.equal(closed.status,'closed');assert.equal(closed.items[0].shipped_qty,2);assert.equal(closed.cancelled_amount,300000);assert.equal(closed.paid,500000);assert.equal(closed.refundDue,300000);assert.equal(closed.entries.filter(e=>e.kind==='refund').length,0);assert.equal(f.sqlite.prepare("SELECT SUM(reserved_qty) n FROM inventory_balances WHERE site='印尼'").get().n,0);
 const g=await setup();await g.approve();await g.receipt(100000);
 for(const actor of [g.users.sales,g.users.finance,g.users.supply])await assert.rejects(g.change(actor,g.id,'orderCancel',{reason:'TEST 已批单取消由管理员处理'}),e=>e.status===403);
 await g.change(g.users.admin,g.id,'orderCancel',{reason:'TEST 客户取消尚未发货订单'});const cancelled=(await readWholesale(g.db,g.users.finance,indonesiaDate().slice(0,7))).orders.find(o=>o.id===g.id);assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.paid,100000);assert.equal(cancelled.refundDue,100000);assert.equal(cancelled.entries.filter(e=>e.kind==='refund').length,0);assert.equal(g.sqlite.prepare("SELECT SUM(reserved_qty) n FROM inventory_balances WHERE site='印尼'").get().n,0);
});

test('rejected special-price orders resubmit without reusing the old approval and still require a fresh price exception',async()=>{
 const f=await setup();
 const requested=await f.call(f.users.sales,'priceRequestCreate',{customerId:f.c.id,sku:'BAG-A',qty:5,unitPrice:80000,reason:'TEST 原单客户特价'});await f.call(f.users.admin,'priceRequestDecide',{requestId:requested.id,version:1,decision:'approve',priceVersion:1,unitPrice:80000,validUntil:'2099-01-01',reason:'TEST 原单特价审核',priceExceptionConfirmed:true});
 const original=await f.call(f.users.sales,'orderCreate',{...f.payload,items:[{sku:'BAG-A',qty:5,unitPrice:80000,priceRequestId:requested.id}]});await f.change(f.users.supply,original.id,'orderReject',{reason:'TEST 客户调整数量重新送审'});
 const quote=f.sqlite.prepare('SELECT * FROM wholesale_price_requests WHERE id=?').get(requested.id);
 const revised=await f.change(f.users.sales,original.id,'orderResubmit',{reason:'TEST 数量改四件重新核价',settlementMode:'prepaid',contractReference:'TEST 客户新确认',dueDate:'',items:[{sku:'BAG-A',qty:'4',unitPrice:'80000',productColor:'',productSize:'',priceRequestId:''}]});
 assert.equal(f.orderRow(revised.id).status,'pending');assert.equal(f.orderRow(original.id).status,'cancelled');assert.deepEqual(f.sqlite.prepare('SELECT * FROM wholesale_price_requests WHERE id=?').get(requested.id),quote);assert.equal(f.sqlite.prepare('SELECT price_request_id FROM wholesale_order_items WHERE order_id=?').get(revised.id).price_request_id,null);
 await assert.rejects(f.change(f.users.supply,revised.id,'orderShip',{}),/指定仓库/);
 const approval={supplyUserId:f.users.supply.id,logisticsUserId:f.users.supply.id,reservationExpiresAt:future(),stockBasisConfirmed:true,reason:'TEST 重新审核库存及低于报价的原因'};
 await assert.rejects(f.change(f.users.supply,revised.id,'orderApprove',approval),/价格例外/);assert.equal(f.orderRow(revised.id).status,'pending');assert.equal(f.sqlite.prepare("SELECT SUM(reserved_qty) n FROM inventory_balances WHERE site='印尼'").get().n,0);
 await f.change(f.users.supply,revised.id,'orderApprove',{...approval,priceExceptionConfirmed:true});assert.equal(f.orderRow(revised.id).status,'approved');assert.deepEqual(f.sqlite.prepare('SELECT * FROM wholesale_price_requests WHERE id=?').get(requested.id),quote);
});

test('actual resubmit form without saleType preserves commercial metadata and the original website source',async()=>{
 const f=await setup('prepaid',{saleType:'clearance_cash',businessCode:'TEST-BUSINESS',invoiceRequired:true,note:'TEST 原商定业务备注'});
 const {receiveWebsiteInquiry,mutateWebsiteLead}=await import('../lib/website-leads.mjs');
 const {leadId}=await receiveWebsiteInquiry(f.db,{schemaVersion:1,source:'loongjump-website',externalId:'TEST-RESUBMIT-SOURCE',revision:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),status:'new',details:{topic:'Grosir',name:'TEST',company:'TEST 公司全称',contactType:'WhatsApp',contact:'+628123456789',city:'Jakarta',country:'Indonesia',items:[]}});
 const leadChange=(actor,action,p)=>mutateWebsiteLead(f.db,actor,{id:leadId,version:f.sqlite.prepare('SELECT version FROM website_leads WHERE id=?').get(leadId).version,operationId:crypto.randomUUID(),action,...p});
 await leadChange(f.users.admin,'assign',{ownerId:f.users.sales.id,reason:'TEST 明确询盘销售负责人'});
 await leadChange(f.users.sales,'convert',{customerId:f.c.id,identityConfirmed:true,reason:'TEST 核实询盘与已有客户一致'});
 // Model an existing source-linked order without changing source/customer identity.
 f.sqlite.prepare('UPDATE wholesale_orders SET website_lead_id=? WHERE id=?').run(leadId,f.id);
 await f.approve();await f.change(f.users.supply,f.id,'orderReturnToSales',{reason:'TEST 客户调整数量重新申请'});
 const next=await f.change(f.users.sales,f.id,'orderResubmit',{settlementMode:'credit',contractReference:'TEST 新账期条款',dueDate:due(),items:[{sku:'BAG-A',qty:8,unitPrice:100000}],reason:'TEST 数量由5调整至8'});
 const row=f.orderRow(next.id);
 assert.equal(row.sale_type,'clearance_cash');assert.equal(row.business_code,'TEST-BUSINESS');assert.equal(row.invoice_required,1);assert.equal(row.note,'TEST 原商定业务备注');assert.equal(row.website_lead_id,leadId);
 assert.equal(row.payment_terms,'credit');assert.equal(row.total_qty,8);assert.equal(row.status,'pending');assert.equal(f.orderRow(f.id).status,'cancelled');
 assert.equal(f.orderRow(f.id).total_qty,5);assert.equal(f.sqlite.prepare('SELECT settlement_mode FROM wholesale_workflows WHERE order_id=?').get(next.id).settlement_mode,'credit');
});

test('resubmit maps settlement mode explicitly and retains distributor portal visibility',async()=>{
 for(const [oldMode,newMode,expectedType] of [['prepaid','consignment','consignment'],['consignment','prepaid','cash']]){
  const f=await setup(oldMode);
  f.sqlite.prepare('INSERT INTO distributor_orders(order_id,customer_id,request_id,fingerprint) VALUES (?,?,?,?)').run(f.id,f.c.id,'TEST-PORTAL-SOURCE','TEST-ONLY');
  await f.change(f.users.supply,f.id,'orderReject',{reason:'TEST 结算方式需调整'});
  const next=await f.change(f.users.sales,f.id,'orderResubmit',{settlementMode:newMode,contractReference:'TEST 新结算约定',dueDate:due(),items:[{sku:'BAG-A',qty:6,unitPrice:100000}],reason:'TEST 按客户新约定重新申请'});
  assert.equal(f.orderRow(next.id).sale_type,expectedType);assert.equal(f.orderRow(next.id).payment_terms,newMode==='prepaid'?'prepaid':'credit');
  assert.equal(f.sqlite.prepare('SELECT customer_id FROM distributor_orders WHERE order_id=?').get(next.id).customer_id,f.c.id);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM distributor_orders').get().n,2);
 }
});

test('Nov 24 receipt and release cannot authorize a Nov 22 shipment',async(t)=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-22T02:00:00Z')});
 const f=await setup();await f.approve({reservationExpiresAt:'2026-12-01T00:00:00Z'});await f.confirm();
 t.mock.timers.setTime(Date.parse('2026-11-24T02:00:00Z'));
 await f.receipt();await f.assign();await f.pack();
 await assert.rejects(f.ship({businessDate:'2026-11-22'}),/不能早于客户确认或正式放货指令日期/);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM wholesale_shipments').get().n,0);
 assert.equal(f.sqlite.prepare("SELECT SUM(qty) n FROM inventory_balances WHERE site='印尼' AND sku='BAG-A'").get().n,20);
 await f.ship({businessDate:'2026-11-24'});assert.equal(f.orderRow(f.id).status,'completed');
});

test('prepaid shipment uses funds available on its business date even when a historical release survives reversal',async(t)=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-22T02:00:00Z')});
 const f=await setup();await f.approve({reservationExpiresAt:'2026-12-01T00:00:00Z'});await f.confirm();await f.receipt();
 const original=f.sqlite.prepare("SELECT id FROM wholesale_finance_entries WHERE order_id=? AND kind='receipt'").get(f.id);
 await f.change(f.users.finance,f.id,'financeReverse',{entryId:original.id,businessDate:'2026-11-22',reference:'TEST-REVERSE-22',note:'TEST 22日错误到账冲正'});
 t.mock.timers.setTime(Date.parse('2026-11-24T02:00:00Z'));await f.receipt();await f.assign();await f.pack();
 await assert.rejects(f.ship({businessDate:'2026-11-22'}),/截至出库业务日期的实际净到账不足/);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM wholesale_shipments').get().n,0);
 await f.ship({businessDate:'2026-11-24'});assert.equal(f.orderRow(f.id).status,'completed');
});

test('transaction rechecks dated net funds when reversal and a later replacement receipt race shipment',async(t)=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-22T02:00:00Z')});
 const f=await setup();await f.approve({reservationExpiresAt:'2026-12-01T00:00:00Z'});await f.confirm();await f.receipt();await f.assign();await f.pack();
 t.mock.timers.setTime(Date.parse('2026-11-24T02:00:00Z'));
 const batch=f.db.batch;let inject=true;
 f.db.batch=async statements=>{
  if(inject){inject=false;const e=f.sqlite.prepare("SELECT * FROM wholesale_finance_entries WHERE order_id=? AND kind='receipt'").get(f.id);
   const add=f.sqlite.prepare('INSERT INTO wholesale_finance_entries(id,order_id,kind,amount,reference,business_date,note,actor_id,created_at,reverses_id) VALUES (?,?,?,?,?,?,?,?,?,?)');
   add.run('TEST-CUTOFF-VOID',f.id,'receipt_void',e.amount,'TEST-CUTOFF-VOID','2026-11-22','TEST ONLY',f.users.finance.id,new Date().toISOString(),e.id);
   add.run('TEST-CUTOFF-LATER',f.id,'receipt',e.amount,'TEST-CUTOFF-LATER','2026-11-24','TEST ONLY',f.users.finance.id,new Date().toISOString(),null);
   // Keep the total net funds and order version unchanged: the dated SQL guard must catch this.
  }
  return batch(statements);
 };
 await assert.rejects(f.ship({businessDate:'2026-11-22'}),/已变化/);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM wholesale_shipments').get().n,0);
 assert.equal(f.sqlite.prepare("SELECT SUM(qty) n FROM inventory_balances WHERE site='印尼' AND sku='BAG-A'").get().n,20);
 assert.equal(f.sqlite.prepare("SELECT SUM(reserved_qty) n FROM inventory_balances WHERE site='印尼' AND sku='BAG-A'").get().n,5);
 await f.ship({businessDate:'2026-11-24'});assert.equal(f.orderRow(f.id).status,'completed');
});

test('reversed funds move phase and precise tasks back to release verification until actual funds recover',async()=>{
 const f=await setup();await f.approve();await f.confirm();await f.receipt();await f.assign();await f.pack();
 const view=async()=> (await readWholesale(f.db,f.users.supply2,indonesiaDate().slice(0,7))).orders.find(o=>o.id===f.id);
 const before=await view();assert.equal(before.workflow.phase,'shipping');assert.equal(before.workflow.releaseValid,true);
 const e=f.sqlite.prepare("SELECT id FROM wholesale_finance_entries WHERE order_id=? AND kind='receipt'").get(f.id);
 await f.change(f.users.finance,f.id,'financeReverse',{entryId:e.id,businessDate:indonesiaDate(),reference:'TEST-REVERSE-TASK',note:'TEST 错账冲正后重新核对'});
 const after=await view();assert.equal(after.workflow.phase,'release_pending');assert.equal(after.workflow.releaseValid,false);assert.equal(after.workflow.releaseInstruction.id,before.workflow.releaseInstruction.id);assert.equal(after.capabilities.ship,false);
 for(const actor of [f.users.supply,f.users.supply2])assert(!(await wholesaleTasks(f.db,actor)).some(t=>t.entity===f.id&&/派仓|打包|发货/.test(t.title)));
 const financeTasks=await wholesaleTasks(f.db,f.users.finance);assert(financeTasks.some(t=>t.entity===f.id&&t.title==='放货条件已变化，重新核对到账或结算依据'));
 await f.receipt();assert.equal((await view()).workflow.phase,'shipping');assert.equal((await view()).workflow.releaseValid,true);
 assert((await wholesaleTasks(f.db,f.users.supply2)).some(t=>t.entity===f.id&&t.title==='核对照片与运单后确认实际发货'));
});

test('sales reminders follow real payment and each shipment receipt, including revoked receipt',async()=>{
 const f=await setup();try{
  const reminders=async actor=>(await wholesaleTasks(f.db,actor)).filter(t=>t.entity===f.id);
  await f.approve();await f.confirm();
  assert((await reminders(f.users.sales)).some(t=>t.title==='跟进客户付款及财务到账核销'));
  assert(!(await reminders(f.users.sales2)).length);
  await f.receipt();assert(!(await reminders(f.users.sales)).some(t=>/跟进客户付款/.test(t.title)));
  await f.assign();await f.pack();await f.ship();
  const stock=f.sqlite.prepare('SELECT * FROM inventory_balances').all(),order=f.orderRow(f.id);
  assert((await reminders(f.users.sales)).some(t=>t.title==='确认线下订单客户签收'));
  assert(!(await reminders(f.users.supply2)).some(t=>t.title==='确认线下订单客户签收'));
  const shipment=f.sqlite.prepare('SELECT id FROM wholesale_shipments WHERE order_id=?').get(f.id);
  await f.change(f.users.sales,f.id,'customerReceiptConfirm',{shipmentId:shipment.id,businessDate:indonesiaDate(),receiver:'TEST 收件人',proofRef:'TEST 客户确认收到',receivedConfirmed:true});
  assert(!(await reminders(f.users.sales)).some(t=>t.title==='确认线下订单客户签收'));
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM inventory_balances').all(),stock);assert.equal(f.orderRow(f.id).status,order.status);
  const received=f.sqlite.prepare('SELECT id FROM wholesale_customer_receipts WHERE order_id=?').get(f.id);
  await f.change(f.users.sales,f.id,'customerReceiptRevoke',{receiptId:received.id,reason:'TEST 签收凭据选择错误'});
  assert((await reminders(f.users.sales)).some(t=>t.title==='确认线下订单客户签收'));
 }finally{f.sqlite.close();}
});

test('delivered credit keeps collection reminder until actual bank receipt',async()=>{
 const f=await setup('credit');try{
  await f.approve();await f.confirm();await f.release();await f.assign();await f.pack();await f.ship();
  const shipment=f.sqlite.prepare('SELECT id FROM wholesale_shipments WHERE order_id=?').get(f.id);
  await f.change(f.users.sales,f.id,'customerReceiptConfirm',{shipmentId:shipment.id,businessDate:indonesiaDate(),receiver:'TEST 收件人',proofRef:'TEST 签收',receivedConfirmed:true});
  const reminders=async()=> (await wholesaleTasks(f.db,f.users.sales)).filter(t=>t.entity===f.id);
  assert((await reminders()).some(t=>t.title==='跟进客户约定回款'));assert(!(await reminders()).some(t=>t.title==='确认线下订单客户签收'));
  await f.receipt();assert(!(await reminders()).some(t=>t.title==='跟进客户约定回款'));
 }finally{f.sqlite.close();}
});
