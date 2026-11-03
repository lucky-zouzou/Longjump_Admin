import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {receiveWebsiteInquiry,readWebsiteLeads,mutateWebsiteLead} from '../lib/website-leads.mjs';
import {handleWebsiteInquiry} from '../lib/website-inquiry-handler.mjs';
import {signInquiry} from '../lib/website-inquiry-auth.mjs';
import {indonesiaDate,readWholesale} from '../lib/wholesale.mjs';

const secret='synthetic-inquiry-test-secret-32-characters';
const sample=(overrides={})=>({schemaVersion:1,source:'loongjump-website',externalId:'LJ-TEST-1',revision:1,createdAt:'2026-11-01T01:00:00.000Z',updatedAt:'2026-11-01T01:00:00.000Z',assignee:{id:'web-sales-1',name:'Website sales'},status:'new',salesNote:'',details:{topic:'Grosir',name:'Sari',company:'Toko Test',contactType:'WhatsApp',contact:'+628123456789',city:'Jakarta',country:'Indonesia',items:[{productId:'bag-website',name:'Website bag',quantity:'5'}]},...overrides});
const row=(f,id)=>f.sqlite.prepare('SELECT * FROM website_leads WHERE id=?').get(id);
const count=(f,table)=>f.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
const change=(f,actor,id,action,payload={})=>mutateWebsiteLead(f.db,actor,{id,version:row(f,id).version,action,operationId:crypto.randomUUID(),...payload});
const assign=(f,id,extra={})=>change(f,f.users.admin,id,'assign',{ownerId:f.users.sales.id,reason:'核对两边销售账号',...extra});
const complete=(f,id)=>change(f,f.users.sales,id,'follow',{profile:{...JSON.parse(row(f,id).profile_json),address:'Jl. Synthetic 10'},status:'following',note:'客户核实地址与数量',nextFollowUp:'2026-12-01'});
const convert=(f,id,extra={})=>change(f,f.users.sales,id,'convert',{identityConfirmed:true,reason:'电话核实真实客户身份',...extra});
const signed=async(payload,{time=Date.now(),key=secret,headers={},method='POST'}={})=>{const raw=JSON.stringify(payload);return new Request('https://admin.example.test/api/integrations/website-inquiries',{method,headers:{'content-type':'application/json','x-loongjump-timestamp':String(time),'x-loongjump-signature':await signInquiry(key,String(time),raw),...headers},...(method==='POST'?{body:raw}:{})});};

test('signed integration rejects missing/expired/tampered credentials and never creates customers',async()=>{
 const f=fixture();try{
  assert.equal((await handleWebsiteInquiry(await signed(sample()),f.db,undefined)).status,503);
  assert.equal((await handleWebsiteInquiry(await signed(sample(),{key:secret+'wrong'}),f.db,secret)).status,401);
  assert.equal((await handleWebsiteInquiry(await signed(sample(),{time:Date.now()-360000}),f.db,secret)).status,401);
  assert.equal((await handleWebsiteInquiry(await signed(sample(),{headers:{'x-loongjump-signature':'0'.repeat(64)}}),f.db,secret)).status,401);
  assert.equal((await handleWebsiteInquiry(await signed(sample(),{method:'GET'}),f.db,secret)).status,405);
  assert.equal(count(f,'website_leads'),0);
  const response=await handleWebsiteInquiry(await signed(sample()),f.db,secret);assert.equal(response.status,200);assert.ok((await response.json()).leadId);
  assert.equal(count(f,'website_leads'),1);assert.equal(count(f,'wholesale_customers'),0);assert.equal(count(f,'wholesale_orders'),0);
 }finally{f.sqlite.close();}
});
test('oversized bodies, wrong source and malformed item do not enter the ledger',async()=>{
 const f=fixture();try{
  assert.equal((await handleWebsiteInquiry(await signed({...sample(),padding:'a'.repeat(65000)}),f.db,secret)).status,413);
  assert.equal((await handleWebsiteInquiry(await signed({...sample(),source:'unknown'}),f.db,secret)).status,400);
  assert.equal((await handleWebsiteInquiry(await signed({...sample(),details:{...sample().details,items:[null]}}),f.db,secret)).status,400);
  assert.equal(count(f,'website_leads'),0);
 }finally{f.sqlite.close();}
});
test('duplicate, out of order and concurrent delivery create one lead, no inventory movement',async()=>{
 const f=fixture();try{
  const [a,b]=await Promise.all([receiveWebsiteInquiry(f.db,sample()),receiveWebsiteInquiry(f.db,sample())]);assert.equal(a.leadId,b.leadId);
  await receiveWebsiteInquiry(f.db,sample({revision:2,status:'quoted'}));
  const older=await receiveWebsiteInquiry(f.db,sample());assert.equal(older.replayed,true);assert.equal(row(f,a.leadId).source_revision,2);
  await assert.rejects(receiveWebsiteInquiry(f.db,sample({revision:2,status:'closed'})),/不同内容/);
  assert.equal(count(f,'website_leads'),1);assert.equal(count(f,'website_lead_events'),2);assert.equal(count(f,'wholesale_customers'),0);
  assert.equal(f.sqlite.prepare("SELECT qty FROM inventory_balances WHERE site='印尼' AND channel='TikTok' AND sku='BAG-A'").get().qty,10);
 }finally{f.sqlite.close();}
});
test('unmapped owners stay pooled; explicit mapping applies to new inquiries and inactive owners are not assigned',async()=>{
 const f=fixture();try{
  const first=await receiveWebsiteInquiry(f.db,sample());assert.equal(row(f,first.leadId).owner_id,null);
  assert.equal((await readWebsiteLeads(f.db,f.users.sales)).total,0);
  assert.equal((await readWebsiteLeads(f.db,f.users.admin,{status:'pool'})).total,1);
  await assign(f,first.leadId,{saveMapping:true});
  const second=await receiveWebsiteInquiry(f.db,sample({externalId:'LJ-TEST-2'}));assert.equal(row(f,second.leadId).owner_id,f.users.sales.id);
  f.sqlite.prepare('UPDATE users SET active=0 WHERE id=?').run(f.users.sales.id);
  const third=await receiveWebsiteInquiry(f.db,sample({externalId:'LJ-TEST-3'}));assert.equal(row(f,third.leadId).owner_id,null);
  assert.equal((await readWebsiteLeads(f.db,f.users.admin,{status:'pool'})).total,3);
 }finally{f.sqlite.close();}
});
test('sales isolation prevents guessing another lead, assignment, OEM confirmation or mapping',async()=>{
 const f=fixture();try{
  const {leadId}=await receiveWebsiteInquiry(f.db,sample());await assign(f,leadId);
  await assert.rejects(readWebsiteLeads(f.db,f.users.sales2,{id:leadId}),e=>e.status===404);
  await assert.rejects(readWebsiteLeads(f.db,f.users.sales,{status:'pool'}),e=>e.status===403);
  await assert.rejects(readWebsiteLeads(f.db,f.users.finance),e=>e.status===403);
  await assert.rejects(readWebsiteLeads(f.db,f.users.malaysia),e=>e.status===403);
  await assert.rejects(change(f,f.users.sales,leadId,'assign',{ownerId:f.users.sales2.id,reason:'转给别人处理'}),e=>e.status===403);
  await assert.rejects(change(f,f.users.sales,leadId,'qualify',{country:'Indonesia',kind:'wholesale',reason:'切换业务范围'}),e=>e.status===403);
  await assert.rejects(change(f,f.users.sales2,leadId,'follow',{}),e=>e.status===404);
 }finally{f.sqlite.close();}
});
test('incomplete contact data stays a lead; website updates preserve manually verified data and ownership',async()=>{
 const f=fixture();try{
  const {leadId}=await receiveWebsiteInquiry(f.db,sample());await assign(f,leadId);
  await assert.rejects(convert(f,leadId),/资料未齐/);assert.equal(count(f,'wholesale_customers'),0);
  await complete(f,leadId);
  await receiveWebsiteInquiry(f.db,sample({revision:2,assignee:{id:'other-web-sales'},details:{...sample().details,company:'Changed website company',address:'Wrong'}}));
  const updated=row(f,leadId);assert.equal(updated.owner_id,f.users.sales.id);assert.equal(updated.assignment_state,'manual');assert.equal(JSON.parse(updated.profile_json).address,'Jl. Synthetic 10');
  assert.equal(JSON.parse(updated.source_json).details.company,'Changed website company');
 }finally{f.sqlite.close();}
});
test('unknown country, non-Indonesia and OEM require explicit admin qualification, retaining original need',async()=>{
 for(const details of [{country:''},{country:'Malaysia'},{topic:'OEM & Custom'}]){
  const f=fixture();try{
   const {leadId}=await receiveWebsiteInquiry(f.db,sample({details:{...sample().details,...details}}));await assign(f,leadId);await complete(f,leadId);
   await assert.rejects(convert(f,leadId),/仅已确认/);
   await change(f,f.users.admin,leadId,'qualify',{country:'Indonesia',kind:'wholesale',reason:'已与客户确认改为印尼现货批发'});
   const customer=await convert(f,leadId);assert.ok(customer.customerId);assert.deepEqual(JSON.parse(row(f,leadId).source_json).details.topic,details.topic||'Grosir');
  }finally{f.sqlite.close();}
 }
});
test('conversion is atomic and repeat safe; several verified inquiries can link one customer',async()=>{
 const f=fixture();try{
  const {leadId}=await receiveWebsiteInquiry(f.db,sample());await assign(f,leadId);await complete(f,leadId);
  const request={id:leadId,version:row(f,leadId).version,action:'convert',operationId:crypto.randomUUID(),identityConfirmed:true,reason:'核实为同一真实客户'};
  const converted=await mutateWebsiteLead(f.db,f.users.sales,request);assert.equal((await mutateWebsiteLead(f.db,f.users.sales,request)).customerId,converted.customerId);assert.equal(count(f,'wholesale_customers'),1);
  const second=await receiveWebsiteInquiry(f.db,sample({externalId:'LJ-TEST-2'}));await assign(f,second.leadId);
  assert.equal((await readWebsiteLeads(f.db,f.users.sales,{id:second.leadId})).related[0].id,leadId);
  await convert(f,second.leadId,{customerId:converted.customerId});assert.equal(count(f,'wholesale_customers'),1);
  await assert.rejects(mutateWebsiteLead(f.db,f.users.sales,{...request,reason:'改成其他信息'}),/编号已使用/);
  assert.throws(()=>f.sqlite.prepare("UPDATE website_lead_events SET detail_json='{}' WHERE lead_id=?").run(leadId),/immutable/);
 }finally{f.sqlite.close();}
});
test('cannot associate another owner customer or duplicate an existing customer',async()=>{
 const f=fixture();try{
  const other=await f.call(f.users.sales2,'customerCreate',{name:'Other',contact:'Other',phone:'08123456789',city:'Jakarta',address:'Test 2'});
  const {leadId}=await receiveWebsiteInquiry(f.db,sample());await assign(f,leadId);await complete(f,leadId);
  await assert.rejects(convert(f,leadId,{customerId:other.id}),/同一销售负责人/);
  await f.call(f.users.sales,'customerCreate',{name:'Toko Test',contact:'Sari',phone:'+628123456789',city:'Jakarta',address:'Test 1'});
  await assert.rejects(convert(f,leadId),/已有同名/);assert.equal(row(f,leadId).customer_id,null);
 }finally{f.sqlite.close();}
});
test('website inquiry closes through customer, approved cash order, receipt, shipment and customer delivery',async()=>{
 const f=fixture();try{
  const {leadId}=await receiveWebsiteInquiry(f.db,sample());await assign(f,leadId);await complete(f,leadId);const c=await convert(f,leadId),day=indonesiaDate();
  const payload={websiteLeadId:leadId,customerId:c.customerId,site:'印尼',saleType:'cash',businessDate:day,items:[{sku:'BAG-A',qty:5,unitPrice:100000}]};
  await assert.rejects(f.call(f.users.sales2,'orderCreate',payload),/本人负责/);
  const order=await f.call(f.users.sales,'orderCreate',payload);assert.equal(f.orderRow(order.id).website_lead_id,leadId);
  await f.change(f.users.finance,order.id,'orderApprove',{supplyUserId:f.users.supply.id,stockBasisConfirmed:true,reason:'核实网站客户与报价'});
  await assert.rejects(f.ship(order.id,5),/回款|收款/);
  await f.change(f.users.finance,order.id,'financeAdd',{kind:'receipt',amount:500000,reference:'SYNTHETIC-BANK-001',businessDate:day,note:'财务核对实际收款'});
  await f.ship(order.id,5);
  const shipment=f.sqlite.prepare('SELECT id FROM wholesale_shipments WHERE order_id=?').get(order.id);
  await f.change(f.users.sales,order.id,'customerReceiptConfirm',{shipmentId:shipment.id,businessDate:day,receiver:'Sari',proofRef:'客户签收消息已核实',receivedConfirmed:true});
  const view=await readWholesale(f.db,f.users.finance,day.slice(0,7)),o=view.orders.find(r=>r.id===order.id);
  assert.equal(o.status,'completed');assert.equal(o.paid,500000);assert.equal(o.customerReceipt.pending,0);assert.equal(o.outstanding,0);
  assert.equal((await readWebsiteLeads(f.db,f.users.sales,{id:leadId})).orders[0].id,order.id);
  assert.equal(f.sqlite.prepare("SELECT SUM(qty) n FROM inventory_balances WHERE site='印尼' AND sku='BAG-A'").get().n,15);
 }finally{f.sqlite.close();}
});
test('unconverted inquiry and wrong customer cannot be attached to an order',async()=>{
 const f=fixture();try{
  const {leadId}=await receiveWebsiteInquiry(f.db,sample());await assign(f,leadId);
  const other=await f.call(f.users.sales,'customerCreate',{name:'Another',contact:'Person',phone:'08123450000',city:'Jakarta',address:'Test'});
  const payload={websiteLeadId:leadId,customerId:other.id,site:'印尼',saleType:'cash',businessDate:indonesiaDate(),items:[{sku:'BAG-A',qty:1,unitPrice:100000}]};
  await assert.rejects(f.call(f.users.sales,'orderCreate',payload),/未完成印尼客户确认/);
  await complete(f,leadId);await convert(f,leadId);await assert.rejects(f.call(f.users.sales,'orderCreate',payload),/未完成印尼客户确认/);assert.equal(count(f,'wholesale_orders'),0);
 }finally{f.sqlite.close();}
});
test('stale changes and maintenance pause do not partially assign, convert or receive',async()=>{
 const f=fixture();try{
  const {leadId}=await receiveWebsiteInquiry(f.db,sample());const v=row(f,leadId).version;await assign(f,leadId);
  await assert.rejects(change(f,f.users.admin,leadId,'assign',{version:v,ownerId:f.users.sales2.id,reason:'旧页面的分配操作'}),/已更新/);
  f.sqlite.prepare("INSERT OR REPLACE INTO system_maintenance(id,mode,expires_at,updated_at) VALUES('global','backup',?,'2026-11-02')").run(new Date(Date.now()+60000).toISOString());
  await assert.rejects(receiveWebsiteInquiry(f.db,sample({externalId:'LJ-PAUSED'})),/备份或迁移/);assert.equal(count(f,'website_leads'),1);
 }finally{f.sqlite.close();}
});
