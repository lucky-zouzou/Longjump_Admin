// Isolated production-UI harness. Fixed loopback origin, fixed TEST database and fixed test actors.
// No credentials, real accounts, external provider calls or writes outside this fixture.
import http from 'node:http';
import {Readable} from 'node:stream';
import {resolve} from 'node:path';
import {existsSync,realpathSync} from 'node:fs';

const fixture=resolve('work/agent-pilot-preview'),host='127.0.0.1:57349',origin='http://'+host;
if(process.env.LOONGJUMP_AGENT_PREVIEW!=='1'||resolve(process.env.LOONGJUMP_DATA_DIR||'')!==fixture||!existsSync(fixture+'/business.sqlite')||realpathSync(fixture)!==fixture)throw Error('Requires the explicit isolated TEST-ONLY workplace fixture');
if(realpathSync(fixture+'/business.sqlite')!==fixture+'/business.sqlite')throw Error('Fixture database must not be a symlink');
// Import env only after removing inherited service credentials. The preview never opens private key files.
for(const key of Object.keys(process.env))if(/^(OPENAI_|QWEN_|DASHSCOPE_|EXCHANGERATE_|BEST_|MATERIALS_|FEISHU_|LOONGJUMP_(OPENAI|QWEN|EXCHANGERATE|BEST|FEISHU)_)/.test(key))delete process.env[key];
process.env.NODE_ENV='production';
const {importServerEntryModule,tryServeStatic,sendWebResponse}=await import('vinext/server/prod-server');
const {env}=await import('../server/env.mjs');
if(!env.DB.sqlite.prepare("SELECT id FROM agent_preview_marker WHERE id='TEST-ONLY-AGENT-v1'").get())throw Error('Not a workplace TEST preview fixture');
env.readEmployeeAssistantKey=()=>'';env.readExchangeRateKey=()=>'';
env.readFeishuCredentials=()=>null;env.startFeishuSync=()=>{throw Object.assign(Error('TEST 预览不连接飞书，仅展示合成同步记录'),{status:503});};
const originalFetch=globalThis.fetch;
globalThis.fetch=(input,init)=>{const target=new URL(typeof input==='string'||input instanceof URL?input:input.url,origin);if(target.origin!==origin)throw Error('External network calls are disabled in the TEST preview');return originalFetch(input,init);};
const roles={operator:'id-ops',bd:'sample-bd',supply:'supply-1',finance:'finance-1',admin:'admin-1'};
for(const id of Object.values(roles))if(!env.DB.sqlite.prepare("SELECT id FROM users WHERE id=? AND name LIKE 'TEST-ONLY %' AND email LIKE '%@example.test'").get(id))throw Error('A synthetic preview actor is missing');
const built=await importServerEntryModule(resolve('dist-node/server/index.js')),handler=built.default;
const allowed=['/','/api/system','/api/agent-pilot'];
const server=http.createServer(async(req,res)=>{
 try{
  if(req.headers.host!==host){res.writeHead(403).end();return;}
  const url=new URL(req.url,origin);
  if(req.method==='GET'&&url.pathname==='/__preview'){
   res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end('<h1>TEST-ONLY 单店 Agent 验收</h1>'+Object.keys(roles).map(r=>`<p><a href="/__preview/${r}">${r}</a></p>`).join(''));return;
  }
  if(req.method==='GET'&&url.pathname.startsWith('/__preview/')){
   const role=url.pathname.slice('/__preview/'.length);if(!Object.hasOwn(roles,role)){res.writeHead(404).end();return;}
   res.writeHead(303,{'Set-Cookie':'agent-preview='+role+'; Path=/; HttpOnly; SameSite=Strict',Location:'/?page=agent-pilot'}).end();return;
  }
  if(!['GET','HEAD','POST'].includes(req.method)||req.method==='POST'&&(req.headers.origin!==origin||!['/api/agent-pilot'].includes(url.pathname))){res.writeHead(403).end();return;}
  if(req.method!=='POST'&&await tryServeStatic(req,res,resolve('dist-node/client'),url.pathname,true))return;
  if(!allowed.includes(url.pathname)){res.writeHead(404).end();return;}
  const role=String(req.headers.cookie||'').match(/(?:^|;\s*)agent-preview=(operator|bd|supply|finance|admin)(?:;|$)/)?.[1]||'operator';
  const person=env.DB.sqlite.prepare('SELECT id,email,name FROM users WHERE id=?').get(roles[role]);
  const headers=new Headers();for(const [k,v] of Object.entries(req.headers))if(!k.startsWith('oai-')&&!k.startsWith('x-local-')&&!['host','connection','transfer-encoding','x-forwarded-host','x-forwarded-proto'].includes(k)&&v!=null)headers.set(k,Array.isArray(v)?v.join(','):v);
  headers.set('host',host);headers.set('oai-authenticated-user-id',person.id);headers.set('oai-authenticated-user-email',person.email);headers.set('oai-authenticated-user-full-name',encodeURIComponent(person.name));headers.set('oai-authenticated-user-full-name-encoding','percent-encoded-utf-8');
  const request=new Request(url,{method:req.method,headers,...(req.method==='POST'?{body:Readable.toWeb(req),duplex:'half'}:{})});
  const response=typeof handler==='function'?await handler(request):await handler.fetch(request,env,{waitUntil:p=>p.catch(()=>{}),passThroughOnException(){}});await sendWebResponse(response,req,res,true);
 }catch(e){console.error(e);if(!res.headersSent)res.writeHead(500);res.end('Local TEST preview failed');}
});
server.listen(57349,'127.0.0.1',()=>console.log('TEST-ONLY Agent preview: '+origin+'/__preview'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.close(()=>{env.DB.sqlite.close();process.exit(0);});server.closeAllConnections();});
