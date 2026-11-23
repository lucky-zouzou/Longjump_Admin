import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {backup} from 'node:sqlite';import {createHash} from 'node:crypto';import {spawn} from 'node:child_process';import {once} from 'node:events';import net from 'node:net';
import {workplaceFixture} from './workplace-fixture.mjs';import {setAccount} from '../server/accounts.mjs';import {fileBucket} from '../server/storage.mjs';
test('真实登录HTTP：人员角色与拍摄/BD入口、费用范围、私有下载和导出均独立鉴权',async()=>{
 const root=mkdtempSync(join(tmpdir(),'TEST-people-http-')),f=await workplaceFixture(),password='TEST-only-'+crypto.randomUUID();let child;
 try{
  for(const a of Object.values(f.users))setAccount(f.sqlite,{...a,email:a.id+'@example.test',password});
  const id=await f.expense();await f.approve(id);const proofId=await f.proof(id);const bucket=fileBucket(join(root,'files'));for(const [key,b] of f.contents)await bucket.put(key,b);
  f.sqlite.exec('CREATE TABLE local_migrations(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL,applied_at TEXT NOT NULL)');for(const name of readdirSync('drizzle').filter(n=>n.endsWith('.sql')))f.sqlite.prepare('INSERT INTO local_migrations VALUES(?,?,?)').run(name,createHash('sha256').update(readFileSync(join('drizzle',name))).digest('hex'),new Date().toISOString());await backup(f.sqlite,join(root,'business.sqlite'));
  const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(r=>server.close(r));const origin='http://127.0.0.1:'+port;let log='';
  child=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,NODE_ENV:'production',LOONGJUMP_DATA_DIR:root,LOONGJUMP_ORIGIN:origin,LOONGJUMP_ALLOW_HTTP:'1',PORT:String(port),HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
  await new Promise((res,rej)=>{const t=setTimeout(()=>rej(Error(log)),20000);child.stdout.on('data',b=>{if(String(b).includes('ready at')){clearTimeout(t);res();}});child.once('exit',()=>{clearTimeout(t);rej(Error(log));});});
  async function login(user){const get=await fetch(origin+'/signin-with-chatgpt'),cookie=get.headers.getSetCookie()[0].split(';')[0],html=await get.text(),csrf=html.match(/name="csrf" value="([^"]+)"/)[1];const r=await fetch(origin+'/signin-with-chatgpt',{method:'POST',redirect:'manual',headers:{cookie,'Content-Type':'application/x-www-form-urlencoded',origin},body:new URLSearchParams({csrf,email:user+'@example.test',password})});assert.equal(r.status,303);return r.headers.getSetCookie().find(x=>x.startsWith('lj_session=')).split(';')[0];}
  const cookies={};for(const u of ['id-ops','my-ops','hr','studio','finance-1','boss'])cookies[u]=await login(u);
  const request=(u,path,p)=>fetch(origin+path,{method:p?'POST':'GET',headers:{cookie:cookies[u],origin,'Content-Type':'application/json'},...(p?{body:JSON.stringify(p)}:{})});
  assert.equal((await fetch(origin+'/api/workplace')).status,401);
  for(const u of ['hr','studio'])for(const page of ['attendance','finance-workbench']){assert.equal((await request(u,'/api/system?module='+page+'&navigation=shell')).status,200);assert.equal((await request(u,'/api/workplace?view='+(page==='attendance'?'attendance':'finance'))).status,200);}
  assert.equal((await request('hr','/api/finance-ledger')).status,403);assert.equal((await request('hr','/api/system?module=sales')).status,403);
  assert.equal((await request('my-ops','/api/workplace?view=finance&month=2026-09')).status,200);assert.equal((await (await request('my-ops','/api/workplace?view=finance&month=2026-09')).json()).requests.length,0);
  const proof=await request('id-ops','/api/workplace/files?id='+proofId);assert.equal(proof.status,200);assert.match(proof.headers.get('cache-control'),/private/);assert.match(proof.headers.get('content-security-policy'),/sandbox/);assert.match(await proof.text(),/TEST ONLY/);
  for(const u of ['my-ops','hr','boss'])assert.equal((await request(u,'/api/workplace/files?id='+proofId)).status,404);
  const csv=await request('my-ops','/api/workplace?view=finance&month=2026-09&export=1');assert.equal(csv.status,200);assert.ok(!(await csv.text()).includes('TEST ENTITY ID'));
  assert.equal((await fetch(origin+'/api/workplace',{method:'POST',headers:{cookie:cookies['id-ops'],origin:'https://invalid.example','Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await request('hr','/api/workplace',{action:'grant',userId:'hr',unitId:'ID',capability:'finance',enabled:true,reason:'TEST'})).status,403);
 }finally{if(child){child.kill('SIGTERM');await once(child,'exit').catch(()=>{});}f.sqlite.close();rmSync(root,{recursive:true,force:true});}
});
