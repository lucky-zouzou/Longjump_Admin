import {randomBytes,randomUUID} from 'node:crypto';
import {createTikTokClient} from './tiktok-client.mjs';
import {connectorError,digest,providers,readConnectionConfig,readTokenKey,seal,unseal,validateConfig} from './tiktok-config.mjs';

export function createConnections({db,origin,config=readConnectionConfig,key=readTokenKey,client=createTikTokClient(),now=()=>Date.now()}){
 const refreshes=new Map();
 const stamp=()=>new Date(now()).toISOString();
 const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}};
 function admin(actor){if(!actor||!db.prepare("SELECT id FROM users WHERE id=? AND active=1 AND role='管理员'").get(actor.id))throw connectorError(403,'仅管理员可管理平台连接');}
 function session(hash,actorId){if(!db.prepare("SELECT s.token_hash FROM local_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.user_id=? AND s.expires_at>? AND u.active=1 AND u.role='管理员'").get(hash,actorId,now()))throw connectorError(401,'原登录会话已失效，请重新登录后连接');}
 const event=(actor,provider,account,type)=>db.prepare('INSERT INTO platform_connection_events VALUES(?,?,?,?,?,?)').run(randomUUID(),actor,provider,account,type,stamp());
 function settings(provider){const c=validateConfig(config(),provider);key();return c;}
 const callback=provider=>origin+'/api/connections/callback/'+provider;
 function status(actor){
  admin(actor);
  const configuration=providers.map(provider=>{let ready=false,message='应用已配置，可前往官方授权';try{settings(provider);ready=true;}catch(e){message=e.status?e.message:'配置暂时不可用';}return {provider,ready,message,callbackUrl:callback(provider)};});
  const accounts=db.prepare('SELECT a.*,s.start_at,s.end_at,s.summary_json,s.fetched_at FROM platform_accounts a LEFT JOIN platform_snapshots s ON s.account_id=a.id ORDER BY a.provider,a.name').all().map(a=>{
   let state=a.status;
   if(a.grant_id){const grant=db.prepare('SELECT config_hash FROM platform_grants WHERE id=?').get(a.grant_id);try{if(grant?.config_hash!==settings(a.provider).hash)state='reconnect';}catch{state='configuration';}}
   return {id:a.id,provider:a.provider,externalId:a.external_id,name:a.name,region:a.region,currency:a.currency,timezone:a.timezone,status:state,lastSyncAt:a.last_sync_at,error:a.last_error,busy:a.lease_until>now(),summary:a.summary_json?JSON.parse(a.summary_json):null,startAt:a.start_at,endAt:a.end_at,fetchedAt:a.fetched_at};
  });
  return {configuration,accounts,events:db.prepare('SELECT provider,account_id AS accountId,event,created_at AS createdAt FROM platform_connection_events ORDER BY created_at DESC LIMIT 20').all()};
 }
 function begin(actor,provider,sessionHash){
  admin(actor);session(sessionHash,actor.id);const c=settings(provider),state=randomBytes(32).toString('hex'),binding=randomBytes(32).toString('hex'),url=new URL(c.authorizationUrl);
  url.searchParams.set('state',state);
  if(provider==='ads')url.searchParams.set('redirect_uri',callback(provider));
  else if(url.searchParams.has('redirect_uri')&&url.searchParams.get('redirect_uri')!==callback(provider))throw connectorError(503,'店铺授权链接的回调地址与当前系统不一致');
  transaction(()=>{db.prepare('DELETE FROM platform_oauth_states WHERE expires_at<=? OR (actor_id=? AND provider=?)').run(now(),actor.id,provider);db.prepare('INSERT INTO platform_oauth_states VALUES(?,?,?,?,?,?,?)').run(digest(state),provider,digest(binding),sessionHash,actor.id,c.hash,now()+600000);event(actor.id,provider,null,'authorization_started');});
  return {url:url.href,binding};
 }
 async function complete(provider,params,binding){
  if(!providers.includes(provider)||!binding||!/^[a-f0-9]{64}$/.test(params.get('state')||''))throw connectorError(400,'授权校验失败，请从本系统重新连接');
  const state=transaction(()=>{
   const s=db.prepare('SELECT * FROM platform_oauth_states WHERE state_hash=? AND provider=?').get(digest(params.get('state')),provider);
   if(!s||s.expires_at<=now()||s.binding_hash!==digest(binding))throw connectorError(400,'授权已过期或浏览器不匹配，请重新连接');
   session(s.session_hash,s.actor_id);db.prepare('DELETE FROM platform_oauth_states WHERE state_hash=?').run(s.state_hash);return s;
  });
  if(params.has('error'))throw connectorError(400,'本次未完成官方授权，可以返回后重新连接');
  const codes=[params.get('auth_code'),params.get('code')].filter(Boolean);
  if(!codes.length||codes.some(v=>v!==codes[0])||codes[0].length>4096)throw connectorError(400,'平台未返回有效授权码，请重新连接');
  const c=settings(provider);if(c.hash!==state.config_hash)throw connectorError(409,'应用配置已变化，请重新发起授权');
  const token=await client.exchange(provider,c,codes[0]),accounts=await client.accounts(provider,c,token);
  if(!accounts.length)throw connectorError(422,'此授权没有可读取的店铺或广告账户，请在官方后台检查授权范围');
  if(accounts.length>100||new Set(accounts.map(a=>a.externalId)).size!==accounts.length)throw connectorError(422,'平台账号列表重复或超出范围，请缩小授权范围');
  session(state.session_hash,state.actor_id);
  if(settings(provider).hash!==state.config_hash)throw connectorError(409,'应用配置已变化，请重新发起授权');
  const grant=randomUUID();
  transaction(()=>{
   db.prepare('INSERT INTO platform_grants VALUES(?,?,?,?,?,?,?)').run(grant,provider,c.hash,seal(token,key(),grant),token.expiresAt,state.actor_id,stamp());
   for(const a of accounts){
    const id=digest(provider+':'+a.externalId).slice(0,32);
    db.prepare(`INSERT INTO platform_accounts(id,provider,external_id,name,region,currency,timezone,cipher,grant_id) VALUES(?,?,?,?,?,?,?,?,?)
     ON CONFLICT(provider,external_id) DO UPDATE SET name=excluded.name,region=excluded.region,currency=excluded.currency,timezone=excluded.timezone,cipher=excluded.cipher,grant_id=excluded.grant_id,status='connected',last_error='',lease_until=0,version=platform_accounts.version+1`).run(id,provider,a.externalId,a.name,a.region,a.currency,a.timezone,a.cipher,grant);
    event(state.actor_id,provider,id,'authorized');
   }
   db.prepare('DELETE FROM platform_grants WHERE id NOT IN (SELECT grant_id FROM platform_accounts WHERE grant_id IS NOT NULL)').run();
  });
  return accounts.length;
 }
 async function tokenFor(account,c){
  const load=()=>{const grant=db.prepare('SELECT * FROM platform_grants WHERE id=?').get(account.grant_id);if(!grant||grant.config_hash!==c.hash)throw connectorError(401,'应用配置已变化，请重新授权');return {grant,token:unseal(grant.token_encrypted,key(),grant.id)};};
  let {grant,token}=load();
  if(account.provider!=='shop'||token.expiresAt>now()+300000)return token;
  if(refreshes.has(grant.id)){await refreshes.get(grant.id);return load().token;}
  const promise=(async()=>{
   const updated=await client.refresh(c,token);
   const result=db.prepare('UPDATE platform_grants SET token_encrypted=?,expires_at=? WHERE id=? AND config_hash=?').run(seal(updated,key(),grant.id),updated.expiresAt,grant.id,c.hash);
   if(!result.changes)throw connectorError(409,'连接已变化，请刷新页面');
   return updated;
  })();refreshes.set(grant.id,promise);
  try{return await promise;}finally{refreshes.delete(grant.id);}
 }
 async function sync(actor,id){
  admin(actor);const a=db.prepare('SELECT * FROM platform_accounts WHERE id=?').get(id);
  if(!a?.grant_id)throw connectorError(404,'连接不存在或已断开');
  if(a.lease_until>now())throw connectorError(409,'此账户正在读取，请稍后查看结果');
  const c=settings(a.provider);
  db.prepare('UPDATE platform_accounts SET lease_until=? WHERE id=?').run(now()+90000,id);
  try{
   const data=await client.snapshot(a.provider,c,await tokenFor(a,c),a);
   admin(actor);
   if(settings(a.provider).hash!==c.hash)throw connectorError(409,'配置已变化，本次结果未保存');
   transaction(()=>{
    const current=db.prepare('SELECT version,grant_id FROM platform_accounts WHERE id=?').get(id);
    if(current.version!==a.version||current.grant_id!==a.grant_id)throw connectorError(409,'连接已变化，本次结果未保存');
    db.prepare(`INSERT INTO platform_snapshots VALUES(?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET start_at=excluded.start_at,end_at=excluded.end_at,summary_json=excluded.summary_json,records_json=excluded.records_json,fetched_at=excluded.fetched_at`).run(id,data.startAt,data.endAt,JSON.stringify(data.summary),JSON.stringify(data.records),data.fetchedAt);
    db.prepare("UPDATE platform_accounts SET status='connected',last_sync_at=?,last_error='',lease_until=0 WHERE id=?").run(stamp(),id);
    event(actor.id,a.provider,id,'sync_completed');
   });return {ok:true};
  }catch(e){
   const message=e.status?e.message:'读取未完成，请稍后重试；上次结果已保留';
   db.prepare('UPDATE platform_accounts SET status=?,last_error=?,lease_until=0 WHERE id=? AND version=?').run(e.status===401?'expired':'error',message,id,a.version);
   event(actor.id,a.provider,id,'sync_failed');throw connectorError(e.status||502,message);
  }finally{db.prepare('UPDATE platform_accounts SET lease_until=0 WHERE id=? AND version=?').run(id,a.version);}
 }
 function disconnect(actor,id){
  admin(actor);const a=db.prepare('SELECT * FROM platform_accounts WHERE id=?').get(id);if(!a)throw connectorError(404,'连接不存在');
  transaction(()=>{db.prepare("UPDATE platform_accounts SET grant_id=NULL,cipher='',status='disconnected',lease_until=0,last_error='',version=version+1 WHERE id=?").run(id);db.prepare('DELETE FROM platform_grants WHERE id NOT IN (SELECT grant_id FROM platform_accounts WHERE grant_id IS NOT NULL)').run();event(actor.id,a.provider,id,'disconnected');});return {ok:true};
 }
 function details(actor,id){admin(actor);const r=db.prepare('SELECT * FROM platform_snapshots WHERE account_id=?').get(id);if(!r)throw connectorError(404,'尚无成功读取的结果');const records=JSON.parse(r.records_json);return {summary:JSON.parse(r.summary_json),records:records.slice(0,50),total:records.length,fetchedAt:r.fetched_at,startAt:r.start_at,endAt:r.end_at};}
 return {status,begin,complete,sync,disconnect,details};
}
