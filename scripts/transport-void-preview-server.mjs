// Local-only built UI harness. Fixed database/port, synthetic identities, API allowlist, no outbound calls.
import http from 'node:http';
import {Readable} from 'node:stream';
import {resolve} from 'node:path';
import {existsSync,readFileSync} from 'node:fs';
import {importServerEntryModule,tryServeStatic,sendWebResponse} from 'vinext/server/prod-server';
const fixture=resolve('work/transport-void-preview'),origin='http://127.0.0.1:57342';
if(process.env.LOONGJUMP_TRANSPORT_VOID_PREVIEW!=='1'||resolve(process.env.LOONGJUMP_DATA_DIR||'')!==fixture||!existsSync(fixture+'/business.sqlite'))throw Error('Requires the explicit isolated TEST-ONLY transport-void fixture');
const marker=JSON.parse(readFileSync(fixture+'/fixture.json','utf8'));if(marker.source!=='SYNTHETIC_ONLY_TRANSPORT_VOID')throw Error('Not the synthetic preview fixture');
// Remove inherited provider values before loading server/env; no secret contents are read.
for(const key of Object.keys(process.env))if(/OPENAI|ANTHROPIC|DASHSCOPE|QWEN|FEISHU|BEST_|EXCHANGERATE|MATERIALS_|API_KEY|API_SECRET|CREDENTIAL|TOKEN_FILE/.test(key))delete process.env[key];
process.env.LOONGJUMP_OPENAI_KEY_FILE=fixture+'/DISABLED-NO-SECRETS';process.env.MATERIALS_ENABLED='0';
globalThis.fetch=async()=>{throw Error('Outbound networking disabled in TEST-ONLY transport-void preview');};
const {env}=await import('../server/env.mjs');env.readEmployeeAssistantKey=()=>'';env.readExchangeRateKey=()=>'';env.COMPANY_ACCOUNTS={create:()=>{throw Error('Account creation disabled in preview');}};env.BEST_PARTNER_ID='';env.BEST_API_SECRET='';
if(!env.DB.sqlite.prepare('SELECT id FROM transport_legs WHERE id=?').get(marker.leg.id))throw Error('Synthetic transport marker is missing');
const built=await importServerEntryModule(resolve('dist-node/server/index.js')),handler=built.default;
const roles={admin:{id:'admin-1',label:'管理员',page:'batches'},supply:{id:'supply-1',label:'供应链',page:'batches'},sea:{id:'sea-1',label:'海运（只读删除记录）',page:'batches'}};
const allowedPages=new Set(['batches']),apiMethods=new Map([['/api/product-images',['GET']],['/api/sku-catalog',['GET']]]);
const csp="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'none'; form-action 'self'";
const server=http.createServer(async(req,res)=>{try{
 res.setHeader('Content-Security-Policy',csp);res.setHeader('X-Content-Type-Options','nosniff');
 if(req.headers.host!=='127.0.0.1:57342'||req.method==='POST'&&req.headers.origin!==origin){res.writeHead(403);res.end('Local preview origin only');return;}
 if(!['GET','HEAD','POST'].includes(req.method)){res.writeHead(405);res.end();return;}
 const url=new URL(req.url,origin),match=/^\/__preview\/(admin|supply|sea)$/.exec(url.pathname);
 if(match&&req.method==='GET'){res.writeHead(303,{'Set-Cookie':`test-transport-void-role=${match[1]}; Path=/; HttpOnly; SameSite=Strict`,Location:`/?page=${roles[match[1]].page}`});res.end();return;}
 if(url.pathname==='/__preview'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>TEST ONLY · 海运旧单删除预览</title></head><body style="font:18px system-ui;max-width:900px;margin:60px auto;padding:24px;color:#233b50;background:#f4f7fa"><h1>旧海运单删除 · 本地预览</h1><p>以下均为合成演示数据，仅在本机隔离库操作；外部接口与密钥读取已关闭。</p><nav>${Object.entries(roles).map(([key,v])=>`<p><a href="/__preview/${key}">${v.label}</a></p>`).join('')}</nav><p>TEST-OLD-SEA-001-01：10件旧海运单仍待签收，10件已通过历史到仓另录。删除旧单后，库存不变，在途清零。</p></body></html>`);return;}
 let postBody;
 if(url.pathname.startsWith('/api/')){
  if(url.pathname==='/api/system'&&req.method==='POST'){
   const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>32768)throw Error('Preview payload too large');chunks.push(chunk);}
   postBody=Buffer.concat(chunks).toString('utf8');if(!['transportVoidCandidates','voidTransportLeg'].includes(JSON.parse(postBody).action)){res.writeHead(403);res.end('Only transport void actions are enabled');return;}
  }
  const shell=url.pathname==='/api/system'&&req.method==='GET'&&allowedPages.has(url.searchParams.get('module'))&&['page','shell','tasks'].includes(url.searchParams.get('navigation'))&&[...url.searchParams.keys()].every(k=>['module','navigation'].includes(k));
  if(!shell&&!postBody&&!apiMethods.get(url.pathname)?.includes(req.method)){res.writeHead(403,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'此本地预览只开放海运旧单删除及必要的只读工作区接口'}));return;}
 }
 if(req.method!=='POST'&&await tryServeStatic(req,res,resolve('dist-node/client'),url.pathname,true))return;
 const roleName=String(req.headers.cookie||'').match(/test-transport-void-role=(admin|supply|sea)(?:;|$)/)?.[1]||'admin',role=roles[roleName];
 if(url.pathname==='/'&&!allowedPages.has(url.searchParams.get('page'))){res.writeHead(303,{Location:`/?page=${role.page}`});res.end();return;}
 if(!url.pathname.startsWith('/api/')&&url.pathname!=='/'){res.writeHead(404);res.end('Preview page not enabled');return;}
 const headers=new Headers();for(const [k,v] of Object.entries(req.headers))if(!k.startsWith('oai-')&&!k.startsWith('x-local-')&&!['host','connection','transfer-encoding','x-forwarded-host','x-forwarded-proto'].includes(k)&&v!=null)headers.set(k,Array.isArray(v)?v.join(','):v);
 const person=env.DB.sqlite.prepare('SELECT email,name FROM users WHERE id=?').get(role.id);headers.set('host','127.0.0.1:57342');headers.set('oai-authenticated-user-id',role.id);headers.set('oai-authenticated-user-email',person.email);headers.set('oai-authenticated-user-full-name',encodeURIComponent(person.name));headers.set('oai-authenticated-user-full-name-encoding','percent-encoded-utf-8');
 const request=new Request(url,{method:req.method,headers,...(req.method==='POST'?{body:postBody??Readable.toWeb(req),duplex:'half'}:{})});const response=typeof handler==='function'?await handler(request):await handler.fetch(request,env,{waitUntil:p=>p.catch(()=>{}),passThroughOnException(){}});await sendWebResponse(response,req,res,true);
 }catch(e){console.error('Transport void preview failed:',e.message);if(!res.headersSent)res.writeHead(500);res.end('Local preview failed');}});
server.listen(57342,'127.0.0.1',()=>console.log('TEST-ONLY transport-void preview: '+origin+'/__preview'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.close(()=>{env.DB.sqlite.close();process.exit(0);});server.closeAllConnections();});
