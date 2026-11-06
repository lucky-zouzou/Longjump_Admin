// Preview the real Admin UI against disposable records. Bind only to loopback and
// allow writes exclusively to the content center. Never accepts caller identity.
import http from 'node:http';
import {Readable} from 'node:stream';
import {resolve} from 'node:path';
import {existsSync} from 'node:fs';
import {importServerEntryModule,tryServeStatic,sendWebResponse} from 'vinext/server/prod-server';
const root=resolve('work/content-center-preview'),host='127.0.0.1:57324',origin='http://'+host;
if(process.env.LOONGJUMP_CONTENT_PREVIEW!=='1'||resolve(process.env.LOONGJUMP_DATA_DIR||'')!==root||!existsSync(root+'/business.sqlite'))throw Error('Explicit synthetic content fixture required');
const {env}=await import('../server/env.mjs');
if(!env.DB.sqlite.prepare("SELECT id FROM users WHERE id='studio-demo' AND role='拍摄剪辑'").get())throw Error('Synthetic actor missing');
const roles={admin:'admin-1',studio:'studio-demo',id:'id-ops',my:'my-ops'};
const built=await importServerEntryModule(resolve('dist-node/server/index.js')),handler=built.default;
const server=http.createServer(async(req,res)=>{
 try{
  if(req.headers.host!==host){res.writeHead(403).end();return;}
  const url=new URL(req.url,origin);
  if(req.method==='GET'&&url.pathname.startsWith('/__preview/')){
    const role=url.pathname.split('/').at(-1);if(!Object.hasOwn(roles,role)){res.writeHead(404).end();return;}
    res.writeHead(303,{'Set-Cookie':'cc-preview='+role+'; Path=/; HttpOnly; SameSite=Strict',Location:'/?page=content-center'}).end();return;
  }
  if(!['GET','HEAD','POST'].includes(req.method)||req.method==='POST'&&(req.headers.origin!==origin||!['/api/content-center','/api/content-center/materials'].includes(url.pathname))){res.writeHead(403).end();return;}
  if(req.method!=='POST'&&await tryServeStatic(req,res,resolve('dist-node/client'),url.pathname,true))return;
  if(!['/','/api/system','/api/content-center','/api/content-center/materials'].includes(url.pathname)){res.writeHead(404).end();return;}
  const role=String(req.headers.cookie||'').match(/(?:^|;\s*)cc-preview=(admin|studio|id|my)(?:;|$)/)?.[1]||'admin';
  const person=env.DB.sqlite.prepare('SELECT id,name,email FROM users WHERE id=?').get(roles[role]);
  const headers=new Headers();for(const [k,v] of Object.entries(req.headers))if(!k.startsWith('oai-')&&!k.startsWith('x-local-')&&!['host','connection','transfer-encoding','x-forwarded-host','x-forwarded-proto'].includes(k)&&v!=null)headers.set(k,Array.isArray(v)?v.join(','):v);
  headers.set('host',host);headers.set('oai-authenticated-user-id',person.id);headers.set('oai-authenticated-user-email',person.email);
  headers.set('oai-authenticated-user-full-name',encodeURIComponent(person.name));headers.set('oai-authenticated-user-full-name-encoding','percent-encoded-utf-8');
  const request=new Request(url,{method:req.method,headers,...(req.method==='POST'?{body:Readable.toWeb(req),duplex:'half'}:{})});
  const response=typeof handler==='function'?await handler(request):await handler.fetch(request,env,{waitUntil:p=>p.catch(()=>{}),passThroughOnException(){}});
  await sendWebResponse(response,req,res,true);
 }catch(e){console.error(e);if(!res.headersSent)res.writeHead(500);res.end('Local preview failed');}
});
server.listen(57324,'127.0.0.1',()=>console.log('Synthetic preview ready at '+origin+'/?page=content-center'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.close(()=>{env.DB.sqlite.close();process.exit(0);});server.closeAllConnections();});
