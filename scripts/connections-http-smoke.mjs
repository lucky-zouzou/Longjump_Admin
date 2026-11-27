// Real Node entrypoint check against an isolated temporary database. No live credentials.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {openDatabase} from '../server/storage.mjs';
import {accountSchema,setAccount,hashToken} from '../server/accounts.mjs';

const root=mkdtempSync(join(tmpdir(),'lj-tiktok-http-')),origin='http://127.0.0.1:57351';
let server,db,logs='';
try{
 db=openDatabase(join(root,'business.sqlite'));accountSchema(db.sqlite);
 const sessions={};
 for(const [id,role] of [['TEST-admin','管理员'],['TEST-ops','运营']]){
  setAccount(db.sqlite,{id,email:id.toLowerCase()+'@example.test',name:id,role,site:role==='运营'?'马来西亚':null,channel:role==='运营'?'TikTok':null,password:randomBytes(24).toString('hex')});
  const token=randomBytes(32).toString('hex');sessions[id]=token;db.sqlite.prepare('INSERT INTO local_sessions VALUES(?,?,?)').run(hashToken(token),id,Date.now()+600000);
 }
 db.sqlite.close();db=null;
 server=spawn(process.execPath,['server/index.mjs'],{cwd:resolve('.'),env:{PATH:process.env.PATH,NODE_ENV:'production',HOST:'127.0.0.1',PORT:'57351',LOONGJUMP_ORIGIN:origin,LOONGJUMP_ALLOW_HTTP:'1',LOONGJUMP_DATA_DIR:root,LOONGJUMP_TIKTOK_CREDENTIALS_FILE:join(root,'missing.json'),LOONGJUMP_TIKTOK_TOKEN_KEY_FILE:join(root,'no-key'),LOONGJUMP_FEISHU_CREDENTIALS_FILE:join(root,'missing-feishu.json')},stdio:['ignore','pipe','pipe']});
 server.stdout.on('data',v=>{logs+=v;});server.stderr.on('data',v=>{logs+=v;});
 let ready=false;for(let i=0;i<40;i++){if(server.exitCode!==null)throw Error('Isolated server exited: '+logs);try{ready=(await fetch(origin+'/healthz')).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,250));}assert.ok(ready,'Server did not become ready');
 const request=(path,who='TEST-admin',body,sendOrigin=true)=>fetch(origin+path,{method:body?'POST':'GET',headers:{...(who?{cookie:'lj_session='+sessions[who]}:{}),...(body?{'Content-Type':'application/json',...(sendOrigin?{Origin:origin}:{})}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'manual'});
 assert.equal((await request('/api/connections',null)).status,401);
 assert.equal((await request('/api/connections','TEST-ops')).status,403);
 const read=await request('/api/connections');assert.equal(read.status,200);const data=await read.json();assert.equal(data.configuration.length,2);assert.ok(data.configuration.every(c=>!c.ready));assert.deepEqual(data.accounts,[]);
 assert.equal((await request('/api/connections','TEST-admin',{action:'authorize',provider:'shop'},false)).status,403);
 assert.equal((await request('/api/connections','TEST-admin',{action:'authorize',provider:'shop'})).status,503);
 const callback=await request('/api/connections/callback/shop?state=invalid&code=TEST-CODE',null);assert.equal(callback.status,400);assert.equal(callback.headers.get('referrer-policy'),'no-referrer');assert.ok(!(await callback.text()).includes('TEST-CODE'));
 assert.equal((await request('/api/system?module=connections&navigation=page')).status,200);
 assert.equal((await request('/?page=connections')).status,200);
 console.log('PASS: real Node routing, callback-before-login, company sessions, admin scope, CSRF, missing config, page/module (8 checks)');
}finally{
 if(server&&server.exitCode===null){server.kill('SIGTERM');await once(server,'exit');}
 db?.sqlite.close();rmSync(root,{recursive:true,force:true});
}
