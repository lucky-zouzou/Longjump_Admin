import {createConnections} from './platform-connections.mjs';
import {createConnectionsHandler} from './connections-http.mjs';
import {scheduleAgentPilot} from './agent-pilot-monitor.mjs';
import {createRequestMetrics} from './request-metrics.mjs';
import {startWholesaleReservationMonitor} from './wholesale-reservation-monitor.mjs';
import {scheduleForecastMonitor} from './forecast-monitor.mjs';
import {scheduleFeishuAttendance} from './feishu-attendance-monitor.mjs';
import http from 'node:http';
import {readWorkplaceWeather} from '../lib/workplace-weather.mjs';
import {handleDistributorApplication} from '../lib/distributor-application.mjs';
import {handleDistributor} from '../lib/distributor-http.mjs';
import {handleWebsiteInquiry} from '../lib/website-inquiry-handler.mjs';
import {pollBestTracking} from '../lib/best-tracking.mjs';
import {schedulePromotionMonitor} from './promotion-monitor.mjs';
import {scheduleBusinessActionMonitor} from './business-action-monitor.mjs';
import {Readable} from 'node:stream';
import {resolve} from 'node:path';
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {handleBaseline} from './inventory-baseline.mjs';
import {handleCleanup} from './test-cleanup.mjs';
import {env} from './env.mjs';
import {accountSchema,verifyPassword,hashToken,setAccount} from './accounts.mjs';
import {importServerEntryModule,tryServeStatic,sendWebResponse} from 'vinext/server/prod-server';
const origin=new URL(process.env.LOONGJUMP_ORIGIN||'http://localhost:3000');
if(origin.protocol!=='https:'&&!(process.env.LOONGJUMP_ALLOW_HTTP==='1'&&['localhost','127.0.0.1'].includes(origin.hostname)))throw Error('Set LOONGJUMP_ORIGIN to the public HTTPS origin; local testing requires LOONGJUMP_ALLOW_HTTP=1');
const db=env.DB.sqlite;accountSchema(db);
const connectionsHandler=createConnectionsHandler(createConnections({db,origin:origin.origin}),origin.origin);
if(!db.prepare('SELECT 1 FROM local_accounts LIMIT 1').get()&&process.env.LOONGJUMP_ADMIN_PASSWORD_FILE){setAccount(db,{id:process.env.LOONGJUMP_ADMIN_ID||'company-admin',email:process.env.LOONGJUMP_ADMIN_EMAIL,name:process.env.LOONGJUMP_ADMIN_NAME||'公司管理员',role:'管理员',password:readFileSync(process.env.LOONGJUMP_ADMIN_PASSWORD_FILE,'utf8').trim()});}
if(!db.prepare('SELECT 1 FROM local_accounts LIMIT 1').get())throw Error('Create a company account with server/cli.mjs account:add before starting');
const built=await importServerEntryModule(resolve('dist-node/server/index.js')),handler=built.default;
const cookie=(name,value,maxAge=0)=>`${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${origin.protocol==='https:'?'; Secure':''}`;
const cookies=req=>Object.fromEntries(String(req.headers.cookie||'').split(';').map(p=>p.trim().split('=')).filter(p=>p.length===2));
const loginPage=(token,message='')=>`<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>LOONG JUMP 公司登录</title><link rel="icon" href="/favicon.png">
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;min-height:100svh;display:grid;place-items:center;padding:20px 0;
  font-family:system-ui,sans-serif;color:#20394a;background-color:#f4f7f6;
  background-image:radial-gradient(ellipse at 12% 12%,#fff1cf 0,transparent 48%),radial-gradient(ellipse at 96% 85%,#deeee8 0,transparent 52%)}
main{width:min(92vw,462px);padding:clamp(22px,5vw,36px);background:#fff;border:1px solid #e2e8e3;border-radius:20px;box-shadow:0 14px 48px #233e3610}
h1{margin:0;line-height:1}h1 img{width:106px;height:auto;display:block}
.subtitle{color:#536c71;margin:13px 0 16px;font-size:14px}
workplace-welcome{display:block;background:#fbf8ef;border-radius:12px;padding:12px 14px;margin:0 0 22px}
form{font-size:14px}label{display:block;color:#2e4b51}input:not([type=checkbox]),button{display:block;width:100%;min-height:42px;font:inherit;padding:10px 12px;border-radius:8px}
input:not([type=checkbox]){border:1px solid #bacbc8;margin:5px 0 16px}input:focus-visible,button:focus-visible{outline:2px solid #2d7971;outline-offset:2px}
.remember{display:flex;align-items:center;gap:8px;font-size:12px}.remember input{margin:0}
button{margin-top:14px;background:#174e49;color:#fff;border:0;font-weight:650;cursor:pointer}
.help{color:#5c7074;font-size:12px;line-height:1.6;margin:16px 0 0}.error{color:#a2342c}
</style><script type="module" src="/workplace-welcome.js"></script></head><body>
<main><h1><img src="/loong-jump-logo-black.png" alt="LOONG JUMP" width="106" height="50"></h1>
<p class="subtitle">公司账号登录 · Masuk Akun Perusahaan</p>
<workplace-welcome>很高兴见到你！</workplace-welcome>
<form method="post" action="/signin-with-chatgpt">${message?'<p role="alert" class="error">'+message+'</p>':''}
<input type="hidden" name="csrf" value="${token}">
<label>邮箱 / Email<input type="email" name="email" autocomplete="username" required></label>
<label>密码 / Kata Sandi<input type="password" name="password" autocomplete="current-password" required></label>
<label class="remember"><input type="checkbox" name="remember" value="1">在此私人设备保持登录30天 / Tetap masuk 30 hari</label>
<button>登录 / Masuk</button><p class="help">账号由公司管理员开通。Akun dibuat oleh administrator perusahaan.</p>
</form></main></body></html>`;
async function smallBody(req){let chunks=[],size=0;for await(const b of req){size+=b.length;if(size>4096)throw Error('Login request too large');chunks.push(b)}return new URLSearchParams(Buffer.concat(chunks).toString())}
const requestMetrics=createRequestMetrics();
const server=http.createServer(async(req,res)=>{const started=performance.now();res.once('finish',()=>{try{const observed=new URL(req.url,origin);requestMetrics.record(observed.pathname,performance.now()-started,res.statusCode,observed.searchParams);}catch{}});try{
 res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=(self)');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','same-origin');res.setHeader('Cache-Control','no-store');
 if(req.headers.host!==origin.host){res.writeHead(400);res.end('Invalid host');return}const url=new URL(req.url,origin);
 if(['/distributor','/api/distributor','/distributor/apply'].includes(url.pathname)){
  const request=new Request(url,{method:req.method,headers:req.headers,...(req.method==='POST'?{body:Readable.toWeb(req),duplex:'half'}:{})});
  const response=url.pathname==='/distributor/apply'?await handleDistributorApplication(request,env.DB):await handleDistributor(request,env.DB,env.WHOLESALE_FILES,env);
  await sendWebResponse(response,req,res,true);return;
 }
 if(['GET','HEAD'].includes(req.method)&&url.pathname==='/favicon.ico'){res.writeHead(302,{location:'/favicon.png'});res.end();return;}
 if(['GET','HEAD'].includes(req.method)&&['/favicon.png','/workplace-welcome.js','/workplace-greeting.js','/distributor-assets/materials.js','/distributor-assets/materials.css','/distributor-assets/brand.css','/distributor-assets/partner-green.webp','/distributor-assets/partner-pink.webp','/distributor-assets/payment.js','/distributor-assets/service.js','/distributor-assets/ordering.js','/distributor-assets/ordering.css','/distributor-assets/application.css','/loong-jump-logo-black.png'].includes(url.pathname)){
  if(!await tryServeStatic(req,res,resolve('dist-node/client'),url.pathname,true,undefined,{'Cache-Control':'public, no-cache'})){res.writeHead(404);res.end();}
  return;
 }
 if(url.pathname==='/api/integrations/website-inquiries'){
  const request=new Request(url,{method:req.method,headers:req.headers,...(req.method==='POST'?{body:Readable.toWeb(req),duplex:'half'}:{})});
  await sendWebResponse(await handleWebsiteInquiry(request,env.DB,process.env.LOONGJUMP_INQUIRY_SYNC_SECRET,process.env.LOONGJUMP_INQUIRY_SOURCE||'loongjump-website'),req,res,true);return;
 }
 if(!['GET','HEAD','POST'].includes(req.method)){res.writeHead(405);res.end();return}
 if(req.method==='POST'&&req.headers.origin!==origin.origin){res.writeHead(403);res.end('Invalid origin');return}
 if(url.pathname==='/api/workplace-weather'){
  if(req.method!=='GET'){res.writeHead(405,{allow:'GET'});res.end();return;}
  const {status,body}=await readWorkplaceWeather(url.searchParams);
  res.writeHead(status,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(body));return;
 }
 if(url.pathname==='/healthz'&&req.method==='GET'){
  db.prepare('SELECT report_kind FROM sales_imports LIMIT 1').get();
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,release:process.env.LOONGJUMP_RELEASE||'local'}));return;
 }
 const c=cookies(req);
 if(url.pathname.startsWith('/api/connections/callback/')){await connectionsHandler(req,res,null,null);return;}
 if(url.pathname==='/signin-with-chatgpt'){
  const csrf=randomBytes(24).toString('hex');let message='';
  if(req.method==='POST'){
   const input=await smallBody(req);if(!c.lj_login||input.get('csrf')!==c.lj_login){res.writeHead(403);res.end('Invalid form token');return}
   const email=String(input.get('email')||'').trim().toLowerCase(),key=hashToken(email),now=Date.now(),attempt=db.prepare('SELECT * FROM local_login_attempts WHERE key=?').get(key);
   if(attempt&&now-attempt.window_start<900000&&attempt.attempts>=8){res.writeHead(429);res.end('Too many attempts. Retry in 15 minutes.');return}
   db.prepare('INSERT INTO local_login_attempts VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN window_start<? THEN 1 ELSE attempts+1 END,window_start=CASE WHEN window_start<? THEN excluded.window_start ELSE window_start END').run(key,now,now-900000,now-900000);
   const account=db.prepare('SELECT a.*,u.active FROM local_accounts a JOIN users u ON u.id=a.user_id WHERE a.email=?').get(email);
   // Same scrypt work for unknown email reduces account enumeration by timing.
   const dummy='scrypt:00000000000000000000000000000000:'+('00'.repeat(64));
   if(verifyPassword(input.get('password')||'',account?.password_hash||dummy)&&account?.active===1){const token=randomBytes(32).toString('hex'),ttl=input.get('remember')==='1'?30*86400:28800;db.prepare('INSERT INTO local_sessions VALUES (?,?,?)').run(hashToken(token),account.user_id,now+ttl*1000);db.prepare('DELETE FROM local_login_attempts WHERE key=?').run(key);res.writeHead(303,{'location':'/','set-cookie':[cookie('lj_session',token,ttl),cookie('lj_workspace_visit',randomBytes(12).toString('hex'),ttl),cookie('lj_login','',0)]});res.end();return}message='邮箱或密码不正确 / Email atau kata sandi salah';
  }
  res.writeHead(req.method==='POST'?401:200,{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",'set-cookie':cookie('lj_login',csrf,900)});res.end(loginPage(csrf,message));return;
 }
 const user=c.lj_session?db.prepare('SELECT u.* FROM local_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1').get(hashToken(c.lj_session),Date.now()):null;
 if(url.pathname==='/signout-with-chatgpt'){if(c.lj_session)db.prepare('DELETE FROM local_sessions WHERE token_hash=?').run(hashToken(c.lj_session));res.writeHead(303,{'location':'/signin-with-chatgpt','set-cookie':[cookie('lj_session','',0),cookie('lj_workspace_visit','',0)]});res.end();return}
 if(!user){if(url.pathname.startsWith('/api/')){res.writeHead(401,{'content-type':'application/json'});res.end(JSON.stringify({error:'请登录公司账号 / Silakan masuk'}));}else{res.writeHead(303,{'location':'/signin-with-chatgpt'});res.end()}return}
 if(url.pathname==='/api/connections'){await connectionsHandler(req,res,user,hashToken(c.lj_session));return;}
 if(url.pathname==='/api/system-performance'&&req.method==='GET'){res.writeHead(user.role==='管理员'?200:403,{'content-type':'application/json'});res.end(JSON.stringify(user.role==='管理员'?requestMetrics.snapshot():{error:'仅管理员可查看性能诊断'}));return;}
 if(url.pathname==='/admin/inventory-baseline'||url.pathname==='/api/inventory-baseline'){await handleBaseline(req,res,env,user);return}
 if(url.pathname==='/admin/test-cleanup'||url.pathname==='/api/test-cleanup'){await handleCleanup(req,res,env,user);return}
 if(req.method==='GET'||req.method==='HEAD'){if(await tryServeStatic(req,res,resolve('dist-node/client'),url.pathname,true))return}
 if(Number(req.headers['content-length']||0)>22*1024*1024){res.writeHead(413);res.end();return}
 const h=new Headers();for(const [k,v] of Object.entries(req.headers))if(!k.startsWith('oai-')&&!k.startsWith('x-local-')&&!['host','connection','transfer-encoding','x-forwarded-host','x-forwarded-proto'].includes(k)&&v!=null)h.set(k,Array.isArray(v)?v.join(','):v);
 h.set('host',origin.host);h.set('oai-authenticated-user-id',user.id);h.set('oai-authenticated-user-email',user.email);h.set('oai-authenticated-user-full-name',encodeURIComponent(user.name));h.set('oai-authenticated-user-full-name-encoding','percent-encoded-utf-8');
 const request=new Request(url,{method:req.method,headers:h,...(req.method==='POST'?{body:Readable.toWeb(req),duplex:'half'}:{})});const result=typeof handler==='function'?await handler(request):await handler.fetch(request,env,{waitUntil:p=>p.catch(()=>{}),passThroughOnException(){}});
 res.setHeader('Server-Timing','app;dur='+(performance.now()-started).toFixed(1));
 await sendWebResponse(result,req,res,true);
 }catch(error){console.error('Request failed:',error.message);if(!res.headersSent){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:'服务器处理失败，请查看管理日志'}))}else res.destroy(error)}});
server.requestTimeout=120000;server.headersTimeout=15000;
server.listen(Number(process.env.PORT||3000),process.env.HOST||'0.0.0.0',()=>console.log(`LOONG JUMP ready at ${origin.origin}`));
if(process.env.LOONGJUMP_BACKUP_DIR){const {scheduleBackups}=await import('./backup.mjs');scheduleBackups(env,process.env.LOONGJUMP_BACKUP_DIR);}
schedulePromotionMonitor(env.DB);
scheduleBusinessActionMonitor(env.DB);
scheduleForecastMonitor(env.DB);
const wholesaleReservationMonitor=startWholesaleReservationMonitor(env.DB);
const feishuMonitor=scheduleFeishuAttendance(env);
const agentPilotMonitor=scheduleAgentPilot(env.DB);
server.on('close',()=>{wholesaleReservationMonitor.stop();feishuMonitor.stop();agentPilotMonitor.stop();});

for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>{db.close();process.exit(0)}));

if (env.BEST_PARTNER_ID && env.BEST_API_SECRET) {
  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    try { await pollBestTracking(env.DB, env); }
    catch (error) { if (error.status !== 409) console.error('BEST tracking sync unavailable'); }
    finally { polling = false; }
  };
  void poll();
  setInterval(poll, 60000).unref();
}
