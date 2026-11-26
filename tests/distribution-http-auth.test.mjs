import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,readdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import net from 'node:net';
import {marketingSamplesFixture} from './marketing-samples-fixture.mjs';
import {setAccount} from '../server/accounts.mjs';
import {fileBucket,openDatabase} from '../server/storage.mjs';
import {mutateDomesticDistribution,domesticToday} from '../lib/domestic-distribution.mjs';
import {uploadDomesticFile} from '../lib/domestic-distribution-files.mjs';

async function seed(root,password){
 const f=marketingSamplesFixture();try{
  const factory={id:'http-factory',role:'工厂',name:'TEST国内工厂'};f.users.factory=factory;
  for(const u of Object.values(f.users))setAccount(f.sqlite,{...u,email:`${u.id}@example.test`,password});
  const sent=await f.create();await f.approve(sent.id);await f.assign(sent.id);await f.ship(sent.id,4);
  f.round('sample-pending',2);const pending=await f.create({roundId:'sample-pending'}),shipment=f.shipment(sent.id);
  const photo=f.sqlite.prepare('SELECT id FROM marketing_sample_files WHERE shipment_id=?').get(shipment.id).id;
  const call=(actor,action,p={})=>mutateDomesticDistribution(f.db,actor,{action,...p,operationId:crypto.randomUUID()}),row=id=>f.sqlite.prepare('SELECT * FROM domestic_orders WHERE id=?').get(id),change=(actor,id,action,p={})=>call(actor,action,{orderId:id,version:row(id).version,...p});
  const c=await call(f.users.supply,'customerCreate',{companyName:'TEST ONLY HTTP国内公司',companyShortName:'TEST国内',contact:'TEST',phone:'TEST-ONLY',address:'TEST ONLY'});
  const domestic=await call(f.users.supply,'orderCreate',{customerId:c.id,businessDate:domesticToday(),items:[{sku:'BAG-A',qty:2,unitPrice:'10'}]});
  const proof=purpose=>uploadDomesticFile(f.db,fileBucket(join(root,'files')),f.users.supply,{orderId:domestic.id,purpose,operationId:crypto.randomUUID(),file:new File(['%PDF-1.4 TEST ONLY'],'test.pdf',{type:'application/pdf'})});
  const quote=await proof('quote');await change(f.users.supply,domestic.id,'quoteConfirm',{proofId:quote.id,customerConfirmed:true});const contract=await proof('contract');
  await change(f.users.supply,domestic.id,'contractSubmit',{proofId:contract.id,contractSigned:true,settlementMode:'prepaid',factoryUserId:factory.id,contractNumber:'TEST-HTTP',contractTerms:'TEST ONLY'});
  await change(f.users.admin,domestic.id,'contractDecide',{approved:true,reason:'TEST ONLY 独立审核'});
  // Persist only the synthetic fixture with the exact migration ledger required by the real server.
  f.sqlite.exec('CREATE TABLE local_migrations(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL,applied_at TEXT NOT NULL)');
  for(const name of readdirSync(resolve('drizzle')).filter(n=>n.endsWith('.sql')).sort())f.sqlite.prepare('INSERT INTO local_migrations VALUES(?,?,?)').run(name,createHash('sha256').update(readFileSync(resolve('drizzle',name))).digest('hex'),new Date().toISOString());
  f.sqlite.prepare('VACUUM INTO ?').run(join(root,'business.sqlite'));
  return {users:f.users,sent:sent.id,pending:pending.id,shipment:shipment.id,photo,domestic:domestic.id,contractFile:contract.id};
 }finally{f.sqlite.close();}
}

test('真实公司HTTP登录：BD寄样可读可签收，仍拒绝跨人员/跨站点和财务越权，工厂国内入口正常',async()=>{
 assert.ok(existsSync('dist-node/server/index.js'),'Run build:server before this HTTP regression');
 const root=mkdtempSync(join(tmpdir(),'lj-distribution-http-')),password='TEST-ONLY-'+crypto.randomUUID();let child,logs='';
 try{
  const seeded=await seed(root,password),free=net.createServer();free.listen(0,'127.0.0.1');await once(free,'listening');const port=free.address().port;await new Promise(r=>free.close(r));const origin=`http://127.0.0.1:${port}`;
  const env={...process.env};for(const key of Object.keys(env))if(/OPENAI|QWEN|DASHSCOPE|ANTHROPIC|FEISHU|BEST_|EXCHANGERATE|MATERIALS_|API_KEY|API_SECRET|CREDENTIAL|TOKEN_FILE|BACKUP_DIR/.test(key))delete env[key];
  Object.assign(env,{NODE_ENV:'production',LOONGJUMP_DATA_DIR:root,LOONGJUMP_ORIGIN:origin,LOONGJUMP_ALLOW_HTTP:'1',PORT:String(port),HOST:'127.0.0.1',LOONGJUMP_OPENAI_KEY_FILE:join(root,'NO-EXTERNAL-SECRETS'),MATERIALS_ENABLED:'0'});
  child=spawn(process.execPath,['server/index.mjs'],{env,stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Server startup timeout: '+logs)),15000);child.stdout.on('data',b=>{logs+=b;if(logs.includes('ready at')){clearTimeout(timer);resolve();}});child.stderr.on('data',b=>logs+=b);child.once('exit',code=>{clearTimeout(timer);reject(Error(`Server exited ${code}: ${logs}`));});});
  const login=async who=>{const page=await fetch(origin+'/signin-with-chatgpt'),html=await page.text(),csrf=html.match(/name="csrf" value="([a-f0-9]+)"/)[1],pre=page.headers.getSetCookie()[0].split(';')[0];const response=await fetch(origin+'/signin-with-chatgpt',{method:'POST',redirect:'manual',headers:{origin,cookie:pre,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,email:`${seeded.users[who].id}@example.test`,password})});assert.equal(response.status,303,await response.text());return response.headers.getSetCookie().find(c=>c.startsWith('lj_session=')).split(';')[0];};
  const cookies={};for(const who of ['bd','other','indonesia','malaysia','factory'])cookies[who]=await login(who);
  const request=async(who,path,payload,extra={})=>{const response=await fetch(origin+path,{method:payload?'POST':'GET',headers:{cookie:cookies[who],origin,...(payload?{'content-type':'application/json'}:{}),...extra},...(payload?{body:JSON.stringify({...payload,operationId:crypto.randomUUID()})}:{})});const raw=await response.text();let body;try{body=JSON.parse(raw);}catch{body=raw;}return {status:response.status,body};};
  const path='/api/marketing-samples';assert.equal((await fetch(origin+path)).status,401);
  assert.equal((await fetch(origin+path,{headers:{'x-local-test-user':seeded.users.bd.id,'oai-authenticated-user-id':seeded.users.bd.id}})).status,401);
  const mine=await request('bd',path);assert.equal(mine.status,200,JSON.stringify(mine.body));assert.deepEqual(mine.body.orders.map(o=>o.id).sort(),[seeded.pending,seeded.sent].sort());assert.equal(mine.body.summary,null);
  const own=mine.body.orders.find(o=>o.id===seeded.sent),pending=mine.body.orders.find(o=>o.id===seeded.pending);assert.equal(own.capabilities.receipt,true);assert.equal(pending.capabilities.review,false);
  assert.equal((await request('bd',path+'?file='+seeded.photo)).status,200);assert.equal((await request('bd',path+'?export=cost')).status,403);
  const deniedReview=await request('bd',path,{action:'review',orderId:seeded.pending,version:pending.version,decision:'approve',logisticsUserId:seeded.users.supply.id,reason:'TEST不得跳过独立审核'});assert.equal(deniedReview.status,403);assert.match(deniedReview.body.error,/不能审核/);
  const receipt={action:'receipt',orderId:seeded.sent,version:own.version,shipmentId:seeded.shipment,receivedAt:new Date().toISOString(),receiver:'TEST 客户',proofRef:'TEST ONLY 客户签收凭据'};
  const other=await request('other',path);assert.equal(other.status,200);assert.deepEqual(other.body.orders,[]);assert.equal((await request('other',path+'?file='+seeded.photo)).status,404);assert.equal((await request('other',path,receipt)).status,403);
  const foreign=await request('malaysia',path+'?site='+encodeURIComponent('印尼'));assert.equal(foreign.status,200);assert.deepEqual(foreign.body.orders,[]);assert.equal((await request('malaysia',path+'?file='+seeded.photo)).status,404);assert.equal((await request('malaysia',path,receipt)).status,403);
  const local=await request('indonesia',path);assert.equal(local.status,200);assert.ok(local.body.orders.some(o=>o.id===seeded.sent));assert.equal((await request('indonesia',path,receipt)).status,403);
  assert.equal((await request('bd',path,receipt,{origin:'https://wrong.example'})).status,403);
  const received=await request('bd',path,receipt);assert.equal(received.status,200,JSON.stringify(received.body));const updated=await request('bd',path);assert.equal(updated.body.orders.find(o=>o.id===seeded.sent).receiptStatus,'received');assert.equal(updated.body.orders.find(o=>o.id===seeded.pending).status,'pending');
  for(const denied of ['/api/finance-ledger','/api/domestic-distribution','/api/business-actions','/api/users'])assert.equal((await request('bd',denied)).status,403,denied);
  assert.equal((await request('bd','/api/system',{action:'salesImport'})).status,403);
  const factory=await request('factory','/api/domestic-distribution');assert.equal(factory.status,200,JSON.stringify(factory.body));assert.equal(factory.body.orders.length,1);assert.equal(factory.body.orders[0].id,seeded.domestic);assert.equal(factory.body.orders[0].financial,undefined);assert.equal(factory.body.orders[0].items[0].unit_minor,undefined);
  assert.equal((await request('factory','/api/domestic-distribution?fileId='+seeded.contractFile)).status,403);assert.equal((await request('factory',path)).status,403);
  const db=openDatabase(join(root,'business.sqlite'));try{assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM marketing_sample_receipts WHERE shipment_id=?').get(seeded.shipment).n,1);assert.equal(db.sqlite.prepare('SELECT status FROM marketing_sample_orders WHERE id=?').get(seeded.pending).status,'pending');}finally{db.sqlite.close();}
 }finally{
  if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),3000);await exited;clearTimeout(timer);}
  rmSync(root,{recursive:true,force:true});
 }
});
