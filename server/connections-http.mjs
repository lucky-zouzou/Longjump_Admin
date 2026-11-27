import {connectorError,providers} from './tiktok-config.mjs';
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function createConnectionsHandler(service,origin){
 const cookie=(provider,value)=>`lj_oauth_${provider}=${value}; Path=/api/connections/callback/${provider}; HttpOnly; SameSite=Lax; Max-Age=${value?600:0}${origin.startsWith('https:')?'; Secure':''}`;
 return async function handle(req,res,user,sessionHash){
  const url=new URL(req.url,origin),callback=url.pathname.match(/^\/api\/connections\/callback\/(shop|ads)$/);
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
  try{
   if(callback){
    if(req.method!=='GET')throw connectorError(405,'授权回调只支持 GET');
    for(const k of ['state','code','auth_code','error'])if(url.searchParams.getAll(k).length>1)throw connectorError(400,'重复授权参数，请重新连接');
    const provider=callback[1],binding=String(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('lj_oauth_'+provider+'='))?.split('=')[1];
    const count=await service.complete(provider,url.searchParams,binding);
    res.setHeader('Set-Cookie',cookie(provider,''));
    return html(200,`已授权 ${count} 个${provider==='shop'?'店铺':'广告账户'}`, '回到连接列表，核对账号后点击“读取最近数据”。');
   }
   if(url.pathname!=='/api/connections')throw connectorError(404,'接口不存在');
   if(!user)throw connectorError(401,'请先登录公司账号');
   if(req.method==='GET')return json(200,url.searchParams.has('account')?service.details(user,url.searchParams.get('account')):service.status(user));
   if(req.method!=='POST')throw connectorError(405,'请求方法不支持');
   if(req.headers.origin!==origin)throw connectorError(403,'请求来源无效');
   let size=0,chunks=[];for await(const b of req){size+=b.length;if(size>8192)throw connectorError(413,'请求过长');chunks.push(b);}
   let p;try{p=JSON.parse(Buffer.concat(chunks).toString());}catch{throw connectorError(400,'请求格式有误');}
   if(p?.action==='authorize'){
    if(!providers.includes(p.provider))throw connectorError(400,'连接类型有误');
    const result=service.begin(user,p.provider,sessionHash);res.setHeader('Set-Cookie',cookie(p.provider,result.binding));return json(200,{url:result.url});
   }
   if(typeof p?.accountId!=='string'||p.accountId.length>80)throw connectorError(400,'请选择已授权账户');
   if(p.action==='sync')return json(200,await service.sync(user,p.accountId));
   if(p.action==='disconnect')return json(200,service.disconnect(user,p.accountId));
   throw connectorError(400,'不支持的操作');
  }catch(e){const message=e.status?e.message:'连接暂时不可用，请稍后重试';if(callback){res.setHeader('Set-Cookie',cookie(callback[1],''));return html(e.status||503,'本次连接未完成',message);}return json(e.status||503,{error:message});}
  function json(status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));}
  function html(status,title,body){res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'"});res.end(`<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LOONG JUMP · 连接结果</title><style>body{font:16px/1.7 system-ui;color:#233e44;background:#f5f8f7;padding:8vw}main{max-width:640px;margin:auto}a{color:#17685e}h1{font-size:28px}</style><main><p>LOONG JUMP · 官方授权</p><h1>${esc(title)}</h1><p>${esc(body)}</p><a href="/?page=connections">返回连接与授权 →</a></main></html>`);}
 };
}
