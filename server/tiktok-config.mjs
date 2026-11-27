import {readFileSync,statSync} from 'node:fs';
import {createHash,createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';

export const providers=['shop','ads'];
export const connectorError=(status,message)=>Object.assign(new Error(message),{status});
export const digest=value=>createHash('sha256').update(value).digest('hex');
export function readConnectionConfig(env=process.env){
 const path=env.LOONGJUMP_TIKTOK_CREDENTIALS_FILE||'secrets/tiktok_credentials.json';
 try{
  if((statSync(path).mode&0o077)!==0)throw Error('permissions');
  return JSON.parse(readFileSync(path,'utf8'));
 }catch(e){if(e.code==='ENOENT')return {};throw connectorError(503,'连接配置文件无法读取，请检查格式和私密文件权限');}
}
export function validateConfig(config,provider){
 if(!providers.includes(provider))throw connectorError(400,'不支持的连接类型');
 const c=config[provider];
 if(!c?.appId||!c?.appSecret||!c?.authorizationUrl)throw connectorError(503,'尚未配置官方应用凭据与授权链接');
 if(!/^[a-zA-Z0-9_-]{3,160}$/.test(c.appId)||typeof c.appSecret!=='string'||c.appSecret.length<8||c.appSecret.length>512)throw connectorError(503,'应用凭据格式有误');
 let url;try{url=new URL(c.authorizationUrl);}catch{throw connectorError(503,'官方授权链接格式有误');}
 const shopHost=/^services\.(?:sg|tiktokshop|[a-z]{2})\.tiktokshop\.com$/;
 // Exact official hosts and paths only; no arbitrary destinations or callback overrides.
 const valid=provider==='shop'?(shopHost.test(url.hostname)||url.hostname==='services.tiktokshop.com')&&url.pathname==='/open/authorize'&&url.searchParams.has('service_id'):
  url.hostname==='business-api.tiktok.com'&&['/portal/auth','/portal/auth/'].includes(url.pathname)&&url.searchParams.get('app_id')===c.appId;
 if(!valid||url.protocol!=='https:'||url.port||url.username||url.password||url.hash)throw connectorError(503,'请配置此应用在官方后台生成的授权链接');
 const allowed=provider==='shop'?['service_id','state','redirect_uri']:['app_id','state','redirect_uri'];
 if([...url.searchParams.keys()].some(k=>!allowed.includes(k)))throw connectorError(503,'授权链接包含不支持的参数，请重新复制官方链接');
 return {...c,authorizationUrl:url.href,hash:digest(JSON.stringify([provider,c.appId,c.appSecret,url.href]))};
}
export function readTokenKey(env=process.env){
 try{
  const path=env.LOONGJUMP_TIKTOK_TOKEN_KEY_FILE||'secrets/tiktok_token_key.txt';
  if((statSync(path).mode&0o077)!==0)throw Error('permissions');
  const raw=readFileSync(path,'utf8').trim();
  if(!/^[a-f0-9]{64}$/i.test(raw))throw Error('format');
  return Buffer.from(raw,'hex');
 }catch{throw connectorError(503,'尚未配置令牌加密密钥，请由管理员完成服务端配置');}
}
export function seal(value,key,context){
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(context));
 const data=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
 return [iv,cipher.getAuthTag(),data].map(b=>b.toString('base64url')).join('.');
}
export function unseal(value,key,context){
 try{const [iv,tag,data]=value.split('.').map(v=>Buffer.from(v,'base64url')),dec=createDecipheriv('aes-256-gcm',key,iv);dec.setAAD(Buffer.from(context));dec.setAuthTag(tag);return JSON.parse(Buffer.concat([dec.update(data),dec.final()]).toString());}
 catch{throw connectorError(503,'无法解密连接令牌，请核对服务端加密密钥或重新授权');}
}
