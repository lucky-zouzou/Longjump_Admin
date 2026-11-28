import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createBackup,restoreBackup,verifyArchive} from '../server/backup.mjs';
import {openDatabase} from '../server/storage.mjs';
import {fixture} from './fixtures.mjs';
import {mutateDomesticDistribution as mutate,readDomesticDistribution as read,domesticFinancialSummary,domesticToday,domesticDistributionTasks} from '../lib/domestic-distribution.mjs';
import {readDomesticBank} from '../lib/domestic-bank.mjs';
import {uploadDomesticFile} from '../lib/domestic-distribution-files.mjs';

function setup(){
 const f=fixture(),today=domesticToday(),u=f.users,factory={id:'test-factory',name:'TEST FACTORY',role:'工厂'};
 f.sqlite.prepare('INSERT INTO users(id,email,name,role,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(factory.id,'factory@test.local',factory.name,factory.role,today,today);
 const call=(a,action,p={})=>mutate(f.db,a,{action,...p,operationId:crypto.randomUUID()}),order=id=>f.sqlite.prepare('SELECT * FROM domestic_orders WHERE id=?').get(id),change=(a,id,action,p={})=>call(a,action,{orderId:id,version:order(id).version,...p});
 const files=new Map(),bucket={put:async(k,b)=>files.set(k,new Uint8Array(b)),delete:async k=>files.delete(k),get:async k=>files.has(k)?{body:new ReadableStream({start(c){c.enqueue(files.get(k));c.close();}})}:null},proof=async(o,purpose='finance',a=u.finance,extra={})=>uploadDomesticFile(f.db,bucket,a,{orderId:o,purpose,operationId:crypto.randomUUID(),file:new File(['%PDF-1.4\nTEST-ONLY '+(extra.content||crypto.randomUUID())],'test.pdf',{type:'application/pdf'}),...extra});
 const customer=async()=> (await call(u.supply,'customerCreate',{companyName:'TEST '+crypto.randomUUID(),companyShortName:'TEST CLIENT',contact:'TEST',phone:'TEST',address:'TEST ADDRESS'})).id;
 const create=async(c,price='4970.50',mode='prepaid')=>(await call(u.supply,'orderCreate',{customerId:c,businessDate:today,settlementMode:mode,dueDate:today,items:[{sku:'BAG-A',qty:1,unitPrice:price}]})).id;
 const approve=async(id,mode='prepaid')=>{await change(u.supply,id,'quoteConfirm',{proofId:(await proof(id,'quote',u.supply)).id,customerConfirmed:true});await change(u.supply,id,'contractSubmit',{proofId:(await proof(id,'contract',u.supply)).id,contractSigned:true,settlementMode:mode,dueDate:today,contractNumber:'TEST-'+id,contractTerms:'TEST ONLY',factoryUserId:factory.id});await change(u.admin,id,'contractDecide',{approved:true,reason:'TEST ONLY APPROVAL'});};
 const receipt=async(c,o,amount='5089.00',extra={})=>{const payload={customerId:c,amount,businessDate:today,bankReference:'TEST-'+crypto.randomUUID(),bankAccount:'TEST ACCOUNT',proofId:(await proof(o)).id,reason:'TEST BANK VERIFIED',actualConfirmed:true,...extra};return {id:(await call(u.finance,'bankReceiptCreate',payload)).id,payload};};
 const bank=async id=>(await readDomesticBank(f.db)).receipts.find(b=>b.id===id);
 const allocate=async(b,orders)=>call(u.finance,'bankAllocate',{receiptId:b,version:(await bank(b)).version,businessDate:today,reason:'TEST ALLOCATION',allocations:orders.map(([id,amount])=>({orderId:id,version:order(id).version,amount}))});
 const view=async id=>(await read(f.db,u.admin)).orders.find(o=>o.id===id);
 return {...f,bucket,u,factory,today,call,change,order,proof,customer,create,approve,receipt,bank,allocate,view};
}

test('5089 actual receipt settles 4970.50 order; 118.50 remains, cash counted once in finance and replay',async()=>{
 const f=setup();try{const c=await f.customer(),o=await f.create(c);await f.approve(o);const b=await f.receipt(c,o);await f.allocate(b.id,[[o,'4970.50']]);const bank=await f.bank(b.id);assert.equal(bank.unallocatedMinor,11850);assert.equal((await f.view(o)).financial.contractOutstandingMinor,0);
 const summary=await domesticFinancialSummary(f.db);assert.equal(summary.period.netCashMinor,508900);assert.equal(summary.balances.paidMinor,497050);assert.equal(summary.bank.totals.unallocatedMinor,11850);
 const p={action:'bankReceiptCreate',...b.payload,bankReference:'TEST REPLAY',operationId:crypto.randomUUID()};const one=await mutate(f.db,f.u.finance,p),two=await mutate(f.db,f.u.finance,p);assert.equal(one.id,two.id);assert.equal(two.replayed,true);
 await assert.rejects(f.call(f.u.finance,'bankReceiptCreate',b.payload),/银行流水已登记/);
 }finally{f.sqlite.close();}
});

test('bank cash can precede approval and split across same-customer orders; no cross-customer allocation or overdraft',async()=>{
 const f=setup();try{const c=await f.customer(),o=await f.create(c,'30'),o2=await f.create(c,'20'),other=await f.create(await f.customer(),'10');const b=await f.receipt(c,o,'70');await assert.rejects(f.allocate(b.id,[[o,'30']]),/批准合同/);await f.approve(o);await f.approve(o2);await f.approve(other);await assert.rejects(f.allocate(b.id,[[other,'1']]),/同一客户/);await assert.rejects(f.allocate(b.id,[[o,'31']]),/最多可核销/);await f.allocate(b.id,[[o,'30'],[o2,'20']]);assert.equal((await f.bank(b.id)).unallocatedMinor,2000);assert.equal((await domesticFinancialSummary(f.db)).period.receiptsMinor,7000);
 const o3=await f.create(c,'30');await f.approve(o3);await assert.rejects(f.allocate(b.id,[[o3,'21']]),/可用余额/);assert.equal((await f.view(o3)).financial.paidMinor,0);
 }finally{f.sqlite.close();}
});

test('cancel review freezes fulfillment, rejects self approval; unallocation preserves cash then refund reconciles',async()=>{
 const f=setup();try{const c=await f.customer(),o=await f.create(c,'50');await f.approve(o);const b=await f.receipt(c,o,'60');await f.allocate(b.id,[[o,'50']]);await f.change(f.u.supply,o,'orderCancelRequest',{reason:'TEST CUSTOMER CANCEL'});assert((await f.view(o)).cancelPending);await assert.rejects(f.allocate(b.id,[[o,'1']]),/取消审核/);await assert.rejects(f.change(f.u.finance,o,'releaseConfirm',{termsVerified:true,reason:'TEST'}),/取消审核/);await assert.rejects(f.change(f.u.supply,o,'orderCancelDecide',{approved:true,reason:'TEST'}),/无权/);await f.change(f.u.admin,o,'orderCancelDecide',{approved:true,reason:'TEST INDEPENDENT'});assert.equal(f.order(o).status,'cancelled');
 let bank=await f.bank(b.id);await f.call(f.u.finance,'bankUnallocate',{receiptId:b.id,version:bank.version,entryId:bank.allocations[0].id,businessDate:f.today,reason:'TEST CANCEL UNALLOCATE'});bank=await f.bank(b.id);assert.equal(bank.unallocatedMinor,6000);assert.equal((await domesticFinancialSummary(f.db)).period.netCashMinor,6000);
 const proof=(await f.proof(o)).id;await f.call(f.u.finance,'bankRefund',{receiptId:b.id,version:bank.version,amount:'60',businessDate:f.today,bankReference:'TEST REFUND',proofId:proof,actualConfirmed:true,reason:'TEST ACTUAL REFUND'});assert.equal((await f.bank(b.id)).unallocatedMinor,0);assert.equal((await domesticFinancialSummary(f.db)).period.netCashMinor,0);
 bank=await f.bank(b.id);await f.call(f.u.finance,'bankRefundReverse',{receiptId:b.id,version:bank.version,entryId:bank.events[0].id,businessDate:f.today,bankReference:'TEST REFUND CORRECTION',proofId:proof,actualConfirmed:true,reason:'TEST WRONG REFUND ENTRY'});assert.equal((await f.bank(b.id)).unallocatedMinor,6000);
 }finally{f.sqlite.close();}
});

test('proof linkage prevents duplicate cash and stays out of pending queue; same image warning is scoped',async()=>{
 const f=setup();try{const c=await f.customer(),o=await f.create(c),o2=await f.create(c);const submission=async(o)=>f.proof(o,'customer_payment',f.u.supply,{amount:'5089',claimedDate:f.today,customerReference:'TEST',content:'SAME IMAGE'});const s1=await submission(o),s2=await submission(o2);let d=await read(f.db,f.u.admin);assert.equal(d.orders.find(x=>x.id===o).paymentSubmissions[0].duplicateOrders.length,1);
 const b=await f.receipt(c,o,'5089',{submissionId:s1.id});await assert.rejects(f.receipt(c,o2,'5089',{submissionId:s2.id}),/相同付款图片/);await f.call(f.u.finance,'bankProofLink',{receiptId:b.id,version:(await f.bank(b.id)).version,submissionId:s2.id,reason:'TEST SAME PAYMENT'});d=await read(f.db,f.u.admin);assert.equal(d.summary.pendingPayments,0);assert.equal(d.bank.totals.receivedMinor,508900);assert.equal(d.orders.find(x=>x.id===o2).paymentSubmissions[0].status,'bank_confirmed');assert.equal((await read(f.db,f.u.supply2)).orders.length,0);assert.equal((await read(f.db,f.u.supply)).bank,null);
 }finally{f.sqlite.close();}
});

test('customer editing preserves old order snapshots, guards ownership/version, and new drafts can be voided',async()=>{
 const f=setup();try{const c=await f.customer(),o=await f.create(c),old=(await f.view(o)).customer,record=(await read(f.db,f.u.admin)).customers[0];const payload={customerId:c,version:record.version,companyName:record.company_name,companyShortName:'TEST NEW',contact:'TEST NEW CONTACT',phone:'TEST NEW',address:'TEST NEW ADDRESS',reason:'TEST CHANGE'};await assert.rejects(f.call(f.u.supply2,'customerUpdate',payload),/责任范围/);await f.call(f.u.supply,'customerUpdate',payload);await assert.rejects(f.call(f.u.supply,'customerUpdate',payload),/已变化/);assert.deepEqual((await f.view(o)).customer,old);const second=await f.create(c);assert.equal((await f.view(second)).customer.address,'TEST NEW ADDRESS');await f.change(f.u.supply,second,'orderVoid',{reason:'TEST DUPLICATE DRAFT'});assert.equal(f.order(second).status,'cancelled');assert.equal((await read(f.db,f.u.admin)).customerHistory.length,1);
 }finally{f.sqlite.close();}
});

test('stale/concurrent bank allocations and closed periods rollback all changes; non-finance cannot write cash',async()=>{
 const f=setup();try{const c=await f.customer(),o=await f.create(c,'50');await f.approve(o);const b=await f.receipt(c,o,'50');const payload={receiptId:b.id,version:1,businessDate:f.today,reason:'TEST',allocations:[{orderId:o,version:f.order(o).version,amount:'50'}]};await assert.rejects(f.call(f.u.admin,'bankAllocate',payload),/仅财务/);const original=f.db.batch;f.db.batch=async statements=>{f.sqlite.prepare('UPDATE domestic_bank_receipts SET version=version+1 WHERE id=?').run(b.id);return original(statements);};await assert.rejects(f.call(f.u.finance,'bankAllocate',payload),/已变化/);f.db.batch=original;assert.equal((await f.bank(b.id)).unallocatedMinor,5000);assert.equal((await f.view(o)).financial.paidMinor,0);
 f.sqlite.prepare("INSERT INTO finance_period_events(id,month,revision,status,snapshot_json,evidence,actor_id,created_at) VALUES(?,?,1,'closed','{}','TEST',?,?)").run('test-close',f.today.slice(0,7),f.u.admin.id,new Date().toISOString());await assert.rejects(f.allocate(b.id,[[o,'50']]),/关账/);assert.equal((await f.bank(b.id)).allocations.length,0);
 }finally{f.sqlite.close();}
});

test('receivable, unpaid contract and unsold consignment overdue classes remain separate; followup does not change due date',async()=>{
 const f=setup();try{const c=await f.customer(),o=await f.create(c,'50');await f.approve(o);f.sqlite.prepare('UPDATE domestic_orders SET due_date=? WHERE id=?').run('2026-01-01',o);let v=await f.view(o);assert.equal(v.financial.overdueKind,'payment');assert.equal(v.financial.overdueReceivableMinor,0);await f.change(f.u.supply,o,'collectionFollowup',{reason:'TEST CALLED CUSTOMER',nextDate:f.today});v=await f.view(o);assert.equal(v.due_date,'2026-01-01');assert.equal(v.followups.length,1);assert((await domesticDistributionTasks(f.db,f.u.supply)).some(t=>t.kind==='overdue'&&t.level==='amber'));
 }finally{f.sqlite.close();}
});

test('legacy refunds cannot consume allocated bank cash, and legacy reversals cannot borrow customer funds',async()=>{
 const f=setup();try{const c=await f.customer(),o=await f.create(c,'100');await f.approve(o);const proof=(await f.proof(o)).id;
 const finance={proofId:proof,businessDate:f.today,bankAccount:'TEST',actualConfirmed:true,reason:'TEST'};
 await f.change(f.u.finance,o,'financeConfirm',{...finance,amount:'40',bankReference:'LEGACY-RECEIPT'});
 const old=f.sqlite.prepare('SELECT id FROM domestic_finance_entries WHERE order_id=?').get(o).id;
 const b=await f.receipt(c,o,'60');await f.allocate(b.id,[[o,'60']]);await f.change(f.u.admin,o,'orderCancel',{reason:'TEST CANCEL'});
 await assert.rejects(f.change(f.u.finance,o,'financeRefund',{...finance,amount:'41',bankReference:'TOO-LARGE'}),/旧收款余额/);
 await f.change(f.u.finance,o,'financeRefund',{...finance,amount:'40',bankReference:'LEGACY-REFUND'});
 await assert.rejects(f.change(f.u.finance,o,'financeReverse',{...finance,entryId:old,bankReference:'WRONG-REVERSE'}),/已退款/);
 assert.equal((await f.view(o)).financial.paidMinor,6000);assert.equal((await domesticFinancialSummary(f.db)).period.netCashMinor,6000);
 const bank=await f.bank(b.id);await f.call(f.u.finance,'bankUnallocate',{receiptId:b.id,version:bank.version,entryId:bank.allocations[0].id,businessDate:f.today,reason:'TEST'});
 assert.equal((await f.view(o)).financial.paidMinor,0);assert.equal((await f.bank(b.id)).unallocatedMinor,6000);
 }finally{f.sqlite.close();}
});

test('consignment accepts actual bank cash before sale but only confirmed sold quantities may be allocated',async()=>{
 const f=setup();try{const c=await f.customer(),o=await f.create(c,'50','consignment');await f.approve(o,'consignment');const b=await f.receipt(c,o,'60');await assert.rejects(f.allocate(b.id,[[o,'1']]),/已售/);
 const item=f.sqlite.prepare('SELECT * FROM domestic_order_items WHERE order_id=?').get(o);
 await f.change(f.u.finance,o,'releaseConfirm',{termsVerified:true,reason:'TEST TERMS'});
 await f.change(f.factory,o,'pack',{items:[{itemId:item.id,qty:1}],sourceNo:'TEST-SOURCE',sourceProofId:(await f.proof(o,'source',f.factory)).id,proofId:(await f.proof(o,'packing',f.factory)).id,businessDate:f.today,domesticSourceConfirmed:true});
 const line=f.sqlite.prepare('SELECT * FROM domestic_pack_lines').get();await f.change(f.factory,o,'ship',{items:[{packLineId:line.id,qty:1}],proofId:(await f.proof(o,'shipment',f.factory)).id,businessDate:f.today,carrier:'TEST',trackingNo:'TEST-SHIP',handoverConfirmed:true});
 f.sqlite.prepare('UPDATE domestic_orders SET due_date=? WHERE id=?').run('2026-01-01',o);assert.equal((await f.view(o)).financial.overdueKind,'consignment');assert.equal((await f.view(o)).financial.receivableMinor,0);
 const shipment=f.sqlite.prepare('SELECT * FROM domestic_shipments').get(),sl=f.sqlite.prepare('SELECT * FROM domestic_shipment_lines').get();await f.change(f.u.supply,o,'receive',{shipmentId:shipment.id,items:[{shipmentLineId:sl.id,qty:1}],proofId:(await f.proof(o,'receipt',f.u.supply)).id,businessDate:f.today,receiver:'TEST',receivedConfirmed:true});
 await f.change(f.u.finance,o,'consignmentSale',{items:[{itemId:item.id,qty:1}],proofId:(await f.proof(o)).id,businessDate:f.today,soldConfirmed:true});assert.equal((await f.view(o)).financial.overdueKind,'receivable');
 await assert.rejects(f.allocate(b.id,[[o,'51']]),/最多可核销/);await f.allocate(b.id,[[o,'50']]);assert.equal((await f.bank(b.id)).unallocatedMinor,1000);assert.equal((await f.view(o)).financial.overdue,false);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM inventory_movements').get().n,0);
 }finally{f.sqlite.close();}
});

test('bank reversal is audited without rewriting cash history or permitting refunds after void',async()=>{
 const f=setup();try{const c=await f.customer(),o=await f.create(c,'50');await f.approve(o);const b=await f.receipt(c,o,'60');await f.allocate(b.id,[[o,'50']]);let bank=await f.bank(b.id);const payload={receiptId:b.id,businessDate:f.today,bankReference:'TEST-VOID',proofId:(await f.proof(o)).id,actualConfirmed:true,reason:'TEST CORRECTION'};
 await assert.rejects(f.call(f.u.finance,'bankVoid',{...payload,version:bank.version}),/解除全部分配/);await assert.rejects(f.call(f.u.finance,'bankRefund',{...payload,version:bank.version,amount:'11'}),/超过未分配余额/);
 await f.call(f.u.finance,'bankUnallocate',{receiptId:b.id,version:bank.version,entryId:bank.allocations[0].id,businessDate:f.today,reason:'TEST'});bank=await f.bank(b.id);await f.call(f.u.finance,'bankVoid',{...payload,version:bank.version});bank=await f.bank(b.id);assert.equal(bank.unallocatedMinor,0);assert.equal(bank.voidedMinor,6000);assert.equal((await domesticFinancialSummary(f.db)).period.netCashMinor,0);
 await assert.rejects(f.call(f.u.finance,'bankRefund',{...payload,version:bank.version,amount:'1'}),/已冲销/);assert.throws(()=>f.sqlite.prepare('DELETE FROM domestic_bank_events').run(),/immutable/);assert.throws(()=>f.sqlite.prepare('UPDATE domestic_bank_receipts SET amount_minor=1').run(),/immutable/);
 }finally{f.sqlite.close();}
});

test('cross-month allocation and refund retain original receipt month and closed snapshot',async()=>{
 const RealDate=Date;let f;const clock=iso=>{const ms=RealDate.parse(iso);globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[ms]));}static now(){return ms;}};};
 try{clock('2026-01-20T04:00:00Z');f=setup();const c=await f.customer(),o=await f.create(c,'50');await f.approve(o);const b=await f.receipt(c,o,'60');const january=await domesticFinancialSummary(f.db,{month:'2026-01'});assert.equal(january.period.netCashMinor,6000);assert.equal(january.bank.totals.unallocatedMinor,6000);
 f.sqlite.prepare("INSERT INTO finance_period_events(id,month,revision,status,snapshot_json,evidence,actor_id,created_at) VALUES('TEST-JAN','2026-01',1,'closed',?,'TEST',?,?)").run(JSON.stringify({domestic:january}),f.u.admin.id,new Date().toISOString());
 clock('2026-02-05T04:00:00Z');let bank=await f.bank(b.id);await f.call(f.u.finance,'bankAllocate',{receiptId:b.id,version:bank.version,businessDate:'2026-02-05',allocations:[{orderId:o,version:f.order(o).version,amount:'50'}],reason:'TEST FEB ALLOCATION'});bank=await f.bank(b.id);
 await f.call(f.u.finance,'bankRefund',{receiptId:b.id,version:bank.version,businessDate:'2026-02-05',amount:'10',bankReference:'FEB-REFUND',proofId:(await f.proof(o)).id,actualConfirmed:true,reason:'TEST FEB REFUND'});
 const historical=await domesticFinancialSummary(f.db,{month:'2026-01'}),feb=await domesticFinancialSummary(f.db,{month:'2026-02'});assert.deepEqual(historical.period,january.period);assert.deepEqual(historical.bank,january.bank);assert.equal(feb.period.receiptsMinor,0);assert.equal(feb.period.refundsMinor,1000);assert.equal(feb.balances.paidMinor,5000);assert.equal(feb.bank.totals.unallocatedMinor,0);assert.deepEqual(JSON.parse(f.sqlite.prepare("SELECT snapshot_json FROM finance_period_events WHERE id='TEST-JAN'").get().snapshot_json).domestic,january);
 }finally{globalThis.Date=RealDate;f?.sqlite.close();}
});

test('backup restores independent cash, allocation, proof links and customer change history together',async()=>{
 const f=setup(),root=mkdtempSync(join(tmpdir(),'lj-domestic-funds-'));let restored;
 try{const c=await f.customer(),o=await f.create(c,'50');await f.approve(o);const submission=await f.proof(o,'customer_payment',f.u.supply,{amount:'60',claimedDate:f.today,customerReference:'TEST'});const b=await f.receipt(c,o,'60',{submissionId:submission.id});await f.allocate(b.id,[[o,'50']]);
 const customer=(await read(f.db,f.u.admin)).customers[0];await f.call(f.u.supply,'customerUpdate',{customerId:c,version:customer.version,companyName:customer.company_name,companyShortName:'TEST CHANGED',contact:'TEST',phone:customer.phone,address:'TEST NEW',reason:'TEST AUDIT'});const before=await read(f.db,f.u.admin);
 const archive=join(root,'backup.tar');await createBackup({DB:f.db,WHOLESALE_FILES:f.bucket},archive);const manifest=await verifyArchive(archive);for(const name of ['domestic_bank_receipts','domestic_bank_proof_links','domestic_customer_versions'])assert(manifest.tables.some(t=>t.name===name&&t.count===1));
 await restoreBackup(archive,join(root,'restored'));restored=openDatabase(join(root,'restored','business.sqlite'));const after=await read(restored,f.u.admin);assert.deepEqual(after.bank,before.bank);assert.deepEqual(after.orders,before.orders);assert.deepEqual(after.customerHistory,before.customerHistory);
 }finally{restored?.sqlite.close();f.sqlite.close();rmSync(root,{recursive:true,force:true});}
});
