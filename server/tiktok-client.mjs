import {createHmac} from 'node:crypto';
import {connectorError} from './tiktok-config.mjs';

const SHOP='https://open-api.tiktokglobalshop.com',AUTH='https://auth.tiktok-shops.com',ADS='https://business-api.tiktok.com/open_api/v1.3';
const list=(value)=>{if(!Array.isArray(value))throw connectorError(502,'平台未返回完整列表，本次未覆盖已有数据');return value;};
export function externalId(value){
 if(typeof value==='number'&&!Number.isSafeInteger(value))throw connectorError(502,'平台编号精度异常，本次未保存');
 if(!/^[a-zA-Z0-9_-]{1,120}$/.test(String(value??'')))throw connectorError(502,'平台未返回有效账号或订单编号');return String(value);
}
const text=(v,max=200)=>typeof v==='string'?v.slice(0,max):'';
const number=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v):null;
export function shopSignature(path,query,body,secret){
 const params=Object.keys(query).filter(k=>!['sign','access_token'].includes(k)).sort().map(k=>k+query[k]).join('');
 return createHmac('sha256',secret).update(secret+path+params+(body||'')+secret).digest('hex');
}
export function createTikTokClient({fetcher=globalThis.fetch,now=()=>Date.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 async function call(url,{method='GET',headers={},body,retry=false,deadline=now()+15000}={}){
  for(let attempt=0;attempt<2;attempt++){
   let response,payload;
   try{
    if(now()>=deadline)throw Error('deadline');
    response=await fetcher(url,{method,headers:{'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(Math.max(1,Math.min(12000,deadline-now())))});
    if(retry&&attempt===0&&(response.status===429||response.status>=500)){await response.body?.cancel();await sleep(400);continue;}
    if(!response.ok){await response.body?.cancel();throw connectorError(response.status===429?429:502,response.status===429?'平台调用频率受限，请稍后重试':'平台暂时无法读取，请稍后重试');}
    const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.byteLength;if(size>5000000)throw Error('too large');chunks.push(Buffer.from(chunk));}
    payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   }catch(e){if(e.status)throw e;throw connectorError(502,'平台连接超时或返回格式异常，请稍后重试');}
   if(payload.code!==0){const code=String(payload.code);const auth=['105001','105002','40100','40101','40102'].includes(code);throw connectorError(auth?401:502,auth?'平台授权已失效，请重新连接':`平台未完成读取（错误码 ${/^\d{1,10}$/.test(code)?code:'未知'}），请检查应用权限后重试`);}
   if(!payload.data||typeof payload.data!=='object')throw connectorError(502,'平台未返回数据，请稍后重试');
   return payload.data;
  }
 }
 async function shop(c,token,path,query={},body,deadline){
  const q={...query,app_key:c.appId,timestamp:Math.floor(now()/1000)};
  q.sign=shopSignature(path,q,body===undefined?'':JSON.stringify(body),c.appSecret);
  return call(SHOP+path+'?'+new URLSearchParams(q),{method:body===undefined?'GET':'POST',body,headers:{'x-tts-access-token':token.accessToken},retry:true,deadline});
 }
 async function ads(token,path,query={},deadline){return call(ADS+path+'?'+new URLSearchParams(Object.entries(query).map(([k,v])=>[k,typeof v==='object'?JSON.stringify(v):String(v)])),{headers:{'Access-Token':token.accessToken},retry:true,deadline});}
 function shopToken(d){
  if(d.user_type!==0||!text(d.access_token,10000)||!text(d.refresh_token,10000)||!Number.isFinite(Number(d.access_token_expire_in))||Number(d.access_token_expire_in)*1000<=now())throw connectorError(502,'店铺未返回有效商家授权，请使用商家账号重新连接');
  return {accessToken:d.access_token,refreshToken:d.refresh_token,expiresAt:Number(d.access_token_expire_in)*1000,refreshExpiresAt:Number(d.refresh_token_expire_in)*1000||null};
 }
 return {
  async exchange(provider,c,code){
   if(provider==='shop')return shopToken(await call(AUTH+'/api/v2/token/get?'+new URLSearchParams({app_key:c.appId,app_secret:c.appSecret,auth_code:code,grant_type:'authorized_code'})));
   const d=await call(ADS+'/oauth2/access_token/',{method:'POST',body:{app_id:c.appId,secret:c.appSecret,auth_code:code}});
   if(!text(d.access_token,10000))throw connectorError(502,'广告平台未返回有效授权');
   return {accessToken:d.access_token,expiresAt:null};
  },
  async refresh(c,token){
   if(!token.refreshToken||token.refreshExpiresAt&&token.refreshExpiresAt<=now())throw connectorError(401,'店铺授权已到期，请重新连接');
   const d=await call(AUTH+'/api/v2/token/refresh?'+new URLSearchParams({app_key:c.appId,app_secret:c.appSecret,refresh_token:token.refreshToken,grant_type:'refresh_token'}));
   // Refresh responses may omit user_type, which was checked at initial seller authorization.
   return shopToken({...d,user_type:d.user_type??0});
  },
  async accounts(provider,c,token){
   if(provider==='shop')return list((await shop(c,token,'/authorization/202309/shops')).shops).map(s=>{
    if(!text(s.cipher))throw connectorError(502,'平台未返回店铺读取凭证');
    return {externalId:externalId(s.id),name:text(s.name)||externalId(s.id),region:text(s.region,10),currency:'',timezone:'',cipher:s.cipher};
   });
   const authorized=list((await ads(token,'/oauth2/advertiser/get/',{app_id:c.appId,secret:c.appSecret})).list);
   if(authorized.length>100)throw connectorError(422,'授权广告账户超过 100 个，请缩小本次授权范围');
   const ids=authorized.map(a=>externalId(a.advertiser_id)),result=[];
   for(let i=0;i<ids.length;i+=100){
    const details=list((await ads(token,'/advertiser/info/',{advertiser_ids:ids.slice(i,i+100),fields:['advertiser_id','name','country','currency','timezone']})).list);
    for(const a of details){const id=externalId(a.advertiser_id);if(!ids.includes(id))throw connectorError(502,'平台返回了授权范围外的账户');result.push({externalId:id,name:text(a.name)||id,region:text(a.country,10),currency:text(a.currency,10),timezone:text(a.timezone,80),cipher:''});}
   }
   if(new Set(result.map(a=>a.externalId)).size!==ids.length)throw connectorError(502,'广告账户资料不完整，请检查账户读取权限');
   return result;
  },
  async snapshot(provider,c,token,account){
   const deadline=now()+55000,at=new Date(now()).toISOString();
   if(provider==='shop'){
    const end=Math.floor(now()/1000),start=end-7*86400,rows=new Map(),seen=new Set();let cursor='';
    for(let page=0;page<20;page++){
     const d=await shop(c,token,'/order/202309/orders/search',{shop_cipher:account.cipher,page_size:100,sort_field:'create_time',sort_order:'ASC',...(cursor?{page_token:cursor}:{})},{create_time_ge:start,create_time_lt:end},deadline);
     for(const r of list(d.orders)){const id=externalId(r.id);rows.set(id,{id,status:text(r.status,60),createdAt:number(r.create_time),currency:text(r.payment?.currency,10),amount:text(r.payment?.total_amount,60)});}
     cursor=d.next_page_token||'';
     if(!cursor){if(Number(d.total_count)>rows.size)throw connectorError(502,'平台订单数量与分页不一致，本次未覆盖已有数据');break;}
     if(seen.has(cursor)||page===19)throw connectorError(422,'订单超出本次读取范围或分页异常，本次未覆盖已有数据');seen.add(cursor);
    }
    const records=[...rows.values()],byStatus={};for(const r of records)byStatus[r.status||'未知']=(byStatus[r.status||'未知']||0)+1;
    return {startAt:new Date(start*1000).toISOString(),endAt:at,fetchedAt:at,records,summary:{kind:'orders',count:records.length,byStatus,rangeLabel:'近 7 天创建的订单 · 截至同步时刻',note:'包含未支付和取消订单；订单数不等于销量或收入。未读取退款明细、商品库存与达人履约。'}};
   }
   // Business dates follow the advertiser's official timezone; do not guess from its market.
   let day;try{day=new Intl.DateTimeFormat('en-CA',{timeZone:account.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now()));if(!account.timezone)throw Error();}catch{throw connectorError(422,'广告账户未返回可识别时区，请核对官方账户资料后重新连接');}
   const end=new Date(Date.parse(day+'T00:00:00Z')-86400000).toISOString().slice(0,10),start=new Date(Date.parse(end+'T00:00:00Z')-6*86400000).toISOString().slice(0,10);
   if(!/^[A-Z]{3}$/.test(account.currency))throw connectorError(422,'广告账户缺少币种，暂不能统计消耗');
   const records=[],dates=new Set();
   for(let page=1;page<=20;page++){
    const d=await ads(token,'/report/integrated/get/',{advertiser_id:account.external_id,service_type:'AUCTION',report_type:'BASIC',data_level:'AUCTION_ADVERTISER',dimensions:['advertiser_id','stat_time_day'],metrics:['spend','impressions','clicks'],start_date:start,end_date:end,page,page_size:100},deadline);
    for(const r of list(d.list)){
     if(externalId(r.dimensions?.advertiser_id)!==account.external_id)throw connectorError(502,'广告报表账户不匹配，本次未保存');
     const date=text(r.dimensions.stat_time_day,10);if(date<start||date>end||dates.has(date))throw connectorError(502,'广告报表日期重复或超出范围，本次未保存');dates.add(date);
     records.push({date,spend:number(r.metrics?.spend),impressions:number(r.metrics?.impressions),clicks:number(r.metrics?.clicks)});
    }
    const total=Number(d.page_info?.total_page);if(!Number.isInteger(total)||total<0)throw connectorError(502,'广告报表分页信息不完整');if(page>=total)break;if(page===20)throw connectorError(422,'广告报表超过读取范围，本次未保存');
   }
   const missingDays=7-dates.size,missingSpend=records.filter(r=>r.spend===null).length;
   return {startAt:start,endAt:end,fetchedAt:at,records,summary:{kind:'ads',count:records.length,currency:account.currency,timezone:account.timezone,spend:records.length&&!missingSpend?records.reduce((s,r)=>s+r.spend,0):null,missingDays,missingSpend,rangeLabel:'近 7 个完整日 · 广告账户时区',note:'基础广告报表（非 GMV Max 专项报表）。无返回日期保持未覆盖，未按零消耗补齐；尚未与手工广告费用合并。'}};
  }
 };
}
