import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {manageStore,authenticateDistributor,distributorSession} from '../lib/distributor-accounts.mjs';
import {readDistribution,mutateDistribution,distributionTasks} from '../lib/distribution-management.mjs';
import {handleDistributor} from '../lib/distributor-http.mjs';
import {manageDistributorLink,submitDistributorOrder} from '../lib/distributor-ordering.mjs';
import {submitDistributorPayment,distributorPayments} from '../lib/distributor-payments.mjs';
import {indonesiaDate} from '../lib/wholesale.mjs';
const root='https://mitra.example.test',password='Synthetic-only-passphrase-1113';
const store=(f,id)=>f.sqlite.prepare('SELECT * FROM distributor_stores WHERE customer_id=?').get(id);
async function enroll(f,a=f.users.indonesia){return (await mutateDistribution(f.db,a,{action:'create',operationId:crypto.randomUUID(),name:'Test '+crypto.randomUUID(),contact:'Rani',phone:'0812345678',city:'Jakarta',address:'TEST ONLY Jl. 1',salesUserId:a.id})).id;}
async function activate(f,id){const s=store(f,id),invite=await manageStore(f.db,f.users.admin,{action:'approve',customerId:id,version:s.version,reason:'TEST ONLY 审核真实资料'}),q=new URLSearchParams(invite.activationPath.split('#')[1]);const auth=await authenticateDistributor(f.db,{username:invite.username,password,activation:q.get('activate')});return {...auth,invite,cookie:'lj_distributor='+auth.token,identity:await distributorSession(f.db,new Request(root+'/api/distributor',{headers:{cookie:'lj_distributor='+auth.token}}))};}
function request(auth,path='/api/distributor',body,extra={}){return new Request(root+path,{method:body?'POST':'GET',headers:{cookie:auth?.cookie||'',origin:root,...(body instanceof FormData?{}:{'Content-Type':'application/json'}),...extra},...(body?{body:body instanceof FormData?body:JSON.stringify(body)}:{})});}
const basket=(qty=3)=>({requestId:crypto.randomUUID(),items:[{sku:'BAG-A',qty,version:1}]});
const bucket=()=>{const objects=new Map();return {objects,put:async(k,v)=>objects.set(k,v),delete:async k=>objects.delete(k),get:async k=>objects.has(k)?{body:objects.get(k)}:null};};
async function order(f,auth){const result=await submitDistributorOrder(f.db,auth.identity,basket());return f.sqlite.prepare('SELECT * FROM wholesale_orders WHERE order_no=?').get(result.orderNo);}
const proof=(no,requestId=crypto.randomUUID())=>{const f=new FormData();for(const [k,v] of Object.entries({orderNo:no,amount:'300000',reference:'TEST BANK 1113',businessDate:indonesiaDate(),requestId}))f.set(k,v);f.set('evidence',new File(['%PDF-1.7 TEST ONLY'],'proof.pdf',{type:'application/pdf'}));return f;};

test('运营建档自动产生独立账号，管理员审核后一次激活；密码与会话不出现在管理返回中',async()=>{
 const f=fixture(),id=await enroll(f);const s=store(f,id);assert.equal(s.status,'pending');assert(s.slug&&s.username);assert.equal(s.password_hash,null);
 await assert.rejects(manageStore(f.db,f.users.indonesia,{action:'approve',customerId:id,version:s.version,reason:'禁止运营自审'}),{status:403});
 await assert.rejects(manageDistributorLink(f.db,f.users.indonesia,{action:'issue',customerId:id,version:0}),{status:403});
 await assert.rejects(authenticateDistributor(f.db,{username:s.username,password}),{status:401});
 const a=await activate(f,id);assert.notEqual(store(f,id).password_hash,password);assert.equal(store(f,id).activation_hash,null);
 const oldToken=new URLSearchParams(a.invite.activationPath.split('#')[1]).get('activate');await assert.rejects(authenticateDistributor(f.db,{username:s.username,password,activation:oldToken}),{status:401});
 const login=await handleDistributor(request(null,'/api/distributor?auth=login',{username:s.username,password}),f.db);
 assert.equal(login.status,200);assert.match(login.headers.get('set-cookie'),/HttpOnly.*SameSite=Strict.*Secure/);assert.equal((await login.json()).token,undefined);
 const summary=await readDistribution(f.db,f.users.admin);assert(!JSON.stringify(summary).includes(store(f,id).password_hash));assert(!JSON.stringify(summary).includes(a.token));assert.equal(summary.stores[0].activated,1);
 await handleDistributor(request(a,'/api/distributor?auth=logout',{}),f.db);await assert.rejects(distributorSession(f.db,request(a)),{status:401});
});

test('不同商家的订单、店铺链接与内部账号隔离；停用和重置立即阻止旧会话写入',async()=>{
 const f=fixture(),id=await enroll(f),id2=await enroll(f,f.users.sales2),a=await activate(f,id),b=await activate(f,id2);
 const placed=await order(f,a);assert.equal(placed.sales_user_id,f.users.indonesia.id);assert.equal(placed.creator_id,'distributor:'+id);
 assert.equal((await (await handleDistributor(request(b),f.db)).json()).orders.length,0);
 assert.equal((await handleDistributor(request(b,'/api/distributor?store='+a.store),f.db)).status,403);
 assert.equal((await handleDistributor(request(null,'/api/distributor',undefined,{'oai-authenticated-user-id':'admin-1',cookie:'lj_session=fake'}),f.db)).status,401);
 assert.equal((await handleDistributor(request(a,'/api/distributor',basket(),{origin:'https://evil.test'}),f.db)).status,403);
 await manageStore(f.db,f.users.admin,{action:'suspend',customerId:id,version:store(f,id).version,reason:'TEST ONLY 停用商家'});
 await assert.rejects(submitDistributorOrder(f.db,a.identity,basket()));assert.equal((await handleDistributor(request(a),f.db)).status,401);
 assert.equal((await handleDistributor(request(b),f.db)).status,200);
 await manageStore(f.db,f.users.admin,{action:'invite',customerId:id2,version:store(f,id2).version,reason:'TEST ONLY 重置密码'});
 await assert.rejects(authenticateDistributor(f.db,{username:b.username,password}),{status:401});
 await assert.rejects(submitDistributorOrder(f.db,b.identity,basket()));
});

test('商家上传不自动回款、不重复建凭证，财务依据实际到账核销并复用原出库链路',async()=>{
 const f=fixture(),a=await activate(f,await enroll(f)),o=await order(f,a),files=bucket();
 await assert.rejects(submitDistributorPayment(f.db,files,a.identity,proof(o.order_no)),{status:409});
 await f.change(f.users.finance,o.id,'orderApprove',{supplyUserId:f.users.supply.id,stockBasisConfirmed:true,reason:'TEST ONLY 核对库存'});
 const req=crypto.randomUUID(),p1=await submitDistributorPayment(f.db,files,a.identity,proof(o.order_no,req)),p2=await submitDistributorPayment(f.db,files,a.identity,proof(o.order_no,req));assert.equal(p1.id,p2.id);assert.equal(p2.replayed,true);assert.equal(files.objects.size,1);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM wholesale_finance_entries').get().n,0);await assert.rejects(f.ship(o.id,3));
 const bad=proof(o.order_no,req);bad.set('amount','2');await assert.rejects(submitDistributorPayment(f.db,files,a.identity,bad),{status:409});
 const pay=f.sqlite.prepare('SELECT * FROM distributor_payments').get(),confirm={action:'paymentConfirm',id:pay.id,version:pay.version,amount:300000,reference:'TEST BANK ACTUAL',businessDate:indonesiaDate(),note:'TEST ONLY 已核对对公账户到账',operationId:crypto.randomUUID()};
 await assert.rejects(mutateDistribution(f.db,f.users.indonesia,confirm),{status:403});
 await mutateDistribution(f.db,f.users.finance,confirm);assert.equal((await mutateDistribution(f.db,f.users.finance,confirm)).replayed,true);await assert.rejects(mutateDistribution(f.db,f.users.finance,{...confirm,operationId:crypto.randomUUID()}),{status:409});
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM wholesale_finance_entries').get().n,1);assert.equal((await distributorPayments(f.db,a.identity)).submissions[0].state,'verified');
 await f.ship(o.id,3);const ws=await (await handleDistributor(request(a),f.db)).json();assert.equal(ws.orders[0].status,'completed');assert.equal(ws.orders[0].shipments[0].tracking,'TEST-TRACK');
 const report=await readDistribution(f.db,f.users.finance);assert.equal(report.stores[0].net_receipts,300000);assert.equal(report.stores[0].delivered_qty,3);
});

test('结算附件限制商家归属、文件签名，退回与核销不可竞争覆盖',async()=>{
 const f=fixture(),a=await activate(f,await enroll(f)),b=await activate(f,await enroll(f,f.users.sales2)),o=await order(f,a),files=bucket();
 await f.change(f.users.finance,o.id,'orderApprove',{supplyUserId:f.users.supply.id,stockBasisConfirmed:true,reason:'TEST ONLY 库存核对'});
 await assert.rejects(submitDistributorPayment(f.db,files,b.identity,proof(o.order_no)),{status:404});
 const bad=proof(o.order_no);bad.set('evidence',new File(['<svg onload=alert(1)>'],'fake.png',{type:'image/png'}));await assert.rejects(submitDistributorPayment(f.db,files,a.identity,bad),{status:400});assert.equal(files.objects.size,0);
 const p=await submitDistributorPayment(f.db,files,a.identity,proof(o.order_no));await mutateDistribution(f.db,f.users.finance,{action:'paymentReject',id:p.id,version:1,reason:'Nomor rekening tidak sesuai'});
 await assert.rejects(mutateDistribution(f.db,f.users.finance,{action:'paymentConfirm',id:p.id,version:1,amount:300000,reference:'TEST',businessDate:indonesiaDate(),note:'旧版不允许核销',operationId:crypto.randomUUID()}),{status:409});
 assert.equal((await distributorPayments(f.db,a.identity)).submissions[0].state,'rejected');
});

test('分销汇总和任务不计普通线下订单；运营只看本人商家，财务无准入审核权',async()=>{
 const f=fixture(),id=await enroll(f),other=await enroll(f,f.users.sales2),a=await activate(f,id);await order(f,a);await f.create();
 const d=await readDistribution(f.db,f.users.indonesia);assert.deepEqual(d.stores.map(s=>s.customer_id),[id]);assert.equal((await readDistribution(f.db,f.users.admin,{section:'orders'})).orders.length,1);
 await assert.rejects(readDistribution(f.db,f.users.malaysia),{status:403});await assert.rejects(readDistribution(f.db,f.users.supply),{status:403});
 await assert.rejects(manageStore(f.db,f.users.finance,{action:'approve',customerId:other,version:1,reason:'财务不能批准准入'}),{status:403});
 assert((await distributionTasks(f.db,f.users.admin)).some(t=>t.tab==='distribution'&&t.title==='分销商家待审核'));assert.equal((await distributionTasks(f.db,f.users.indonesia)).length,0);
});

test('登录限速、过期激活和停用负责人不会产生有效会话',async()=>{
 const f=fixture(),id=await enroll(f),s=store(f,id);const invite=await manageStore(f.db,f.users.admin,{action:'approve',customerId:id,version:s.version,reason:'TEST ONLY 审核'}),activation=new URLSearchParams(invite.activationPath.split('#')[1]).get('activate');
 f.sqlite.prepare("UPDATE distributor_stores SET activation_expires_at='2000-01-01' WHERE customer_id=?").run(id);await assert.rejects(authenticateDistributor(f.db,{username:s.username,password,activation}),{status:401});
 for(let i=0;i<9;i++)await assert.rejects(authenticateDistributor(f.db,{username:s.username,password:'wrong-password-only'}));
 await assert.rejects(authenticateDistributor(f.db,{username:s.username,password}),{status:429});
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM distributor_sessions').get().n,0);
});


test('账号登录后的照片售后归入线下分销总表，冲正回款和月结限制对商家可见',async()=>{
 const f=fixture(),a=await activate(f,await enroll(f)),o=await order(f,a),files=bucket();
 await f.change(f.users.finance,o.id,'orderApprove',{supplyUserId:f.users.supply.id,stockBasisConfirmed:true,reason:'TEST ONLY 核对库存'});
 const p=await submitDistributorPayment(f.db,files,a.identity,proof(o.order_no));
 const confirm={action:'paymentConfirm',id:p.id,version:1,amount:300000,reference:'TEST-PAY-ACTUAL',businessDate:indonesiaDate(),note:'TEST ONLY 核对到账',operationId:crypto.randomUUID()};
 f.sqlite.prepare("INSERT INTO wholesale_finance_periods VALUES(?,'closed',1,'{}','TEST ONLY','finance-1',?)").run(indonesiaDate().slice(0,7),new Date().toISOString());
 await assert.rejects(mutateDistribution(f.db,f.users.finance,confirm));
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM wholesale_finance_entries').get().n,0);
 assert.equal(f.sqlite.prepare('SELECT version FROM distributor_payments WHERE id=?').get(p.id).version,1);
 f.sqlite.prepare("UPDATE wholesale_finance_periods SET status='open',version=2").run();
 await mutateDistribution(f.db,f.users.finance,confirm);await f.ship(o.id,3);
 const item=f.sqlite.prepare('SELECT id FROM wholesale_order_items WHERE order_id=?').get(o.id).id,fd=new FormData();
 for(const [k,v] of Object.entries({item,kind:'exchange',qty:'1',description:'Jahitan produk terlepas.',reason:'quality',requestId:crypto.randomUUID()}))fd.set(k,v);
 fd.set('evidence',new File([new Uint8Array([255,216,255,217])],'tas.jpg',{type:'image/jpeg'}));
 const r=await handleDistributor(request(a,'/api/distributor?service=1',fd),f.db,files);assert.equal(r.status,200,JSON.stringify(await r.json()));
 assert.equal(f.sqlite.prepare('SELECT channel FROM after_sales').get().channel,'线下分销');
 const entry=f.sqlite.prepare("SELECT id FROM wholesale_finance_entries WHERE kind='receipt'").get().id;
 await f.change(f.users.finance,o.id,'financeReverse',{entryId:entry,reference:'TEST-CORRECTION',businessDate:indonesiaDate(),note:'TEST ONLY 银行对账修正'});
 assert.equal((await distributorPayments(f.db,a.identity)).submissions[0].state,'reversed');
 assert.equal((await readDistribution(f.db,f.users.finance)).stores[0].net_receipts,0);
});

test('分销商家与凭证备份可恢复，历史会话和激活链接不能随恢复重新生效',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs'),{join}=await import('node:path'),{tmpdir}=await import('node:os');
 const {createBackup,restoreBackup,verifyArchive}=await import('../server/backup.mjs'),{openDatabase,fileBucket}=await import('../server/storage.mjs'),{backupStream}=await import('../lib/full-backup.mjs');
 const root=mkdtempSync(join(tmpdir(),'dist-backup-')),f=fixture();let restored;
 try{
  const id=await enroll(f),a=await activate(f,id),o=await order(f,a),files=fileBucket(join(root,'files'));
  await f.change(f.users.finance,o.id,'orderApprove',{supplyUserId:f.users.supply.id,stockBasisConfirmed:true,reason:'TEST ONLY 核对库存'});
  await submitDistributorPayment(f.db,files,a.identity,proof(o.order_no));
  const id2=await enroll(f,f.users.sales2);await manageStore(f.db,f.users.admin,{action:'approve',customerId:id2,version:1,reason:'TEST ONLY 备份激活链接'});
  await mutateDistribution(f.db,f.users.admin,{action:'salesContactSave',userId:f.users.indonesia.id,version:0,displayName:'Rani TEST',whatsapp:'+12025550123'});
  const locked=await backupStream(f.db,files,f.users.admin);
  assert.throws(()=>f.sqlite.prepare('UPDATE distributor_stores SET version=version+1').run(),/maintenance/);
  assert.throws(()=>f.sqlite.prepare('UPDATE distributor_payments SET version=version+1').run(),/maintenance/);await locked.cancel();
  const archive=join(root,'backup.tar');await createBackup({DB:f.db,WHOLESALE_FILES:files},archive);const manifest=await verifyArchive(archive);
  assert(!manifest.tables.some(t=>['distributor_sessions','distributor_login_attempts'].includes(t.name)));
  await restoreBackup(archive,join(root,'restored'));restored=openDatabase(join(root,'restored/business.sqlite'));
  assert.equal(restored.sqlite.prepare('SELECT COUNT(*) n FROM distributor_stores').get().n,2);
  assert.equal(restored.sqlite.prepare('SELECT whatsapp FROM distributor_sales_contacts').get().whatsapp,'+12025550123');
  assert.equal(restored.sqlite.prepare('SELECT COUNT(*) n FROM distributor_payments').get().n,1);
  assert.equal(restored.sqlite.prepare('SELECT COUNT(*) n FROM distributor_sessions').get().n,0);
  assert.equal(restored.sqlite.prepare('SELECT activation_hash FROM distributor_stores WHERE customer_id=?').get(id2).activation_hash,null);
  assert((await authenticateDistributor(restored,{username:a.username,password})).token);
 }finally{restored?.sqlite.close();f.sqlite.close();rmSync(root,{recursive:true,force:true});}
});

test('管理员维护对客 WhatsApp，商家只获得现任负责人的联系信息',async()=>{
 const f=fixture(),id=await enroll(f),a=await activate(f,id);
 const get=async()=>{const r=await handleDistributor(request(a),f.db);assert.equal(r.status,200);return r.json();};
 assert.equal((await get()).customer.salesContact,null);
 const save={action:'salesContactSave',userId:f.users.indonesia.id,version:0,displayName:'Rani',whatsapp:'+1 (202) 555-0123'};
 for(const who of [f.users.indonesia,f.users.finance,f.users.sales])await assert.rejects(mutateDistribution(f.db,who,save),{status:403});
 await mutateDistribution(f.db,f.users.admin,save);
 const own=(await get()).customer.salesContact;assert.equal(own.name,'Rani');assert.equal(own.whatsapp,'+12025550123');assert.match(own.href,/^https:\/\/wa\.me\/12025550123\?text=/);
 assert(!own.href.includes(id));assert(!own.href.includes('lj_distributor'));assert(!own.href.includes('Jakarta'));
 await mutateDistribution(f.db,f.users.admin,{...save,userId:f.users.sales2.id,displayName:'Dewi',whatsapp:'+12025550124'});
 assert(!(JSON.stringify(await get()).includes('+12025550124')));
 assert.equal((await readDistribution(f.db,f.users.indonesia)).contacts.length,0);
 assert.equal((await readDistribution(f.db,f.users.finance)).contacts.length,0);
 f.sqlite.prepare('UPDATE wholesale_customers SET sales_user_id=? WHERE id=?').run(f.users.sales2.id,id);
 assert.equal((await get()).customer.salesContact.whatsapp,'+12025550124');
 await mutateDistribution(f.db,f.users.admin,{...save,userId:f.users.sales2.id,displayName:'Dewi',whatsapp:'',version:1});
 assert.equal((await get()).customer.salesContact,null);
 assert.equal((await handleDistributor(request(null),f.db)).status,401);
});

test('WhatsApp 号码与版本校验，禁用负责人和维护期不能错误发布对外联系人',async()=>{
 const f=fixture(),save={action:'salesContactSave',userId:f.users.sales.id,version:0,displayName:'Sari',whatsapp:'081234567890'};
 for(const phone of ['https://wa.me/6281234567890','javascript:alert(1)','6281234567890','+62012','+621234567890123456',null])await assert.rejects(mutateDistribution(f.db,f.users.admin,{...save,whatsapp:phone}),{status:400});
 await assert.rejects(mutateDistribution(f.db,f.users.admin,{...save,displayName:'销售甲'}),{status:400});
 await assert.rejects(mutateDistribution(f.db,f.users.admin,{...save,userId:f.users.finance.id}));
 await mutateDistribution(f.db,f.users.admin,save);
 assert.equal(f.sqlite.prepare('SELECT whatsapp FROM distributor_sales_contacts').get().whatsapp,'+6281234567890');
 await assert.rejects(mutateDistribution(f.db,f.users.admin,{...save,whatsapp:'+12025550124'}));
 assert.equal(f.sqlite.prepare('SELECT version FROM distributor_sales_contacts').get().version,1);
 const {distributorSalesContact}=await import('../lib/distributor-sales-contacts.mjs');
 f.sqlite.prepare('UPDATE users SET active=0 WHERE id=?').run(f.users.sales.id);
 assert.equal(await distributorSalesContact(f.db,f.users.sales.id),null);
 await assert.rejects(mutateDistribution(f.db,f.users.admin,{...save,version:1}));
 f.sqlite.prepare('UPDATE users SET active=1 WHERE id=?').run(f.users.sales.id);
 f.sqlite.prepare("INSERT INTO system_maintenance(id,mode,expires_at,actor_id,updated_at) VALUES('global','backup',?,'admin-1',?) ON CONFLICT(id) DO UPDATE SET mode=excluded.mode,expires_at=excluded.expires_at").run(new Date(Date.now()+60000).toISOString(),new Date().toISOString());
 await assert.rejects(mutateDistribution(f.db,f.users.admin,{...save,version:1,whatsapp:''}));
 assert.equal(f.sqlite.prepare('SELECT whatsapp FROM distributor_sales_contacts').get().whatsapp,'+6281234567890');
});
