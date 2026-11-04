// Local visual test harness only. Uses built production UI and a fixed disposable fixture.
// It cannot select another database, user, bind address or port and never creates credentials.
import http from 'node:http';
import {Readable} from 'node:stream';
import {resolve} from 'node:path';
import {existsSync} from 'node:fs';
import {importServerEntryModule,tryServeStatic,sendWebResponse} from 'vinext/server/prod-server';
const fixture=resolve('work/creator-workflow-preview');
if(process.env.LOONGJUMP_CREATOR_PREVIEW!=='1'||resolve(process.env.LOONGJUMP_DATA_DIR||'')!==fixture||!existsSync(fixture+'/business.sqlite'))throw Error('Requires the explicit isolated TEST-ONLY preview fixture');
const {env}=await import('../server/env.mjs');
if(!env.DB.sqlite.prepare("SELECT id FROM creator_scopes WHERE shop='TEST-ONLY 印尼店'").get())throw Error('Not a preview fixture');
const built=await importServerEntryModule(resolve('dist-node/server/index.js')),handler=built.default,origin='http://127.0.0.1:57321';
const server=http.createServer(async(req,res)=>{try{
 if(req.headers.host!=='127.0.0.1:57321'||req.method==='POST'&&req.headers.origin!==origin){res.writeHead(403);res.end();return;}
 const url=new URL(req.url,origin);if(['/__preview/finance','/__preview/operator','/__preview/admin','/__preview/bd'].includes(url.pathname)){res.writeHead(303,{'Set-Cookie':'test-creator-role='+url.pathname.split('/').at(-1)+'; Path=/; SameSite=Strict',Location:'/?page=creators'});res.end();return;}if(!['GET','HEAD','POST'].includes(req.method)){res.writeHead(405);res.end();return;}
 if(req.method!=='POST'&&await tryServeStatic(req,res,resolve('dist-node/client'),url.pathname,true))return;
 const headers=new Headers();for(const [k,v] of Object.entries(req.headers))if(!k.startsWith('oai-')&&!k.startsWith('x-local-')&&!['host','connection','transfer-encoding','x-forwarded-host','x-forwarded-proto'].includes(k)&&v!=null)headers.set(k,Array.isArray(v)?v.join(','):v);
 headers.set('host','127.0.0.1:57321');const role=String(req.headers.cookie||'').match(/test-creator-role=(finance|operator|bd)/)?.[1],id=role==='finance'?'finance-1':role==='operator'?'id-ops':role==='bd'?'bd-preview':'local-admin';const person=env.DB.sqlite.prepare('SELECT email,name FROM users WHERE id=?').get(id);headers.set('oai-authenticated-user-id',id);headers.set('oai-authenticated-user-email',person.email);headers.set('oai-authenticated-user-full-name',encodeURIComponent(person.name));headers.set('oai-authenticated-user-full-name-encoding','percent-encoded-utf-8');
 const request=new Request(url,{method:req.method,headers,...(req.method==='POST'?{body:Readable.toWeb(req),duplex:'half'}:{})});
 const response=typeof handler==='function'?await handler(request):await handler.fetch(request,env,{waitUntil:p=>p.catch(()=>{}),passThroughOnException(){}});await sendWebResponse(response,req,res,true);
 }catch(e){console.error(e);res.writeHead(500);res.end('Local preview failed');}});
server.listen(57321,'127.0.0.1',()=>console.log('TEST-ONLY preview ready at '+origin));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.close(()=>{env.DB.sqlite.close();process.exit(0);});server.closeAllConnections();});
