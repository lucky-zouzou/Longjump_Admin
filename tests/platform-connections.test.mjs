import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {createHmac} from 'node:crypto';
import {createConnections} from '../server/platform-connections.mjs';
import {createConnectionsHandler} from '../server/connections-http.mjs';
import {createTikTokClient,shopSignature,externalId} from '../server/tiktok-client.mjs';
import {digest,seal,unseal,validateConfig} from '../server/tiktok-config.mjs';
import {navigationForActor} from '../lib/permissions.mjs';
import {Readable} from 'node:stream';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase,fileBucket} from '../server/storage.mjs';
import {createBackup,restoreBackup} from '../server/backup.mjs';

const time=Date.parse('2026-11-27T08:00:00Z'),key=Buffer.alloc(32,7),origin='https://admin.example.test';
const configs={shop:{appId:'test-shop',appSecret:'TEST-SHOP-SECRET',authorizationUrl:'https://services.tiktokshop.com/open/authorize?service_id=1234'},ads:{appId:'9876',appSecret:'TEST-ADS-SECRET',authorizationUrl:'https://business-api.tiktok.com/portal/auth?app_id=9876'}};
function fixture(t,options={}){
 const db=new DatabaseSync(':memory:');for(const f of readdirSync(new URL('../drizzle/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort())db.exec(readFileSync(new URL('../drizzle/'+f,import.meta.url),'utf8'));
 db.exec('CREATE TABLE local_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT,expires_at INTEGER)');
 for(const [id,role] of [['admin','管理员'],['ops','运营']])db.prepare('INSERT INTO users(id,email,name,role,active,created_at,updated_at) VALUES(?,?,?,?,1,?,?)').run(id,id+'@example.test','TEST '+id,role,'2026-11-27','2026-11-27');
 const admin={id:'admin'},ops={id:'ops'},sessionHash=digest('TEST-SESSION');db.prepare('INSERT INTO local_sessions VALUES(?,?,?)').run(sessionHash,admin.id,time+3600000);
 const token={accessToken:'TEST-ACCESS-SECRET',refreshToken:'TEST-REFRESH-SECRET',expiresAt:time+3600000};
 const client={exchange:async()=>token,accounts:async provider=>[{externalId:provider==='shop'?'1001':'2001',name:'TEST Malaysia',region:'MY',currency:provider==='ads'?'MYR':'',timezone:provider==='ads'?'Asia/Kuala_Lumpur':'',cipher:provider==='shop'?'TEST-CIPHER':''}],snapshot:async()=>({startAt:'2026-11-20',endAt:'2026-11-26',fetchedAt:'2026-11-27',summary:{kind:'orders',count:1},records:[{id:'ORDER-1'}]}),refresh:async()=>({...token,expiresAt:time+7200000}),...options.client};
 const service=createConnections({db,origin,config:()=>configs,key:()=>key,now:()=>time,...options,client});
 const authorize=async(provider='shop')=>{const b=service.begin(admin,provider,sessionHash);await service.complete(provider,new URLSearchParams({state:new URL(b.url).searchParams.get('state'),code:'TEST-CODE'}),b.binding);return service.status(admin).accounts.find(a=>a.provider===provider);};
 t.after(()=>db.close());return {db,service,admin,ops,sessionHash,authorize,client,token};
}
test('authorization validates original session and browser, consumes state once, keeps tokens encrypted',async t=>{
 const f=fixture(t),b=f.service.begin(f.admin,'shop',f.sessionHash),p=new URLSearchParams({state:new URL(b.url).searchParams.get('state'),code:'TEST-CODE'});
 await assert.rejects(f.service.complete('shop',p,'wrong'),/浏览器/);await f.service.complete('shop',p,b.binding);await assert.rejects(f.service.complete('shop',p,b.binding),/过期/);
 const response=JSON.stringify(f.service.status(f.admin));for(const secret of ['TEST-ACCESS','TEST-REFRESH','TEST-CIPHER','TEST-SHOP-SECRET','token_encrypted'])assert.ok(!response.includes(secret));
 const stored=f.db.prepare('SELECT * FROM platform_grants').get();assert.ok(!stored.token_encrypted.includes('TEST'));assert.equal(unseal(stored.token_encrypted,key,stored.id).accessToken,f.token.accessToken);
 assert.equal(f.service.status(f.admin).accounts[0].region,'MY');assert.throws(()=>f.service.status(f.ops),/仅管理员/);
});
test('expired session, inactive actor and denied consent never persist accounts',async t=>{
 for(const mutation of [db=>db.exec('DELETE FROM local_sessions'),db=>db.exec("UPDATE users SET active=0 WHERE id='admin'")]){
  const f=fixture(t),b=f.service.begin(f.admin,'shop',f.sessionHash);mutation(f.db);await assert.rejects(f.service.complete('shop',new URLSearchParams({state:new URL(b.url).searchParams.get('state'),code:'x'}),b.binding),/会话/);assert.equal(f.db.prepare('SELECT count(*) n FROM platform_accounts').get().n,0);
 }
 const f=fixture(t),b=f.service.begin(f.admin,'ads',f.sessionHash);await assert.rejects(f.service.complete('ads',new URLSearchParams({state:new URL(b.url).searchParams.get('state'),error:'access_denied'}),b.binding),/未完成/);
});
test('recheck session after provider call and reject changed configuration',async t=>{
 const f=fixture(t,{client:{accounts:async()=>{f.db.exec('DELETE FROM local_sessions');return [{externalId:'1001'}];}}});await assert.rejects(f.authorize(),/会话/);
 const g=fixture(t);const b=g.service.begin(g.admin,'shop',g.sessionHash);const changed={...configs,shop:{...configs.shop,appSecret:'NEW-SECRET'}};
 const other=createConnections({db:g.db,origin,config:()=>changed,key:()=>key,client:g.client,now:()=>time});await assert.rejects(other.complete('shop',new URLSearchParams({state:new URL(b.url).searchParams.get('state'),code:'x'}),b.binding),/配置已变化/);
});
test('resync replaces staging data, failure preserves old result, disconnect clears tokens without changing business ledgers',async t=>{
 const f=fixture(t),a=await f.authorize();await f.service.sync(f.admin,a.id);await f.service.sync(f.admin,a.id);assert.equal(f.db.prepare('SELECT count(*) n FROM platform_snapshots').get().n,1);
 f.client.snapshot=async()=>{throw Object.assign(Error('官方暂时不可用'),{status:502});};await assert.rejects(f.service.sync(f.admin,a.id),/不可用/);assert.equal(f.service.details(f.admin,a.id).total,1);
 assert.equal(f.service.status(f.admin).accounts[0].status,'error');f.service.disconnect(f.admin,a.id);assert.equal(f.db.prepare('SELECT count(*) n FROM platform_grants').get().n,0);await assert.rejects(f.service.sync(f.admin,a.id),/已断开/);assert.equal(f.service.details(f.admin,a.id).total,1);
 for(const table of ['sales_records','sales_ad_spend','inventory_balances'])assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
});
test('disconnect during a read invalidates in-flight result and concurrent read is blocked',async t=>{
 let finish;const f=fixture(t,{client:{snapshot:()=>new Promise(r=>{finish=r;})}}),a=await f.authorize();const pending=f.service.sync(f.admin,a.id);await new Promise(r=>setImmediate(r));await assert.rejects(f.service.sync(f.admin,a.id),/正在读取/);
 f.service.disconnect(f.admin,a.id);finish({records:[],summary:{},startAt:'x',endAt:'x',fetchedAt:'x'});await assert.rejects(pending,/连接已变化/);assert.equal(f.db.prepare('SELECT count(*) n FROM platform_snapshots').get().n,0);assert.equal(f.service.status(f.admin).accounts[0].status,'disconnected');
});
test('shop grant refresh is reused across its accounts and remains encrypted',async t=>{
 let calls=0;const f=fixture(t,{client:{exchange:async()=>({accessToken:'OLD',refreshToken:'REFRESH',expiresAt:time-1}),refresh:async()=>{calls++;return {accessToken:'NEW',refreshToken:'REFRESH-NEW',expiresAt:time+3600000};}}}),a=await f.authorize();await f.service.sync(f.admin,a.id);await f.service.sync(f.admin,a.id);assert.equal(calls,1);const g=f.db.prepare('SELECT * FROM platform_grants').get();assert.equal(unseal(g.token_encrypted,key,g.id).accessToken,'NEW');
});
test('encryption authenticates context and authorization URLs reject nonofficial hosts, overrides and secrets',()=>{
 const encrypted=seal({accessToken:'secret'},key,'one');assert.throws(()=>unseal(encrypted,key,'two'),/解密/);assert.throws(()=>unseal(encrypted,Buffer.alloc(32),'one'),/解密/);
 for(const u of ['https://evil.test/open/authorize?service_id=1','https://services.tiktokshop.com.evil.test/open/authorize?service_id=1','http://services.tiktokshop.com/open/authorize?service_id=1','https://services.tiktokshop.com/open/authorize?service_id=1&secret=x'])assert.throws(()=>validateConfig({shop:{...configs.shop,authorizationUrl:u}},'shop'));
 assert.throws(()=>validateConfig({...configs,ads:{...configs.ads,authorizationUrl:'https://business-api.tiktok.com/portal/auth?app_id=OTHER'}},'ads'));
 assert.ok(navigationForActor({role:'管理员'}).includes('connections'));assert.ok(!navigationForActor({role:'运营',site:'印尼',channel:'TikTok'}).includes('connections'));
});
function response(data,code=0){return new Response(JSON.stringify({code,data}),{headers:{'Content-Type':'application/json'}});}
test('Shop signature binds path, sorted params and body but excludes token and sign',()=>{
 const query={z:'2',app_key:'a',timestamp:1,access_token:'secret',sign:'ignore'},body='{"a":1}';const expected=createHmac('sha256','key').update('key/pathapp_keyatimestamp1z2'+body+'key').digest('hex');assert.equal(shopSignature('/path',query,body,'key'),expected);assert.throws(()=>externalId(9007199254740993),/精度/);
});
test('Shop pagination reads all pages without persisting customer information or rounding IDs',async()=>{
 let count=0;const requests=[];const client=createTikTokClient({now:()=>time,fetcher:async(url,init)=>{requests.push([url,init]);return response(++count===1?{orders:[{id:'90071992547409935',status:'UNPAID',buyer_email:'private@example.test',recipient_address:{full_address:'secret'},payment:{currency:'MYR',total_amount:'20'}}],next_page_token:'next',total_count:2}:{orders:[{id:'90071992547409936',status:'COMPLETED'}],total_count:2});}});
 const s=await client.snapshot('shop',configs.shop,{accessToken:'secret'},{cipher:'c'});assert.equal(s.records.length,2);assert.equal(s.records[0].id,'90071992547409935');assert.ok(!JSON.stringify(s).includes('private'));assert.ok(new URL(requests[1][0]).searchParams.get('page_token'));assert.equal(requests[0][1].headers['x-tts-access-token'],'secret');assert.equal(requests[0][1].redirect,'error');
});
test('incomplete or repeating Shop pagination fails instead of saving partial totals',async()=>{
 for(const data of [{orders:[],total_count:9},{orders:[],next_page_token:'repeated'},{}]){
  const c=createTikTokClient({now:()=>time,fetcher:async()=>response(data)});await assert.rejects(c.snapshot('shop',configs.shop,{accessToken:'x'},{cipher:'c'}));
 }
});
test('Ads reporting uses account timezone, exact account, separate currency and missing data is not zero',async()=>{
 let seen;const c=createTikTokClient({now:()=>time,fetcher:async(url)=>{seen=new URL(url);return response({list:[{dimensions:{advertiser_id:'123',stat_time_day:'2026-11-26'},metrics:{spend:'0',impressions:'3',clicks:'0'}}],page_info:{total_page:1}});}});
 const s=await c.snapshot('ads',configs.ads,{accessToken:'x'},{external_id:'123',timezone:'Asia/Kuala_Lumpur',currency:'MYR'});assert.equal(seen.searchParams.get('start_date'),'2026-11-20');assert.equal(s.summary.spend,0);assert.equal(s.summary.missingDays,6);assert.equal(s.summary.currency,'MYR');
 await assert.rejects(c.snapshot('ads',configs.ads,{accessToken:'x'},{external_id:'OTHER',timezone:'Asia/Kuala_Lumpur',currency:'MYR'}),/不匹配/);
 await assert.rejects(c.snapshot('ads',configs.ads,{accessToken:'x'},{external_id:'123',timezone:'',currency:'MYR'}),/时区/);
 const empty=createTikTokClient({now:()=>time,fetcher:async()=>response({list:[],page_info:{total_page:0}})});assert.equal((await empty.snapshot('ads',configs.ads,{accessToken:'x'},{external_id:'123',timezone:'Asia/Kuala_Lumpur',currency:'MYR'})).summary.spend,null);
});
test('429 is retried for reads but never OAuth exchange, errors never expose provider messages or secrets',async()=>{
 let calls=0;const c=createTikTokClient({now:()=>time,sleep:async()=>{},fetcher:async()=>{calls++;return new Response('TEST-SECRET',{status:429});}});await assert.rejects(c.accounts('shop',configs.shop,{accessToken:'x'}),/频率/);assert.equal(calls,2);calls=0;await assert.rejects(c.exchange('shop',configs.shop,'code'),/频率/);assert.equal(calls,1);
 const d=createTikTokClient({now:()=>time,fetcher:async()=>new Response(JSON.stringify({code:123,message:'app_secret=TOP-SECRET'}))});await assert.rejects(d.accounts('shop',configs.shop,{accessToken:'x'}),e=>!e.message.includes('TOP-SECRET')&&e.message.includes('123'));
});
test('HTTP boundary enforces origin and role, cookie binding is not returned in JSON and callback leaks no code',async t=>{
 const f=fixture(t),handle=createConnectionsHandler(f.service,origin);
 async function request(path,method='GET',body=null,user=f.admin,headers={}){
  const req=Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]);Object.assign(req,{url:path,method,headers});const res={headers:{},setHeader(k,v){this.headers[k]=v;},writeHead(status,h){this.status=status;Object.assign(this.headers,h);},end(body){this.body=body;}};await handle(req,res,user,f.sessionHash);return res;
 }
 assert.equal((await request('/api/connections','POST',{action:'authorize',provider:'shop'})).status,403);
 assert.equal((await request('/api/connections','GET',null,f.ops)).status,403);
 const start=await request('/api/connections','POST',{action:'authorize',provider:'shop'},f.admin,{origin});assert.equal(start.status,200);assert.match(start.headers['Set-Cookie'],/HttpOnly; SameSite=Lax/);assert.match(start.headers['Set-Cookie'],/; Secure/);assert.ok(!start.body.includes('binding'));
 const state=new URL(JSON.parse(start.body).url).searchParams.get('state'),cookie=start.headers['Set-Cookie'].split(';')[0];
 const callback=await request('/api/connections/callback/shop?state='+state+'&code=TOP-SECRET-CODE','GET',null,null,{cookie});assert.equal(callback.status,200);assert.ok(!callback.body.includes('TOP-SECRET'));assert.equal(callback.headers['Referrer-Policy'],'no-referrer');
});
test('expired authorization cannot be consumed and missing config cannot start an OAuth request',async t=>{
 const f=fixture(t),b=f.service.begin(f.admin,'shop',f.sessionHash);f.db.exec('UPDATE platform_oauth_states SET expires_at=0');await assert.rejects(f.service.complete('shop',new URLSearchParams({state:new URL(b.url).searchParams.get('state'),code:'x'}),b.binding),/过期/);
 const s=createConnections({db:f.db,origin,config:()=>({}),key:()=>key,now:()=>time});assert.equal(s.status(f.admin).configuration[0].ready,false);assert.throws(()=>s.begin(f.admin,'ads',f.sessionHash),/尚未配置/);
});
test('Shop token expiry uses absolute seconds; seller identity is mandatory; Ads account IDs are verified',async()=>{
 const d={user_type:0,access_token:'TEST-TOKEN',refresh_token:'TEST-REFRESH',access_token_expire_in:Math.floor(time/1000)+3600,refresh_token_expire_in:Math.floor(time/1000)+86400};
 let outgoing;const c=createTikTokClient({now:()=>time,fetcher:async url=>{outgoing=new URL(url);return response(d);}});const token=await c.exchange('shop',configs.shop,'code');assert.equal(token.expiresAt,time+3600000);assert.equal(outgoing.host,'auth.tiktok-shops.com');assert.equal(outgoing.searchParams.get('grant_type'),'authorized_code');
 d.user_type=1;await assert.rejects(c.exchange('shop',configs.shop,'code'),/商家/);
 const a=createTikTokClient({now:()=>time,fetcher:async url=>response(url.includes('oauth2/advertiser/get')?{list:[{advertiser_id:'123'}]}:{list:[{advertiser_id:'456',name:'Other',currency:'MYR',timezone:'Asia/Kuala_Lumpur',country:'MY'}]})});await assert.rejects(a.accounts('ads',configs.ads,{accessToken:'x'}),/授权范围外/);
});
test('an empty source array is valid, but null spend and missing pagination never turn into zero',async()=>{
 let data={list:[{dimensions:{advertiser_id:'123',stat_time_day:'2026-11-26'},metrics:{spend:null}}],page_info:{total_page:1}};
 const c=createTikTokClient({now:()=>time,fetcher:async()=>response(data)}),account={external_id:'123',currency:'MYR',timezone:'Asia/Kuala_Lumpur'};const s=await c.snapshot('ads',configs.ads,{accessToken:'x'},account);assert.equal(s.summary.spend,null);assert.equal(s.summary.missingSpend,1);
 data={list:[]};await assert.rejects(c.snapshot('ads',configs.ads,{accessToken:'x'},account),/分页/);
});
test('platform connections and encrypted grants survive backup restore; new writes respect maintenance lock',async t=>{
 const root=mkdtempSync(join(tmpdir(),'lj-connection-backup-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const f=fixture(t),a=await f.authorize();await f.service.sync(f.admin,a.id);
 f.db.prepare("INSERT INTO system_maintenance(id,mode,token_hash,actor_id,expires_at,updated_at) VALUES('global','backup','x','admin','2099-01-01','2026-11-27') ON CONFLICT(id) DO UPDATE SET mode='backup',expires_at='2099-01-01'").run();assert.throws(()=>f.service.disconnect(f.admin,a.id),/maintenance/);f.db.exec("UPDATE system_maintenance SET mode='normal'");
 // Use the real storage wrapper for the backup stream contract, with a clone of this isolated fixture.
 const path=join(root,'source.sqlite');f.db.exec("VACUUM INTO '"+path.replaceAll("'","''")+"'");const wrapped=openDatabase(path,{migrations:false});t.after(()=>wrapped.sqlite.close());
 const archive=join(root,'backup.tar');await createBackup({DB:wrapped,WHOLESALE_FILES:fileBucket(join(root,'files'))},archive);assert.ok(!readFileSync(archive).includes(Buffer.from('TEST-ACCESS-SECRET')));
 const target=join(root,'restore');await restoreBackup(archive,target);const restored=openDatabase(join(target,'business.sqlite'));t.after(()=>restored.sqlite.close());
 const grant=restored.sqlite.prepare('SELECT * FROM platform_grants').get();assert.equal(unseal(grant.token_encrypted,key,grant.id).accessToken,'TEST-ACCESS-SECRET');assert.equal(restored.sqlite.prepare('SELECT count(*) n FROM platform_snapshots').get().n,1);assert.equal(restored.sqlite.prepare('SELECT count(*) n FROM local_sessions').get().n,0);
});
