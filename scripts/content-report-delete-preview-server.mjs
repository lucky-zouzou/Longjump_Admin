// Local-only built UI harness: fixed data, identities and port; no external calls or secrets.
import http from 'node:http';
import {resolve} from 'node:path';
import {existsSync,readFileSync} from 'node:fs';
import {importServerEntryModule,tryServeStatic,sendWebResponse} from 'vinext/server/prod-server';

const fixture=resolve('work/content-report-delete-preview'),origin='http://127.0.0.1:57343';
if(process.env.LOONGJUMP_CONTENT_REPORT_DELETE_PREVIEW!=='1'||resolve(process.env.LOONGJUMP_DATA_DIR||'')!==fixture||!existsSync(fixture+'/business.sqlite'))
 throw Error('Requires the explicit isolated TEST-ONLY content report delete fixture');
const marker=JSON.parse(readFileSync(fixture+'/fixture.json','utf8'));
if(marker.source!=='SYNTHETIC_ONLY_CONTENT_REPORT_DELETE')throw Error('Not the synthetic content preview fixture');
for(const key of Object.keys(process.env))
 if(/OPENAI|ANTHROPIC|DASHSCOPE|QWEN|FEISHU|BEST_|EXCHANGERATE|MATERIALS_|API_KEY|API_SECRET|CREDENTIAL|TOKEN_FILE/.test(key))delete process.env[key];
process.env.LOONGJUMP_OPENAI_KEY_FILE=fixture+'/DISABLED-NO-SECRETS';process.env.MATERIALS_ENABLED='0';
globalThis.fetch=async()=>{throw Error('Outbound networking disabled in TEST-ONLY content report delete preview');};
const {env}=await import('../server/env.mjs');
env.readEmployeeAssistantKey=()=>'';env.readExchangeRateKey=()=>'';
env.COMPANY_ACCOUNTS={create:()=>{throw Error('Account creation disabled in preview');}};
env.BEST_PARTNER_ID='';env.BEST_API_SECRET='';
const roles={my:{id:'my-ops',label:'马来运营 · 可删除本人记录'},'my-other':{id:'my-preview-other',label:'马来同站运营 · 他人记录只读'},
 admin:{id:'admin-1',label:'管理员'},studio:{id:'studio-demo',label:'拍摄剪辑 · 只读'},id:{id:'id-ops',label:'印尼运营 · 站点隔离'}};
for(const [key,role] of Object.entries(roles)){
 const person=env.DB.sqlite.prepare('SELECT name,email FROM users WHERE id=?').get(role.id);
 if(marker.actors[key]!==role.id||!person?.name.startsWith('TEST ONLY ')||!person.email.endsWith('@example.test'))throw Error('Synthetic account marker mismatch');
}
const built=await importServerEntryModule(resolve('dist-node/server/index.js')),handler=built.default;
const csp="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'none'; form-action 'self'";
const server=http.createServer(async(req,res)=>{try{
 res.setHeader('Content-Security-Policy',csp);res.setHeader('X-Content-Type-Options','nosniff');
 if(req.headers.host!=='127.0.0.1:57343'||req.method==='POST'&&req.headers.origin!==origin){res.writeHead(403);res.end('Local preview origin only');return;}
 if(!['GET','HEAD','POST'].includes(req.method)){res.writeHead(405);res.end();return;}
 const url=new URL(req.url,origin),match=/^\/__preview\/(my|my-other|admin|studio|id)$/.exec(url.pathname);
 if(match&&req.method==='GET'){res.writeHead(303,{'Set-Cookie':`test-content-report-delete-role=${match[1]}; Path=/; HttpOnly; SameSite=Strict`,Location:'/?page=content-center'});res.end();return;}
 if(url.pathname==='/__preview'&&req.method==='GET'){
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
  res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>TEST ONLY · 数据罗盘删除预览</title></head><body style="font:18px system-ui;max-width:900px;margin:60px auto;padding:24px;color:#233b50;background:#f4f7fa"><h1>数据罗盘删除 · 本地预览</h1><p>全部为合成演示数据，仅在本机隔离库操作；外部接口及密钥读取已关闭。</p><nav>${Object.entries(roles).map(([key,v])=>`<p><a href="/__preview/${key}">${v.label}</a></p>`).join('')}</nav><p>马来西亚 TikTok：9,948 次播放，16 单，原币 GMV 2 MYR，演示汇率 1.63，折合 ¥3.26。进入内容中心后点击“数据罗盘”。</p><p>删除只修改本地合成记录；同站其他运营只能查看，不能删除本人以外的记录。</p></body></html>`);return;
 }
 let postBody;
 if(url.pathname.startsWith('/api/')){
  if(url.pathname==='/api/content-center'&&req.method==='POST'){
   const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>32768)throw Error('Preview payload too large');chunks.push(chunk);}
   postBody=Buffer.concat(chunks).toString('utf8');
   if(JSON.parse(postBody).action!=='deletePlatformReport'){res.writeHead(403);res.end('Only synthetic report deletion is enabled');return;}
  }
  const shell=url.pathname==='/api/system'&&req.method==='GET'&&url.searchParams.get('module')==='content-center'&&['page','shell','tasks'].includes(url.searchParams.get('navigation'))&&[...url.searchParams.keys()].every(k=>['module','navigation'].includes(k));
  const read=req.method==='GET'&&['/api/content-center','/api/product-images','/api/sku-catalog'].includes(url.pathname);
  if(!shell&&!read&&!postBody){res.writeHead(403,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'此本地预览只开放报表删除及必要的只读内容中心接口'}));return;}
 }
 if(req.method!=='POST'&&await tryServeStatic(req,res,resolve('dist-node/client'),url.pathname,true))return;
 const roleName=String(req.headers.cookie||'').match(/test-content-report-delete-role=(my|my-other|admin|studio|id)(?:;|$)/)?.[1]||'my',role=roles[roleName];
 if(url.pathname==='/'&&url.searchParams.get('page')!=='content-center'){res.writeHead(303,{Location:'/?page=content-center'});res.end();return;}
 if(!url.pathname.startsWith('/api/')&&url.pathname!=='/'){res.writeHead(404);res.end('Preview page not enabled');return;}
 const headers=new Headers();
 for(const [k,v] of Object.entries(req.headers))if(!k.startsWith('oai-')&&!k.startsWith('x-local-')&&!['host','connection','transfer-encoding','x-forwarded-host','x-forwarded-proto'].includes(k)&&v!=null)headers.set(k,Array.isArray(v)?v.join(','):v);
 const person=env.DB.sqlite.prepare('SELECT email,name FROM users WHERE id=?').get(role.id);
 headers.set('host','127.0.0.1:57343');headers.set('oai-authenticated-user-id',role.id);headers.set('oai-authenticated-user-email',person.email);
 headers.set('oai-authenticated-user-full-name',encodeURIComponent(person.name));headers.set('oai-authenticated-user-full-name-encoding','percent-encoded-utf-8');
 const request=new Request(url,{method:req.method,headers,...(req.method==='POST'?{body:postBody}:{})});
 const response=typeof handler==='function'?await handler(request):await handler.fetch(request,env,{waitUntil:p=>p.catch(()=>{}),passThroughOnException(){}});
 await sendWebResponse(response,req,res,true);
 }catch(e){console.error('Content report delete preview failed:',e.message);if(!res.headersSent)res.writeHead(500);res.end('Local preview failed');}});
server.listen(57343,'127.0.0.1',()=>console.log('TEST-ONLY content report delete preview: '+origin+'/__preview/my'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.close(()=>{env.DB.sqlite.close();process.exit(0);});server.closeAllConnections();});
