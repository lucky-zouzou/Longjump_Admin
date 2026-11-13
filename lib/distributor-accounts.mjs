import {atomicBatch,assertWritable,guardStatement} from './atomic.mjs';

export class DistributorError extends Error {constructor(status,message){super(message);this.status=status;}}
export const distFail=(status,message)=>{throw new DistributorError(status,message);};
const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
export const distToken=()=>hex(crypto.getRandomValues(new Uint8Array(32)));
export const distHashBytes=async bytes=>hex(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)));
export const distHash=async text=>distHashBytes(new TextEncoder().encode(text));
const now=()=>new Date().toISOString();
export const ownerEligible="u.active=1 AND (u.role IN ('管理员','销售') OR (u.role='运营' AND u.site='印尼'))";
export const canDistribution=a=>['管理员','财务','销售'].includes(a?.role)||a?.role==='运营'&&a.site==='印尼';
export const canEnroll=a=>canDistribution(a)&&a.role!=='财务';
export function storeInsert(db,customerId,actor,{approved=false}={}){
 const slug='toko-'+distToken().slice(0,16),username='lj-'+distToken().slice(0,12),at=now();
 return db.prepare(`INSERT INTO distributor_stores(customer_id,slug,username,status,created_by,reviewed_by,created_at,updated_at)
 VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(customer_id) DO NOTHING`).bind(customerId,slug,username,approved?'active':'pending',actor.id,approved?actor.id:null,at,at);
}
export function distributorCredential(identity){
 const {customer,tokenHash,sessionHash}=identity;
 if(sessionHash)return {sql:`EXISTS(SELECT 1 FROM distributor_sessions s JOIN distributor_stores a ON a.customer_id=s.customer_id
 JOIN wholesale_customers c ON c.id=a.customer_id JOIN users u ON u.id=c.sales_user_id
 JOIN distributor_links l ON l.customer_id=c.id WHERE s.token_hash=? AND s.expires_at>? AND s.store_version=a.version
 AND a.status='active' AND c.active=1 AND c.id=? AND c.sales_user_id=? AND l.token_hash=? AND ${ownerEligible})`,args:[sessionHash,now(),customer.id,customer.sales_user_id,tokenHash]};
 return {sql:`EXISTS(SELECT 1 FROM distributor_links l JOIN wholesale_customers c ON c.id=l.customer_id JOIN users u ON u.id=c.sales_user_id
 WHERE l.customer_id=? AND l.token_hash=? AND c.active=1 AND c.sales_user_id=? AND ${ownerEligible})
 AND NOT EXISTS(SELECT 1 FROM distributor_stores WHERE customer_id=? AND (status<>'active' OR password_hash IS NOT NULL))`,args:[customer.id,tokenHash,customer.sales_user_id,customer.id]};
}
export const sessionCookie=(request,token='',ttl=28800)=>`lj_distributor=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token?ttl:0}${new URL(request.url).protocol==='https:'?'; Secure':''}`;
export const cookieToken=request=>request.headers.get('cookie')?.match(/(?:^|;\s*)lj_distributor=([0-9a-f]{64})(?:;|$)/)?.[1];
export async function distributorSession(db,request){
 const token=cookieToken(request);if(!token)distFail(401,'Silakan masuk ke akun toko Anda.');
 const hash=await distHash(token),at=now();
 const customer=await db.prepare(`SELECT c.*,a.slug,a.username,l.token_hash FROM distributor_sessions s
 JOIN distributor_stores a ON a.customer_id=s.customer_id JOIN wholesale_customers c ON c.id=a.customer_id
 JOIN users u ON u.id=c.sales_user_id JOIN distributor_links l ON l.customer_id=c.id
 WHERE s.token_hash=? AND s.expires_at>? AND s.store_version=a.version AND a.status='active' AND c.active=1 AND ${ownerEligible}`).bind(hash,at).first();
 if(!customer?.token_hash)distFail(401,'Sesi berakhir atau akun tidak aktif. Silakan masuk kembali.');
 const store=new URL(request.url).searchParams.get('store');if(store&&store!==customer.slug)distFail(403,'Tautan toko ini bukan milik akun Anda.');
 return {customer,tokenHash:customer.token_hash,sessionHash:hash};
}
// Production Node supports this OWASP PBKDF2 SHA256 work factor. Fail closed on runtimes with lower iteration limits.
async function passwordHash(password,salt){
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);
 try{return hex(new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',salt:new TextEncoder().encode(salt),iterations:600000,hash:'SHA-256'},key,256)));}
 catch{distFail(503,'Layanan masuk belum tersedia. Hubungi tim LOONG JUMP.');}
}
const equal=(a,b)=>{let d=a.length^b.length;for(let i=0;i<Math.max(a.length,b.length);i++)d|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return d===0;};
async function rateLimit(db,username){
 const key=await distHash('distributor-login:'+username),time=Date.now();
 await db.prepare('DELETE FROM distributor_login_attempts WHERE window_start<?').bind(time-86400000).run();
 await db.prepare("INSERT INTO distributor_login_attempts VALUES('global',1,?) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN window_start<? THEN 1 ELSE attempts+1 END,window_start=CASE WHEN window_start<? THEN excluded.window_start ELSE window_start END").bind(time,time-900000,time-900000).run();
 if((await db.prepare("SELECT attempts FROM distributor_login_attempts WHERE key='global'").first()).attempts>300)distFail(429,'Layanan masuk sedang sibuk. Coba lagi nanti.');
 await db.prepare(`INSERT INTO distributor_login_attempts VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET
 attempts=CASE WHEN window_start<? THEN 1 ELSE attempts+1 END,window_start=CASE WHEN window_start<? THEN excluded.window_start ELSE window_start END`).bind(key,time,time-900000,time-900000).run();
 if((await db.prepare('SELECT attempts FROM distributor_login_attempts WHERE key=?').bind(key).first()).attempts>10)distFail(429,'Terlalu banyak percobaan. Coba lagi dalam 15 menit.');
}
export async function authenticateDistributor(db,input){
 const username=String(input.username||'').trim().toLowerCase(),password=input.password;
 if(!/^[a-z0-9-]{3,60}$/.test(username)||typeof password!=='string'||password.length<12||password.length>128)distFail(400,'Periksa akun dan kata sandi (12–128 karakter).');
 await assertWritable(db);await rateLimit(db,username);
 const account=await db.prepare(`SELECT a.*,c.active FROM distributor_stores a JOIN wholesale_customers c ON c.id=a.customer_id
 JOIN users u ON u.id=c.sales_user_id WHERE a.username=? AND ${ownerEligible}`).bind(username).first();
 const activation=String(input.activation||'');
 let salt=account?.password_salt||'0'.repeat(64),hash;
 if(activation){
  if(!/^[0-9a-f]{64}$/.test(activation)||!account||account.status!=='active'||!account.active||account.activation_hash!==await distHash(activation)||account.activation_expires_at<now())distFail(401,'Tautan aktivasi tidak berlaku. Hubungi tim LOONG JUMP.');
  salt=distToken();hash=await passwordHash(password,salt);
  await atomicBatch(db,[guardStatement(db,{id:'distributor:'+account.customer_id},'distributor.activate',"EXISTS(SELECT 1 FROM distributor_stores a JOIN wholesale_customers c ON c.id=a.customer_id WHERE a.customer_id=? AND a.version=? AND a.status='active' AND c.active=1 AND a.activation_hash=? AND a.activation_expires_at>?)",[account.customer_id,account.version,account.activation_hash,now()]),
   db.prepare('UPDATE distributor_stores SET password_hash=?,password_salt=?,activation_hash=NULL,activation_expires_at=NULL,version=version+1,updated_at=? WHERE customer_id=?').bind(hash,salt,now(),account.customer_id),
   db.prepare('DELETE FROM distributor_sessions WHERE customer_id=?').bind(account.customer_id)]);
  account.version++;
 }else{
  hash=await passwordHash(password,salt);
  if(!equal(hash,account?.password_hash||'0'.repeat(64))||!account?.active||account.status!=='active')distFail(401,'Akun atau kata sandi tidak benar, atau akun belum disetujui.');
 }
 const token=distToken(),tokenHash=await distHash(token),expires=new Date(Date.now()+28800000).toISOString();
 await atomicBatch(db,[guardStatement(db,{id:'distributor:'+account.customer_id},'distributor.login',"EXISTS(SELECT 1 FROM distributor_stores WHERE customer_id=? AND version=? AND status='active' AND password_hash=?)",[account.customer_id,account.version,hash]),
 db.prepare('INSERT INTO distributor_sessions VALUES(?,?,?,?)').bind(tokenHash,account.customer_id,account.version,expires),
 db.prepare('DELETE FROM distributor_sessions WHERE expires_at<?').bind(now())]);
 return {token,store:account.slug,username};
}
export async function manageStore(db,a,p){
 if(!canEnroll(a))distFail(403,'无权管理分销商家');
 await assertWritable(db);
 const c=await db.prepare('SELECT * FROM wholesale_customers WHERE id=?').bind(String(p.customerId||'')).first();
 if(!c||a.role!=='管理员'&&c.sales_user_id!==a.id)distFail(403,'无权管理其他负责人名下的商家');
 const s=await db.prepare('SELECT * FROM distributor_stores WHERE customer_id=?').bind(c.id).first();
 if(p.action==='enroll'){
  if(s)return {ok:true,customerId:c.id};
  await atomicBatch(db,[guardStatement(db,a,'distributor.enroll','EXISTS(SELECT 1 FROM wholesale_customers WHERE id=? AND version=? AND active=1)',[c.id,c.version]),storeInsert(db,c.id,a)]);
  return {ok:true,customerId:c.id};
 }
 if(a.role!=='管理员')distFail(403,'仅管理员可批准、停用或重置商家账号');
 if(!s||s.version!==p.version)distFail(409,'商家状态已变化，请刷新');
 if(!['approve','suspend','invite'].includes(p.action)||String(p.reason||'').trim().length<4)distFail(400,'请填写审核或重置依据（至少4字）');
 if(p.action==='invite'&&s.status!=='active')distFail(409,'请先批准商家，再发出激活邀请');
 const enabled=p.action!=='suspend',token=enabled?distToken():null,hash=token?await distHash(token):null,at=now();
 const stmts=[guardStatement(db,a,'distributor.'+p.action,`EXISTS(SELECT 1 FROM distributor_stores a JOIN wholesale_customers c ON c.id=a.customer_id JOIN users u ON u.id=c.sales_user_id WHERE a.customer_id=? AND a.version=? AND (?=0 OR (c.active=1 AND ${ownerEligible})))`,[c.id,s.version,enabled?1:0]),
 db.prepare('UPDATE distributor_stores SET password_hash=NULL,password_salt=NULL,status=?,activation_hash=?,activation_expires_at=?,version=version+1,reviewed_by=?,review_note=?,updated_at=? WHERE customer_id=?').bind(enabled?'active':'suspended',hash,token?new Date(Date.now()+172800000).toISOString():null,a.id,String(p.reason).slice(0,1000),at,c.id),
 db.prepare('DELETE FROM distributor_sessions WHERE customer_id=?').bind(c.id),
 db.prepare("INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES(?,?,'分销商家',?,?,?,?,?)").bind(crypto.randomUUID(),'distributor.'+p.action,c.id,JSON.stringify({reason:p.reason,version:s.version+1}),a.id,a.name,at)];
 if(enabled)stmts.push(db.prepare(`INSERT INTO distributor_links(customer_id,token_hash,version,updated_by,updated_at) VALUES(?,?,1,?,?)
 ON CONFLICT(customer_id) DO UPDATE SET token_hash=excluded.token_hash,version=distributor_links.version+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at`).bind(c.id,await distHash(distToken()),a.id,at));
 await atomicBatch(db,stmts);
 return {ok:true,username:s.username,store:s.slug,activationPath:token?`/distributor?store=${s.slug}#activate=${token}&username=${s.username}`:null};
}
