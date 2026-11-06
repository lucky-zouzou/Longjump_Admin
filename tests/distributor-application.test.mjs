import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {handleDistributorApplication} from '../lib/distributor-application.mjs';
import {distributorApplicationSource as source, readWebsiteLeads, mutateWebsiteLead} from '../lib/website-leads.mjs';
import {manageDistributorLink,distributorIdentity} from '../lib/distributor-ordering.mjs';

const origin='https://grosir.example.test',url=origin+'/distributor/apply';
const sample={name:'Contoh Mitra',phone:'081234567890',city:'Bandung',channel:'TikTok',account:'@contoh',consent:'yes'};
const post=(db,fields=sample,headers={})=>handleDistributorApplication(new Request(url,{method:'POST',headers:{origin,...headers},body:new URLSearchParams(fields)}),db);
const leadOf=f=>f.sqlite.prepare('SELECT * FROM website_leads WHERE source=?').get(source);
const count=(f,table)=>f.sqlite.prepare('SELECT count(*) n FROM '+table).get().n;
const change=(f,actor,action,fields)=>{const lead=leadOf(f);return mutateWebsiteLead(f.db,actor,{id:lead.id,version:lead.version,operationId:crypto.randomUUID(),action,...fields});};
const note={identityConfirmed:true,reason:'Verified via synthetic WhatsApp follow-up'};
const assign=f=>change(f,f.users.admin,'assign',{ownerId:f.users.sales.id,reason:'Indonesia creator enquiries'});
const profile={name:'Toko Contoh',contact:'Contoh Mitra',phone:'+6281234567890',city:'Bandung',address:'Jl. Contoh 10'};

test('public registration accepts a creator as an unassigned lead; retries cannot change or expose the application',async()=>{
 const f=fixture();
 try {
  const [a,b]=await Promise.all([post(f.db),post(f.db,{...sample,phone:'+62 81234567890',account:'CONTOH'})]);
  assert.equal(a.status,303);assert.equal(b.status,303);assert.equal(a.headers.get('location'),'/distributor/apply?received=1');
  assert.equal(await a.text(),'');
  assert.equal((await post(f.db,{...sample,name:'Changed',city:'Fake',owner_id:f.users.sales.id,customer_id:'chosen'})).status,303);
  assert.equal(count(f,'website_leads'),1);assert.equal(count(f,'website_lead_events'),1);
  const l=leadOf(f),p=JSON.parse(l.profile_json);
  assert.equal(l.owner_id,null);assert.equal(l.status,'new');assert.equal(l.customer_id,null);assert.equal(l.country,'印尼');
  assert.equal(p.city,'Bandung');assert.equal(p.contact,'Contoh Mitra');assert.equal(p.address,'');assert.equal(p.phone,profile.phone);
  assert.equal(count(f,'distributor_links'),0);assert.equal(count(f,'wholesale_customers'),0);
  assert.equal((await readWebsiteLeads(f.db,f.users.sales,{source})).total,0);
  assert.equal((await readWebsiteLeads(f.db,f.users.admin,{source,status:'pool'})).total,1);
  const success=await handleDistributorApplication(new Request(url+'?received=1'),f.db);
  assert.match(await success.text(),/Pendaftaran diterima/);
 }finally{f.sqlite.close();}
});

test('only admin can decide, a verified owner and complete address are required before issuing a private order link',async()=>{
 const f=fixture();
 try {
  await post(f.db);await assert.rejects(change(f,f.users.admin,'convert',note),/负责人/);
  await assign(f);await assert.rejects(change(f,f.users.admin,'convert',note),/资料未齐/);
  await change(f,f.users.sales,'follow',{profile,status:'following',note:'Test verification'});
  await assert.rejects(change(f,f.users.sales,'follow',{profile,status:'closed',note:'Reject'}),e=>e.status===403);
  await assert.rejects(change(f,f.users.sales,'convert',note),e=>e.status===403);
  await assert.rejects(change(f,f.users.sales,'rejectApplication',{reason:'Identity check failed'}),e=>e.status===403);
  await change(f,f.users.admin,'rejectApplication',{reason:'Identity check failed'});
  await assert.rejects(change(f,f.users.sales,'follow',{profile,status:'following',note:'Reopen'}),e=>e.status===403);
  await assert.rejects(change(f,f.users.admin,'convert',note),/已关闭/);
  await change(f,f.users.admin,'follow',{profile,status:'following',note:'Identity confirmed on recheck'});
  const {customerId}=await change(f,f.users.admin,'convert',note);
  assert.equal(f.sqlite.prepare('SELECT sales_user_id FROM wholesale_customers WHERE id=?').get(customerId).sales_user_id,f.users.sales.id);
  assert.equal(count(f,'distributor_links'),0);
  await assert.rejects(manageDistributorLink(f.db,f.users.sales2,{action:'issue',customerId,version:0}),e=>e.status===403);
  const result=await manageDistributorLink(f.db,f.users.sales,{action:'issue',customerId,version:0});
  const auth=await distributorIdentity(f.db,'Bearer '+result.path.split('#')[1]);assert.equal(auth.customer.id,customerId);
  const data=await readWebsiteLeads(f.db,f.users.sales,{source,id:leadOf(f).id});assert.equal(data.distributorLink.active,1);
  assert.ok(data.events.some(e=>e.action==='批准分销申请'));assert.equal(count(f,'wholesale_orders'),0);
 }finally{f.sqlite.close();}
});

test('same existing customer with local Indonesian phone format is linked explicitly and only to its own sales',async()=>{
 const f=fixture();
 try {
  await post(f.db);await assign(f);
  await change(f,f.users.sales,'follow',{profile,status:'following',note:'Company address verified'});
  f.sqlite.prepare('INSERT INTO wholesale_customers(id,code,name,contact,phone,city,address,sales_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run('existing','ID-TEST',profile.name,profile.contact,'0812-3456-7890',profile.city,profile.address,f.users.sales2.id,'2026-01-01','2026-01-01');
  await assert.rejects(change(f,f.users.admin,'convert',note),/已有同名同电话/);
  await assert.rejects(change(f,f.users.admin,'convert',{...note,customerId:'existing'}),e=>e.status===403);
  await change(f,f.users.admin,'assign',{ownerId:f.users.sales2.id,reason:'Existing customer owner confirmed'});
  assert.equal((await change(f,f.users.admin,'convert',{...note,customerId:'existing'})).customerId,'existing');
  assert.equal(count(f,'wholesale_customers'),1);
 }finally{f.sqlite.close();}
});

test('public application blocks cross-origin posts, oversized data, invalid contact or platform, and escapes errors',async()=>{
 const f=fixture();
 try {
  assert.equal((await post(f.db,sample,{origin:'https://other.test'})).status,403);
  assert.equal((await post(f.db,sample,{'content-type':'application/json'})).status,415);
  for(const fields of [{phone:'123'},{channel:'bad'},{consent:''},{account:'@'}])assert.equal((await post(f.db,{...sample,...fields})).status,400);
  assert.equal((await post(f.db,{...sample,city:'a'.repeat(9000)})).status,413);
  const res=await post(f.db,{...sample,name:'"><script>bad</script>',phone:'bad'});const html=await res.text();assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
  assert.equal((await post(f.db,{...sample,website:'bot'})).status,303);assert.equal(count(f,'website_leads'),0);
 }finally{f.sqlite.close();}
});

test('hourly intake ceiling blocks new applications atomically and preserves confirmation for previous applicants',async()=>{
 const f=fixture();
 try {
  await post(f.db);const l=leadOf(f);
  f.sqlite.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<239)
    INSERT INTO website_leads(id,source,external_id,source_revision,source_hash,source_json,profile_json,source_created_at,source_updated_at,created_at,updated_at)
    SELECT 'seed-'||x,source,'seed-'||x,source_revision,source_hash,source_json,profile_json,source_created_at,source_updated_at,created_at,updated_at FROM n,website_leads WHERE id=?`).run(l.id);
  assert.equal((await post(f.db,{...sample,account:'another'})).status,429);assert.equal(count(f,'website_lead_events'),1);
  assert.equal((await post(f.db)).status,303);
 }finally{f.sqlite.close();}
});
