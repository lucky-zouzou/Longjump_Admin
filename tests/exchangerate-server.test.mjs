import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import net from 'node:net';
import {openDatabase} from '../server/storage.mjs';
import {setAccount} from '../server/accounts.mjs';

test('生产构建通过私密文件读取专用汇率，真实登录接口返回标准快照且无密钥泄露',async()=>{
 assert.ok(existsSync('dist-node/server/index.js'));
 const root=mkdtempSync(join(tmpdir(),'lj-fx-http-')),key='synthetic_fx_key_12345678',password='test-only-'+crypto.randomUUID();
 const keyFile=join(root,'api_key'),mockFile=join(root,'mock-provider.mjs');
 writeFileSync(keyFile,key,{mode:0o600});
 writeFileSync(mockFile,`const realFetch=globalThis.fetch;globalThis.fetch=async(url,options)=>{
 if(String(url).startsWith('https://v6.exchangerate-api.com/')){
  if(String(url)!=='https://v6.exchangerate-api.com/v6/${key}/latest/CNY'||options.redirect!=='error')throw Error('Unexpected FX request');
  const now=Date.now();return new Response(JSON.stringify({result:'success',base_code:'CNY',time_last_update_unix:Math.floor((now-3600000)/1000),time_next_update_unix:Math.floor((now+23*3600000)/1000),conversion_rates:{CNY:1,IDR:2000,MYR:.6,THB:5,VND:3500,PHP:8,USD:.14}}));
 }
 if(String(url).startsWith('https://open.er-api.com/'))throw Error('Public endpoint must not be used');
 return realFetch(url,options);
};`);
 const sqlite=openDatabase(join(root,'business.sqlite')).sqlite;
 setAccount(sqlite,{id:'admin',email:'fx-admin@example.test',name:'FX TEST',role:'管理员',password});sqlite.close();
 let child;
 try{
  const free=net.createServer();free.listen(0,'127.0.0.1');await once(free,'listening');const port=free.address().port;await new Promise(r=>free.close(r));const origin=`http://127.0.0.1:${port}`;
  child=spawn(process.execPath,['--import',pathToFileURL(mockFile).href,'server/index.mjs'],{env:{...process.env,EXCHANGERATE_API_KEY:'',LOONGJUMP_EXCHANGERATE_KEY_FILE:keyFile,NODE_ENV:'production',LOONGJUMP_DATA_DIR:root,LOONGJUMP_ORIGIN:origin,LOONGJUMP_ALLOW_HTTP:'1',PORT:String(port),HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']});
  let logs='';child.stderr.on('data',b=>logs+=b);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('FX test server startup timeout')),15000);child.stdout.on('data',b=>{logs+=b;if(String(b).includes('ready at')){clearTimeout(timer);resolve();}});child.once('exit',()=>{clearTimeout(timer);reject(Error('FX test server exited'));});});
  const page=await fetch(origin+'/signin-with-chatgpt'),html=await page.text(),csrf=html.match(/name="csrf" value="([a-f0-9]+)"/)[1],pre=page.headers.getSetCookie()[0].split(';')[0];
  const login=await fetch(origin+'/signin-with-chatgpt',{method:'POST',redirect:'manual',headers:{origin,'content-type':'application/x-www-form-urlencoded',cookie:pre},body:new URLSearchParams({csrf,email:'fx-admin@example.test',password})});
  assert.equal(login.status,303);const cookie=login.headers.getSetCookie().find(c=>c.startsWith('lj_session=')).split(';')[0];
  const response=await fetch(origin+'/api/sales-dashboard?fxMode=reference',{headers:{cookie}}),text=await response.text();
  assert.equal(response.status,200);const data=JSON.parse(text);assert.equal(data.cny.fx.access,'standard');assert.equal(data.cny.fx.status,'fresh');assert.equal(data.cny.fx.rates.IDR,2000);assert.equal(data.cny.fx.refreshFailed,false);
  assert(!text.includes(key));assert(!logs.includes(key));
 }finally{
  if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}
  rmSync(root,{recursive:true,force:true});
 }
});
