// Local visual test harness only. Uses built production UI and a fixed disposable fixture.
// It cannot select another database, user, bind address or port and never creates credentials.
import http from 'node:http';
import {Readable} from 'node:stream';
import {resolve} from 'node:path';
import {existsSync} from 'node:fs';
import {importServerEntryModule,tryServeStatic,sendWebResponse} from 'vinext/server/prod-server';
const fixture=resolve('work/clearance-zero-preview');
if(process.env.LOONGJUMP_CLEARANCE_ZERO_PREVIEW!=='1'||resolve(process.env.LOONGJUMP_DATA_DIR||'')!==fixture||!existsSync(fixture+'/business.sqlite'))throw Error('Requires the explicit isolated TEST-ONLY preview fixture');
const {env}=await import('../server/env.mjs');
if(!env.DB.sqlite.prepare("SELECT id FROM product_cost_versions WHERE id='TEST-ONLY-ZERO-COST-ID'").get())throw Error('Not a preview fixture');
const built=await importServerEntryModule(resolve('dist-node/server/index.js')),handler=built.default,origin='http://127.0.0.1:57323';
const server=http.createServer(async(req,res)=>{try{
 if(req.headers.host!=='127.0.0.1:57323'||req.method==='POST'&&req.headers.origin!==origin){res.writeHead(403);res.end();return;}
 const url=new URL(req.url,origin);if(['/__preview/operator','/__preview/admin','/__preview/finance'].includes(url.pathname)){res.writeHead(303,{'Set-Cookie':'test-clearance-role='+url.pathname.split('/').at(-1)+'; Path=/; SameSite=Strict',Location:'/?page=clearance'});res.end();return;}if(!['GET','HEAD','POST'].includes(req.method)){res.writeHead(405);res.end();return;}
 if(req.method!=='POST'&&await tryServeStatic(req,res,resolve('dist-node/client'),url.pathname,true))return;
 const headers=new Headers();for(const [k,v] of Object.entries(req.headers))if(!k.startsWith('oai-')&&!k.startsWith('x-local-')&&!['host','connection','transfer-encoding','x-forwarded-host','x-forwarded-proto'].includes(k)&&v!=null)headers.set(k,Array.isArray(v)?v.join(','):v);
 headers.set('host','127.0.0.1:57323');const role=String(req.headers.cookie||'').match(/test-clearance-role=(operator|finance)/)?.[1],id=role==='operator'?'id-ops':role==='finance'?'finance-1':'admin-1';const person=env.DB.sqlite.prepare('SELECT email,name FROM users WHERE id=?').get(id);headers.set('oai-authenticated-user-id',id);headers.set('oai-authenticated-user-email',person.email);headers.set('oai-authenticated-user-full-name',encodeURIComponent(person.name));headers.set('oai-authenticated-user-full-name-encoding','percent-encoded-utf-8');
 const request=new Request(url,{method:req.method,headers,...(req.method==='POST'?{body:Readable.toWeb(req),duplex:'half'}:{})});
 const response=typeof handler==='function'?await handler(request):await handler.fetch(request,env,{waitUntil:p=>p.catch(()=>{}),passThroughOnException(){}});await sendWebResponse(response,req,res,true);
 }catch(e){console.error(e);res.writeHead(500);res.end('Local preview failed');}});
server.listen(57323,'127.0.0.1',()=>console.log('TEST-ONLY preview ready at '+origin));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.close(()=>{env.DB.sqlite.close();process.exit(0);});server.closeAllConnections();});
