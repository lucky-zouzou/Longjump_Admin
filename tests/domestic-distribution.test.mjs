import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createBackup,restoreBackup,verifyArchive} from '../server/backup.mjs';
import {openDatabase,fileBucket} from '../server/storage.mjs';
import {fixture} from './fixtures.mjs';
import {mutateDomesticDistribution as mutate,readDomesticDistribution as read,domesticDistributionTasks,domesticFinancialSummary,cnyMinor,domesticToday} from '../lib/domestic-distribution.mjs';
import {uploadDomesticFile,readDomesticFile} from '../lib/domestic-distribution-files.mjs';

function domesticFixture(){
 const f=fixture(),factory={id:'dom-factory',name:'国内工厂甲',role:'工厂'},factory2={id:'dom-factory2',name:'国内工厂乙',role:'工厂'};
 for(const u of [factory,factory2])f.sqlite.prepare('INSERT INTO users(id,email,name,role,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(u.id,`${u.id}@test.local`,u.name,u.role,'2026-01-01','2026-01-01');
 const users={...f.users,factory,factory2},row=id=>f.sqlite.prepare('SELECT * FROM domestic_orders WHERE id=?').get(id),items=id=>f.sqlite.prepare('SELECT * FROM domestic_order_items WHERE order_id=?').all(id);
 const call=(actor,action,p={})=>mutate(f.db,actor,{action,...p,operationId:crypto.randomUUID()}),change=(actor,id,action,p={})=>call(actor,action,{orderId:id,version:row(id).version,...p});
 const files=new Map(),bucket={put:async(k,b)=>{files.set(k,new Uint8Array(b));},get:async k=>files.has(k)?{body:new ReadableStream({start(c){c.enqueue(files.get(k));c.close();}})}:null,delete:async k=>{files.delete(k);}};
 const proof=async(id,purpose,actor=users.supply)=>uploadDomesticFile(f.db,bucket,actor,{orderId:id,purpose,operationId:crypto.randomUUID(),file:new File(['%PDF-1.4\nTEST ONLY'],`${purpose}.pdf`,{type:'application/pdf'})});
 const create=async({who=users.supply,qty=5,unitPrice='10.25'}={})=>{const c=await call(who,'customerCreate',{companyName:'测试国内公司'+crypto.randomUUID(),companyShortName:'国内测试',contact:'TEST',phone:'TEST-ONLY',address:'TEST ONLY / 国内地址',supplyUserId:users.supply.id});return (await call(who,'orderCreate',{customerId:c.id,businessDate:'2026-01-01',items:[{sku:'BAG-A',qty,unitPrice}]})).id;};
 const contract=async(id,{mode='prepaid',releaseAmount='20.00',approver=users.admin}={})=>{const q=await proof(id,'quote');await change(users.supply,id,'quoteConfirm',{proofId:q.id,customerConfirmed:true});const c=await proof(id,'contract');await change(users.supply,id,'contractSubmit',{proofId:c.id,contractSigned:true,settlementMode:mode,releaseAmount,dueDate:'2026-02-01',factoryUserId:factory.id,contractNumber:'DOM-TEST-'+crypto.randomUUID(),contractTerms:'TEST ONLY 实际合同条款'});await change(approver,id,'contractDecide',{approved:true,reason:'TEST ONLY 核对客户合同'});};
 const pack=async(id,qty=5)=>{const source=await proof(id,'source',factory),packing=await proof(id,'packing',factory);await change(factory,id,'pack',{items:[{itemId:items(id)[0].id,qty}],sourceNo:'DOM-BATCH-'+crypto.randomUUID(),sourceProofId:source.id,proofId:packing.id,businessDate:'2026-01-02',domesticSourceConfirmed:true});return f.sqlite.prepare('SELECT l.* FROM domestic_pack_lines l JOIN domestic_packs p ON p.id=l.pack_id WHERE p.order_id=? ORDER BY p.created_at DESC').get(id);};
 const finance=async(id,amount='51.25')=>{const pr=await proof(id,'finance',users.finance);await change(users.finance,id,'financeConfirm',{amount,proofId:pr.id,businessDate:'2026-01-02',bankReference:'BANK-'+crypto.randomUUID(),bankAccount:'TEST COMPANY BANK',reason:'TEST ONLY 核对公司银行实际到账',actualConfirmed:true});return f.sqlite.prepare('SELECT * FROM domestic_finance_entries WHERE order_id=? ORDER BY rowid DESC').get(id);};
 const release=id=>change(users.finance,id,'releaseConfirm',{termsVerified:true,reason:'TEST ONLY 按实际合同及银行流水核对'});
 const ship=async(id,qty=5)=>{const line=f.sqlite.prepare('SELECT l.* FROM domestic_pack_lines l JOIN domestic_packs p ON p.id=l.pack_id WHERE p.order_id=? AND l.shipped_qty<l.qty ORDER BY p.created_at').get(id),pr=await proof(id,'shipment',factory);await change(factory,id,'ship',{items:[{packLineId:line.id,qty}],businessDate:'2026-01-03',carrier:'TEST CARRIER',trackingNo:'TEST TRACK '+crypto.randomUUID(),proofId:pr.id,handoverConfirmed:true});return f.sqlite.prepare('SELECT * FROM domestic_shipments WHERE order_id=? ORDER BY rowid DESC').get(id);};
 const receive=async(id,sh,qty)=>{const line=f.sqlite.prepare('SELECT * FROM domestic_shipment_lines WHERE shipment_id=?').get(sh.id),pr=await proof(id,'receipt');await change(users.supply,id,'receive',{shipmentId:sh.id,items:[{shipmentLineId:line.id,qty}],proofId:pr.id,businessDate:'2026-01-04',receiver:'TEST RECEIVER',receivedConfirmed:true});};
 const view=async(id,actor=users.admin)=>(await read(f.db,actor)).orders.find(o=>o.id===id);
 return {...f,users,row,items,call,change,proof,bucket,files,create,contract,pack,finance,release,ship,receive,view};
}

test('CNY decimal input is parsed exactly as integer cents and rejects foreign precision or non-numbers',()=>{
 assert.equal(cnyMinor('0.01'),1);assert.equal(cnyMinor('123.45'),12345);assert.equal(cnyMinor('10.2'),1020);
 for(const n of ['1.001','-1','1e2','NaN','0','1,000','Infinity'])assert.throws(()=>cnyMinor(n));
});

test('国内预付完整流程：报价合同、实际备货、财务到账放货、分批发货签收不触碰海外库存',async()=>{
 const f=domesticFixture();try{const stock=f.sqlite.prepare('SELECT * FROM inventory_balances ORDER BY site,channel,sku').all(),id=await f.create();assert.match(f.row(id).order_no,/CN.*\d{6}$/);await f.contract(id);await f.pack(id);
 await assert.rejects(f.ship(id,2),/财务放货/);await assert.rejects(f.change(f.users.supply,id,'financeConfirm',{amount:'51.25'}),/无权/);await f.finance(id);await f.release(id);
 const one=await f.ship(id,2);assert.equal((await f.view(id)).fulfillment.status,'partial_dispatched');const two=await f.ship(id,3);await f.receive(id,one,1);assert.equal((await f.view(id)).fulfillment.status,'partial_received');await f.receive(id,one,1);await f.receive(id,two,3);
 const v=await f.view(id);assert.equal(v.fulfillment.status,'delivered');assert.equal(v.financial.paidMinor,5125);assert.equal(v.financial.contractOutstandingMinor,0);assert.equal(v.items[0].unit_minor,1025);assert.equal(v.shipments.length,2);assert.equal(v.versions.length,2);assert.equal(v.shipments[0].shipment_no,`${v.order_no}-OUT-001`);assert.deepEqual(f.sqlite.prepare('SELECT * FROM inventory_balances ORDER BY site,channel,sku').all(),stock);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM inventory_movements').get().n,0);
 }finally{f.sqlite.close();}
});

test('赊销签收保持已交付待回款，逾期追踪和部分财务核销独立',async()=>{
 const f=domesticFixture();try{const id=await f.create();await f.contract(id,{mode:'credit'});await f.release(id);await f.pack(id);const sh=await f.ship(id);await f.receive(id,sh,5);let v=await f.view(id);assert.equal(v.fulfillment.status,'delivered');assert.equal(v.financial.paidMinor,0);assert.equal(v.financial.contractOutstandingMinor,5125);assert.equal(v.financial.receivableMinor,5125);assert.equal(v.financial.overdue,true);await f.finance(id,'20.00');v=await f.view(id);assert.equal(v.fulfillment.status,'delivered');assert.equal(v.financial.status,'partial');assert.equal(v.financial.contractOutstandingMinor,3125);
 }finally{f.sqlite.close();}
});

test('定金以明确金额放货；冲销真实核对错误后剩余发货重新受闸门约束',async()=>{
 const f=domesticFixture();try{const id=await f.create();await f.contract(id,{mode:'deposit',releaseAmount:'20.00'});await f.pack(id);await f.finance(id,'10.00');await assert.rejects(f.release(id),/未达到/);const e=await f.finance(id,'10.00');await f.release(id);await f.ship(id,2);
 const pr=await f.proof(id,'finance',f.users.finance);await f.change(f.users.finance,id,'financeReverse',{entryId:e.id,proofId:pr.id,businessDate:'2026-01-03',bankReference:'CORRECT-'+crypto.randomUUID(),bankAccount:'TEST COMPANY BANK',reason:'TEST ONLY 原到账记录错误，保留流水',actualConfirmed:true});await assert.rejects(f.ship(id,3),/财务放货/);assert.equal((await f.view(id)).fulfillment.shipped,2);assert.equal((await f.view(id)).financial.paidMinor,1000);await f.finance(id,'10.00');await f.release(id);await f.ship(id,3);
 }finally{f.sqlite.close();}
});

test('寄售发出和签收不生成销售应收，财务确认实际售出后才可收款',async()=>{
 const f=domesticFixture();try{const id=await f.create();await f.contract(id,{mode:'consignment'});await f.release(id);await f.pack(id);const sh=await f.ship(id);let v=await f.view(id);assert.equal(v.financial.soldMinor,0);assert.equal(v.financial.payableMinor,0);assert.equal(v.financial.receivableMinor,0);assert.equal(v.financial.status,'consignment_unsettled');await assert.rejects(f.finance(id,'1.00'),/超过/);await f.receive(id,sh,5);const pr=await f.proof(id,'finance',f.users.finance);await assert.rejects(f.change(f.users.finance,id,'consignmentSale',{items:[{itemId:f.items(id)[0].id,qty:6}],proofId:pr.id,businessDate:'2026-01-05',soldConfirmed:true}),/超过/);
 await f.change(f.users.finance,id,'consignmentSale',{items:[{itemId:f.items(id)[0].id,qty:2}],proofId:pr.id,businessDate:'2026-01-05',soldConfirmed:true});v=await f.view(id);assert.equal(v.financial.payableMinor,2050);await f.finance(id,'20.50');assert.equal((await f.view(id)).financial.contractOutstandingMinor,0);assert.equal(f.items(id)[0].received_qty-f.items(id)[0].sold_qty,3);
 }finally{f.sqlite.close();}
});

test('岗位范围、工厂商业脱敏、财务凭证隔离与非本人审批',async()=>{
 const f=domesticFixture();try{const id=await f.create();await f.contract(id);const pr=await f.proof(id,'finance',f.users.finance);assert.equal((await read(f.db,f.users.supply2)).orders.length,0);assert.equal((await read(f.db,f.users.factory2)).orders.length,0);await assert.rejects(f.change(f.users.factory2,id,'pack',{}),/责任范围/);await assert.rejects(read(f.db,f.users.sales),/无权/);
 const v=await f.view(id,f.users.factory);for(const key of ['financial','entries','versions','total_minor','contract_terms','settlement_mode'])assert.equal(Object.hasOwn(v,key),false);assert.equal(Object.hasOwn(v.items[0],'unit_minor'),false);assert.ok(!v.files.some(x=>x.purpose==='finance'||x.purpose==='contract'));await assert.rejects(readDomesticFile(f.db,f.bucket,f.users.factory,pr.id),/无权/);await assert.rejects(readDomesticFile(f.db,f.bucket,f.users.supply,pr.id),/无权/);await assert.rejects(f.change(f.users.admin,id,'financeConfirm',{amount:'1'}),/无权/);
 const own=await f.create({who:f.users.admin});await assert.rejects(f.contract(own,{approver:f.users.admin}),/不能审批自己的/);await f.change(f.users.finance,own,'contractDecide',{approved:true,reason:'TEST ONLY 独立审核'});assert.equal(f.row(own).status,'approved');
 }finally{f.sqlite.close();}
});

test('未备货合同退回重签保留原始快照，追加不允许直接修改发货明细',async()=>{
 const f=domesticFixture();try{const id=await f.create();await f.contract(id,{mode:'credit'});await f.release(id);await f.change(f.users.admin,id,'orderReturn',{reason:'TEST ONLY 客户变更数量'});assert.equal(f.row(id).released_at,null);await f.change(f.users.supply,id,'orderRevise',{items:[{sku:'BAG-A',qty:6,unitPrice:'12.30'}],reason:'TEST ONLY 客户确认新版报价'});assert.equal(f.row(id).total_minor,7380);await assert.rejects(f.release(id),/合同审批/);await f.contract(id,{mode:'credit'});const version=f.sqlite.prepare('SELECT * FROM domestic_order_versions WHERE order_id=? ORDER BY rowid').all(id);assert.equal(JSON.parse(version[0].snapshot_json).order.total_minor,5125);assert.equal(JSON.parse(version[0].snapshot_json).items[0].qty,5);await f.pack(id,6);await assert.rejects(f.change(f.users.admin,id,'orderReturn',{reason:'客户又追加'}),/另建订单/);await assert.rejects(f.change(f.users.supply,id,'orderRevise',{items:[{sku:'BAG-A',qty:8,unitPrice:'12.30'}],reason:'追加'}),/新建订单/);
 }finally{f.sqlite.close();}
});

test('业务事实幂等、同版并发发货、超装箱数量和多SKU错误保持原子性',async()=>{
 const f=domesticFixture();try{const id=await f.create();await f.contract(id,{mode:'credit'});await f.release(id);const pl=await f.pack(id),pr=await f.proof(id,'shipment',f.users.factory);const p={action:'ship',operationId:crypto.randomUUID(),orderId:id,version:f.row(id).version,items:[{packLineId:pl.id,qty:2}],proofId:pr.id,businessDate:'2026-01-03',carrier:'TEST',trackingNo:'TEST-ONE',handoverConfirmed:true};await mutate(f.db,f.users.factory,p);assert.equal((await mutate(f.db,f.users.factory,p)).replayed,true);await assert.rejects(mutate(f.db,f.users.factory,{...p,operationId:crypto.randomUUID()}),/已被其他人更新/);await assert.rejects(f.ship(id,4),/超出/);assert.equal(f.items(id)[0].shipped_qty,2);
 const original=f.db.batch;let injected=false;f.db.batch=async statements=>{if(!injected&&statements[0]?.sql?.includes('domestic_operations')){injected=true;f.sqlite.prepare('UPDATE domestic_orders SET version=version+1 WHERE id=?').run(id);}return original(statements);};await assert.rejects(f.change(f.users.factory,id,'ship',{items:[{packLineId:pl.id,qty:3}],proofId:pr.id,businessDate:'2026-01-03',carrier:'TEST',trackingNo:'TEST-TWO',handoverConfirmed:true}),/已变化/);assert.equal(f.items(id)[0].shipped_qty,2);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM domestic_shipments WHERE order_id=?').get(id).n,1);
 }finally{f.sqlite.close();}
});

test('取消保留到账审计，财务按实退金额退款；非财务及重复流水不生效',async()=>{
 const f=domesticFixture();try{const id=await f.create();await f.contract(id);await f.finance(id,'20.00');await f.change(f.users.admin,id,'orderCancel',{reason:'TEST ONLY 客户取消'});const pr=await f.proof(id,'finance',f.users.finance);const p={action:'financeRefund',orderId:id,version:f.row(id).version,operationId:crypto.randomUUID(),amount:'20.00',proofId:pr.id,businessDate:'2026-01-03',bankReference:'TEST-REFUND-ONE',bankAccount:'TEST COMPANY BANK',reason:'TEST ONLY 公司银行实际退款',actualConfirmed:true};await assert.rejects(mutate(f.db,f.users.supply,p),/无权/);await mutate(f.db,f.users.finance,p);assert.equal((await mutate(f.db,f.users.finance,p)).replayed,true);assert.equal((await f.view(id)).financial.paidMinor,0);assert.equal((await f.view(id)).financial.refundDueMinor,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM domestic_finance_entries WHERE order_id=?').get(id).n,2);assert.throws(()=>f.sqlite.prepare('DELETE FROM domestic_finance_entries WHERE order_id=?').run(id),/immutable/);
 }finally{f.sqlite.close();}
});

test('真实凭证校验、跨订单凭证拒绝、未知币种及失效账号阻断',async()=>{
 const f=domesticFixture();try{const id=await f.create(),other=await f.create(),p=await f.proof(other,'quote');await assert.rejects(f.change(f.users.supply,id,'quoteConfirm',{proofId:p.id,customerConfirmed:true}),/属于本订单/);await assert.rejects(f.call(f.users.supply,'orderCreate',{currency:'IDR'}),/人民币/);
 await assert.rejects(uploadDomesticFile(f.db,f.bucket,f.users.supply,{orderId:id,purpose:'quote',operationId:crypto.randomUUID(),file:new File(['<script>bad</script>'],'bad.pdf',{type:'application/pdf'})}),/声明格式/);await assert.rejects(f.proof(id,'finance'),/不能上传/);f.sqlite.prepare('UPDATE users SET active=0 WHERE id=?').run(f.users.supply.id);await assert.rejects(f.change(f.users.supply,id,'quoteConfirm',{proofId:p.id,customerConfirmed:true}),/无权/);
 }finally{f.sqlite.close();}
});

test('来源批次不能重复登记；打包不是库存增账，维护锁禁止写入',async()=>{
 const f=domesticFixture();try{const id=await f.create();await f.contract(id);const p=await f.pack(id,2),source=f.sqlite.prepare('SELECT * FROM domestic_packs WHERE id=?').get(p.pack_id);await assert.rejects(f.change(f.users.factory,id,'pack',{items:[{itemId:f.items(id)[0].id,qty:2}],sourceNo:source.source_no,sourceProofId:source.source_proof_id,proofId:source.proof_id,businessDate:'2026-01-02',domesticSourceConfirmed:true}),/编号已使用/);assert.equal(f.items(id)[0].packed_qty,2);
 f.sqlite.prepare("INSERT INTO system_maintenance(id,mode,token_hash,actor_id,expires_at,updated_at) VALUES('global','backup','test',?,'2099-01-01','2026-01-01') ON CONFLICT(id) DO UPDATE SET mode='backup',expires_at='2099-01-01'").run(f.users.admin.id);await assert.rejects(f.change(f.users.finance,id,'releaseConfirm',{termsVerified:true,reason:'TEST'}),/备份/);
 }finally{f.sqlite.close();}
});


test('发货不能用较晚到账放行较早发货日期，旧版报价凭证不能重签新版',async()=>{
 const f=domesticFixture();try{const id=await f.create();const old=await f.proof(id,'quote');await f.change(f.users.supply,id,'orderRevise',{items:[{sku:'BAG-A',qty:5,unitPrice:'10.25'}],reason:'TEST ONLY 修订后重新确认'});await assert.rejects(f.change(f.users.supply,id,'quoteConfirm',{proofId:old.id,customerConfirmed:true}),/旧版订单/);await f.contract(id);const pack=await f.pack(id);const pr=await f.proof(id,'finance',f.users.finance);await f.change(f.users.finance,id,'financeConfirm',{amount:'51.25',proofId:pr.id,businessDate:'2026-01-05',bankReference:'TEST-LATER-PAYMENT',bankAccount:'TEST COMPANY BANK',reason:'TEST ONLY 较晚实际到账',actualConfirmed:true});await f.release(id);await assert.rejects(f.ship(id,5),/发货日期之前/);assert.equal(f.items(id)[0].shipped_qty,0);
 }finally{f.sqlite.close();}
});

test('国内合同、分批履约、签收、核销及凭证原文件全量备份恢复保持一致',async()=>{
 const f=domesticFixture(),root=mkdtempSync(join(tmpdir(),'lj-domestic-backup-'));let restored;
 try{const id=await f.create();await f.contract(id,{mode:'credit'});await f.release(id);await f.pack(id);const sh=await f.ship(id,2);await f.receive(id,sh,2);await f.finance(id,'10.00');const before=await f.view(id);
  const path=join(root,'backup.tar');await createBackup({DB:f.db,WHOLESALE_FILES:f.bucket},path);const manifest=await verifyArchive(path);assert.ok(manifest.tables.some(t=>t.name==='domestic_orders'&&t.count===1));assert.equal(manifest.files.length,f.files.size);
  const target=join(root,'restored');await restoreBackup(path,target);restored=openDatabase(join(target,'business.sqlite'));const after=(await read(restored,f.users.admin)).orders.find(o=>o.id===id);assert.deepEqual(after,before);assert.equal(restored.sqlite.prepare('PRAGMA foreign_key_check').all().length,0);assert.equal(restored.sqlite.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  const bucket=fileBucket(join(target,'files'));for(const [key,bytes] of f.files){const original=await bucket.get(key);assert.ok(original);assert.deepEqual(new Uint8Array(await new Response(original.body).arrayBuffer()),bytes);}assert.throws(()=>restored.sqlite.prepare('DELETE FROM domestic_receipts').run(),/immutable/);
 }finally{restored?.sqlite.close();f.sqlite.close();rmSync(root,{recursive:true,force:true});}
});


test('国内轻量待办按责任派发，审批不自审且到期回款优先，签收不清除财务待办',async()=>{
 const f=domesticFixture();try{const id=await f.create();assert.ok((await domesticDistributionTasks(f.db,f.users.supply)).some(t=>t.entity===id&&t.kind==='contract'));assert.equal((await domesticDistributionTasks(f.db,f.users.supply2)).length,0);assert.equal((await domesticDistributionTasks(f.db,f.users.sales)).length,0);await f.contract(id,{mode:'credit'});await f.release(id);await f.pack(id);assert.ok((await domesticDistributionTasks(f.db,f.users.factory)).some(t=>t.entity===id&&t.kind==='ship'));assert.equal((await domesticDistributionTasks(f.db,f.users.factory2)).length,0);const sh=await f.ship(id);assert.ok((await domesticDistributionTasks(f.db,f.users.supply)).some(t=>t.kind==='receipt'));await f.receive(id,sh,5);assert.ok(!(await domesticDistributionTasks(f.db,f.users.supply)).some(t=>t.kind==='receipt'));const todo=await domesticDistributionTasks(f.db,f.users.finance);assert.equal(todo[0].kind,'overdue');assert.equal(todo[0].level,'red');await f.finance(id);assert.ok(!(await domesticDistributionTasks(f.db,f.users.finance)).some(t=>t.entity===id));
 const own=await f.create({who:f.users.admin});await assert.rejects(f.contract(own,{approver:f.users.admin}),/自己的/);assert.ok(!(await domesticDistributionTasks(f.db,f.users.admin)).some(t=>t.entity===own&&t.kind==='review'));assert.ok((await domesticDistributionTasks(f.db,f.users.finance)).some(t=>t.entity===own&&t.kind==='review'));
 }finally{f.sqlite.close();}
});

const closeDomesticMonth=(f,month='2026-01')=>f.sqlite.prepare("INSERT INTO finance_period_events(id,month,revision,status,snapshot_json,evidence,actor_id,created_at) VALUES(?,?,1,'closed','{}','TEST ONLY',?,?)").run('close-'+crypto.randomUUID(),month,f.users.admin.id,new Date().toISOString());
test('国内真实收退款、冲正、实际发货和寄售已售均尊重中央关账，数据库也拒绝绕过',async()=>{
 const f=domesticFixture();try{
  const id=await f.create();await f.contract(id,{mode:'credit'});const receipt=await f.finance(id,'20.00');await f.release(id);const line=await f.pack(id),financeProof=await f.proof(id,'finance',f.users.finance),shipProof=await f.proof(id,'shipment',f.users.factory);
  const consignment=await f.create();await f.contract(consignment,{mode:'consignment'});await f.release(consignment);await f.pack(consignment);const sh=await f.ship(consignment);await f.receive(consignment,sh,5);const soldProof=await f.proof(consignment,'finance',f.users.finance);
  const cancelled=await f.create();await f.contract(cancelled);await f.finance(cancelled,'20.00');await f.change(f.users.admin,cancelled,'orderCancel',{reason:'TEST ONLY 取消退款'});const refundProof=await f.proof(cancelled,'finance',f.users.finance);await f.change(f.users.finance,cancelled,'financeRefund',{amount:'10.00',proofId:refundProof.id,businessDate:'2026-01-03',bankReference:'REF-'+crypto.randomUUID(),bankAccount:'TEST',reason:'TEST退款',actualConfirmed:true});const refund=f.sqlite.prepare("SELECT id FROM domestic_finance_entries WHERE order_id=? AND kind='refund'").get(cancelled);
  closeDomesticMonth(f);const common={proofId:financeProof.id,businessDate:'2026-01-06',bankReference:'CLOSED-'+crypto.randomUUID(),bankAccount:'TEST',reason:'TEST ONLY',actualConfirmed:true};
  for(const [oid,action,more] of [[id,'financeConfirm',{amount:'1.00'}],[id,'financeReverse',{entryId:receipt.id}],[cancelled,'financeRefund',{amount:'1.00',proofId:refundProof.id}],[cancelled,'financeRefundReverse',{entryId:refund.id,proofId:refundProof.id}]])await assert.rejects(f.change(f.users.finance,oid,action,{...common,...more}),/关账/);
  await assert.rejects(f.change(f.users.factory,id,'ship',{items:[{packLineId:line.id,qty:1}],proofId:shipProof.id,businessDate:'2026-01-06',carrier:'TEST',trackingNo:'TEST',handoverConfirmed:true}),/关账/);
  await assert.rejects(f.change(f.users.finance,consignment,'consignmentSale',{items:[{itemId:f.items(consignment)[0].id,qty:1}],proofId:soldProof.id,businessDate:'2026-01-06',soldConfirmed:true}),/关账/);
  assert.throws(()=>f.sqlite.prepare("INSERT INTO domestic_finance_entries(id,order_id,kind,amount_minor,business_date,bank_reference,bank_account,related_id,proof_id,reason,actor_id,created_at) SELECT 'raw-bypass',order_id,'receipt',1,'2026-01-07','RAW-BYPASS',bank_account,NULL,proof_id,reason,actor_id,created_at FROM domestic_finance_entries WHERE id=?").run(receipt.id),/closed finance period/);
  assert.equal(f.items(id)[0].shipped_qty,0);assert.equal(f.items(consignment)[0].sold_qty,0);
 }finally{f.sqlite.close();}
});

test('中央关账与国内收款、发货、寄售已售并发时整笔回滚，无半写金额或数量',async()=>{
 for(const action of ['financeConfirm','ship','consignmentSale']){const f=domesticFixture();try{const id=await f.create();await f.contract(id,{mode:action==='consignmentSale'?'consignment':'credit'});await f.release(id);const pl=await f.pack(id);if(action==='consignmentSale'){const sh=await f.ship(id);await f.receive(id,sh,5);}const proof=await f.proof(id,action==='ship'?'shipment':'finance',action==='ship'?f.users.factory:f.users.finance);
  const before=f.items(id)[0],version=f.row(id).version,original=f.db.batch;let raced=false;f.db.batch=async ss=>{if(!raced&&ss[0]?.sql?.includes('domestic_operations')){raced=true;closeDomesticMonth(f);}return original(ss);};
  const p=action==='ship'?{items:[{packLineId:pl.id,qty:1}],carrier:'TEST',trackingNo:'TEST',handoverConfirmed:true}:action==='consignmentSale'?{items:[{itemId:before.id,qty:1}],soldConfirmed:true}:{amount:'1.00',bankReference:'RACE-'+crypto.randomUUID(),bankAccount:'TEST',reason:'TEST ONLY',actualConfirmed:true};
  await assert.rejects(f.change(action==='ship'?f.users.factory:f.users.finance,id,action,{...p,proofId:proof.id,businessDate:'2026-01-06'}),/已变化|关账/);assert.ok(raced);assert.deepEqual(f.items(id)[0],before);assert.equal(f.row(id).version,version);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM domestic_finance_entries WHERE order_id=?').get(id).n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM domestic_consignment_sales WHERE order_id=?').get(id).n,0);
 }finally{f.sqlite.close();}}
});

test('国内资金摘要按截止日还原审批和事实，跨月收款、冲正、取消不倒灌，寄售未售单列',async()=>{
 const RealDate=Date,at=s=>{globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[s]));}static now(){return new RealDate(s).getTime();}};};let f;
 try{
  at('2026-01-02T02:00:00Z');f=domesticFixture();const a=await f.create();await f.contract(a,{mode:'credit'});await f.release(a);await f.pack(a);const firstReceipt=await f.finance(a,'20.00');const b=await f.create();await f.contract(b,{mode:'consignment'});await f.release(b);await f.pack(b);const d=await f.create();await f.contract(d,{mode:'credit'});
  at('2026-01-03T02:00:00Z');await f.ship(a,2);const sb=await f.ship(b,5);at('2026-01-04T02:00:00Z');await f.receive(b,sb,5);at('2026-01-05T02:00:00Z');const bp=await f.proof(b,'finance',f.users.finance);await f.change(f.users.finance,b,'consignmentSale',{items:[{itemId:f.items(b)[0].id,qty:2}],proofId:bp.id,businessDate:'2026-01-05',soldConfirmed:true});await f.finance(b,'10.00');at('2026-01-31T03:00:00Z');const jan=await domesticFinancialSummary(f.db,{month:'2026-01'});
  assert.equal(jan.currency,'CNY');assert.equal(jan.unit,'minor');assert.equal(jan.cutoff,'2026-01-31');assert.equal(jan.period.netCashMinor,3000);assert.equal(jan.balances.contractMinor,15375);assert.equal(jan.balances.contractOutstandingMinor,9300);assert.equal(jan.balances.receivableMinor,1100);assert.equal(jan.balances.consignmentUnsettledQty,3);assert.equal(jan.balances.consignmentUnsettledMinor,3075);assert.equal(jan.period.shippedMinor,7175);assert.equal(jan.period.consignmentSoldMinor,2050);
  at('2026-02-02T02:00:00Z');await f.change(f.users.admin,d,'orderCancel',{reason:'TEST ONLY 二月取消不得影响一月'});const ap=await f.proof(a,'finance',f.users.finance);await f.change(f.users.finance,a,'financeConfirm',{amount:'31.25',proofId:ap.id,businessDate:'2026-02-02',bankReference:'FEB-PAY',bankAccount:'TEST',reason:'TEST二月到账',actualConfirmed:true});
  at('2026-02-03T02:00:00Z');await f.change(f.users.finance,a,'financeReverse',{entryId:firstReceipt.id,proofId:ap.id,businessDate:'2026-02-03',bankReference:'FEB-REVERSE',bankAccount:'TEST',reason:'TEST二月纠正',actualConfirmed:true});
  const again=await domesticFinancialSummary(f.db,{month:'2026-01'});assert.deepEqual(again.balances,jan.balances);assert.deepEqual(again.period,jan.period);assert.deepEqual(again.rows,jan.rows);
  const feb=await domesticFinancialSummary(f.db,{month:'2026-02'});assert.equal(feb.period.receiptsMinor,3125);assert.equal(feb.period.receiptReversalsMinor,2000);assert.equal(feb.period.netCashMinor,1125);assert.equal(feb.balances.contractMinor,10250);assert.equal(feb.balances.contractOutstandingMinor,3050);assert.equal(feb.balances.consignmentUnsettledQty,3);assert.equal(feb.rows.find(r=>r.id===a).paidMinor,3125);assert.equal(feb.rows.find(r=>r.id===b).receivableMinor,1050);
  await assert.rejects(domesticFinancialSummary(f.db,{month:'2026-13'}),/月份/);await assert.rejects(domesticFinancialSummary(f.db,{month:'2026-03'}),/月份/);
 }finally{globalThis.Date=RealDate;f?.sqlite.close();}
});
