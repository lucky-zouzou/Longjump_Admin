import {distFail,distributorSession,ownerEligible} from './distributor-accounts.mjs';
import {atomicBatch,assertWritable,guardStatement} from './atomic.mjs';
import {materialStorage} from './material-storage.mjs';
const all=async(db,sql,args=[])=>(await db.prepare(sql).bind(...args).all()).results;
const at=()=>new Date().toISOString();
const admin=a=>{if(a?.role!=='管理员')distFail(403,'仅管理员可管理产品素材和授权');};
const audit=(db,a,action,id,detail)=>db.prepare("INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES(?,?,'分销产品素材',?,?,?,?,?)").bind(crypto.randomUUID(),action,id,JSON.stringify(detail),a.id,a.name,at());
const types={'image/jpeg':['image','jpg'],'image/png':['image','png'],'image/webp':['image','webp'],'video/mp4':['video','mp4'],'video/webm':['video','webm']};
const validFile=(mime,size,cover=false)=>types[mime]&&(!cover||types[mime][0]==='image')&&Number.isSafeInteger(size)&&size>0&&size<=(cover?512*1024:types[mime][0]==='image'?20*1024*1024:200*1024*1024);
const text=(v,max)=>typeof v==='string'?v.trim().slice(0,max):'';
export async function readMaterialAdmin(db,a,env){
 admin(a);let enabled=true;try{materialStorage(env);}catch{enabled=false;}
 return {enabled,materials:await all(db,'SELECT * FROM distributor_materials ORDER BY created_at DESC LIMIT 200'),
  skus:await all(db,'SELECT sku,name FROM sku_settings ORDER BY sku'),
  stores:await all(db,'SELECT s.customer_id,s.username,s.slug,s.status,s.version,s.access_mode,c.name FROM distributor_stores s JOIN wholesale_customers c ON c.id=s.customer_id ORDER BY c.name'),
  grants:await all(db,'SELECT * FROM distributor_material_grants'),
  issues:await all(db,`SELECT i.*,c.name store_name,m.sku,m.title_id FROM distributor_material_issues i JOIN wholesale_customers c ON c.id=i.customer_id JOIN distributor_materials m ON m.id=i.material_id ORDER BY issued_at DESC LIMIT 100`)};
}
export async function mutateMaterialAdmin(db,a,p,env,storageFactory=materialStorage){
 admin(a);await assertWritable(db);
 if(p.action==='mode'){
  if(!['full','materials'].includes(p.mode))distFail(400,'请选择账号权限');
  await atomicBatch(db,[guardStatement(db,a,'materials.mode','EXISTS(SELECT 1 FROM distributor_stores WHERE customer_id=? AND version=?)',[p.customerId,p.version]),
   db.prepare('UPDATE distributor_stores SET access_mode=?,version=version+1,updated_at=? WHERE customer_id=?').bind(p.mode,at(),p.customerId),
   db.prepare('DELETE FROM distributor_sessions WHERE customer_id=?').bind(p.customerId),audit(db,a,'materials.mode',p.customerId,{mode:p.mode})]);return {ok:true};
 }
 if(p.action==='grant'){
  if(typeof p.active!=='boolean'||!await db.prepare('SELECT 1 FROM sku_settings WHERE sku=?').bind(p.sku).first()||!await db.prepare('SELECT 1 FROM distributor_stores WHERE customer_id=?').bind(p.customerId).first())distFail(400,'请选择有效店铺和 SKU');
  await atomicBatch(db,[guardStatement(db,a,'materials.grant','1=1'),db.prepare(`INSERT INTO distributor_material_grants VALUES(?,?,?,?,?) ON CONFLICT(customer_id,sku) DO UPDATE SET active=excluded.active,updated_by=excluded.updated_by,updated_at=excluded.updated_at`).bind(p.customerId,p.sku,p.active?1:0,a.id,at()),audit(db,a,'materials.grant',p.customerId,{sku:p.sku,active:p.active})]);return {ok:true};
 }
 if(p.action==='withdraw'){
  await atomicBatch(db,[guardStatement(db,a,'materials.withdraw','EXISTS(SELECT 1 FROM distributor_materials WHERE id=? AND version=?)',[p.id,p.version]),db.prepare("UPDATE distributor_materials SET status='withdrawn',version=version+1,updated_at=? WHERE id=?").bind(at(),p.id),audit(db,a,'materials.withdraw',p.id,{})]);return {ok:true};
 }
 const storage=storageFactory(env);
 if(p.action==='begin'){
  const title=text(p.title,160);
  if(!title||/[\u3400-\u9fff]/u.test(title)||!validFile(p.mime,p.bytes)||!validFile(p.coverMime,p.coverBytes,true)||!await db.prepare('SELECT 1 FROM sku_settings WHERE sku=?').bind(p.sku).first())distFail(400,'请选择已有色款 SKU、印尼语标题、图片或视频及不超过512KB的封面');
  const id=crypto.randomUUID(),key='distributor-materials/objects/'+id,stamp=at(),expires=new Date(Date.now()+300000).toISOString();
  await atomicBatch(db,[guardStatement(db,a,'materials.begin','1=1'),db.prepare(`INSERT INTO distributor_materials(id,sku,title_id,kind,mime,bytes,object_key,cover_key,cover_mime,cover_bytes,upload_expires,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,p.sku,title,types[p.mime][0],p.mime,p.bytes,key+'/file',key+'/cover',p.coverMime,p.coverBytes,expires,a.id,stamp,stamp),audit(db,a,'materials.begin',id,{sku:p.sku})]);
  return {id,version:1,expiresAt:expires,uploadUrl:await storage.sign(key.replace('/objects/','/staging/')+'/file',{method:'PUT',ttl:300,headers:{'content-type':p.mime}}),coverUrl:await storage.sign(key.replace('/objects/','/staging/')+'/cover',{method:'PUT',ttl:300,headers:{'content-type':p.coverMime}})};
 }
 const row=await db.prepare('SELECT * FROM distributor_materials WHERE id=?').bind(p.id||'').first();if(!row||row.version!==p.version)distFail(409,'素材已变化，请刷新');
 if(p.action==='finalize'){
  if(row.status!=='uploading'||row.upload_expires<at())distFail(409,'上传已失效，请重新上传');
  const prefix='distributor-materials/objects/'+crypto.randomUUID();
  await storage.seal(row.object_key,row.mime,row.bytes,prefix+'/file');await storage.seal(row.cover_key,row.cover_mime,row.cover_bytes,prefix+'/cover');
  await atomicBatch(db,[guardStatement(db,a,'materials.finalize',"EXISTS(SELECT 1 FROM distributor_materials WHERE id=? AND version=? AND status='uploading')",[row.id,row.version]),db.prepare("UPDATE distributor_materials SET status='draft',object_key=?,cover_key=?,version=version+1,updated_at=? WHERE id=?").bind(prefix+'/file',prefix+'/cover',at(),row.id),audit(db,a,'materials.finalize',row.id,{})]);return {ok:true};
 }
 if(p.action==='preview')return {url:await storage.sign(row.object_key),expiresAt:new Date(Date.now()+120000).toISOString()};
 if(p.action==='publish'){
  const rights=text(p.rightsNote,2000),channels=text(p.channels,300),until=text(p.rightsUntil,24);
  if(!['draft','withdrawn'].includes(row.status)||p.confirmed!==true||rights.length<4||!channels||/[\u3400-\u9fff]/u.test(channels)||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(until)||!Number.isFinite(Date.parse(until))||until<=at())distFail(400,'请核对成品内容、渠道再发布授权、授权凭据及有效期后发布');
  await atomicBatch(db,[guardStatement(db,a,'materials.publish','EXISTS(SELECT 1 FROM distributor_materials WHERE id=? AND version=?)',[row.id,row.version]),db.prepare("UPDATE distributor_materials SET status='published',rights_note=?,channels=?,rights_until=?,version=version+1,updated_at=? WHERE id=?").bind(rights,channels,until,at(),row.id),audit(db,a,'materials.publish',row.id,{rights,channels,until})]);return {ok:true};
 }
 distFail(400,'操作无效');
}
const allowed=`m.status='published' AND m.rights_until>? AND EXISTS(SELECT 1 FROM distributor_material_grants g WHERE g.customer_id=? AND g.sku=m.sku AND g.active=1)`;
export async function readMerchantMaterials(db,request,env){
 const identity=await distributorSession(db,request);let enabled=true;try{materialStorage(env);}catch{enabled=false;}
 const q=new URL(request.url).searchParams,search=text(q.get('search'),80),page=Math.max(0,Math.min(100000,Number(q.get('page'))||0))|0;
 return {enabled,store:identity.customer.slug,accessMode:identity.customer.access_mode,items:enabled?await all(db,`SELECT m.id,m.sku,m.title_id,m.kind,m.bytes,m.channels,m.rights_until,m.version FROM distributor_materials m WHERE ${allowed} AND (m.sku LIKE ? OR m.title_id LIKE ?) ORDER BY m.created_at DESC,m.id LIMIT 25 OFFSET ?`,[at(),identity.customer.id,'%'+search+'%','%'+search+'%',page*24]):[],page};
}
export async function issueMerchantMaterial(db,request,p,env,storageFactory=materialStorage){
 const identity=await distributorSession(db,request);if(!['preview','play','download'].includes(p.purpose))distFail(400,'Pilihan tidak valid.');
 const row=await db.prepare(`SELECT m.* FROM distributor_materials m WHERE m.id=? AND ${allowed}`).bind(p.id||'',at(),identity.customer.id).first();if(!row)distFail(404,'Materi tidak tersedia untuk toko ini.');
 if(p.purpose==='play'&&row.kind!=='video')distFail(400,'Materi ini bukan video.');
 const recent=await db.prepare('SELECT COUNT(*) n FROM distributor_material_issues WHERE customer_id=? AND issued_at>?').bind(identity.customer.id,new Date(Date.now()-300000).toISOString()).first();if(recent.n>=240)distFail(429,'Terlalu banyak tautan. Tunggu beberapa menit lalu coba lagi.');
 const issued=at(),ttl=Math.min(120,Math.floor((Date.parse(row.rights_until)-Date.now())/1000));if(ttl<1)distFail(404,'Izin materi telah berakhir.');
 const expires=new Date(Date.now()+ttl*1000).toISOString(),storage=storageFactory(env),isPreview=p.purpose==='preview';
 const filename='LOONGJUMP-'+row.sku.replace(/[^a-zA-Z0-9_-]/g,'_')+'-'+row.id+'.'+types[row.mime][1];
 const url=await storage.sign(isPreview?row.cover_key:row.object_key,{ttl,query:p.purpose!=='download'?{}:{'response-content-disposition':`attachment; filename="${filename}"`}});
 // Revalidate current account, store version, grant and publication at link-issuance time.
 await atomicBatch(db,[guardStatement(db,{id:'distributor:'+identity.customer.id},'materials.issue',`EXISTS(SELECT 1 FROM distributor_sessions s JOIN distributor_stores a ON a.customer_id=s.customer_id JOIN wholesale_customers c ON c.id=a.customer_id JOIN users u ON u.id=c.sales_user_id WHERE s.token_hash=? AND s.expires_at>? AND s.store_version=a.version AND a.status='active' AND c.active=1 AND ${ownerEligible}) AND (SELECT COUNT(*) FROM distributor_material_issues WHERE customer_id=? AND issued_at>?)<240 AND EXISTS(SELECT 1 FROM distributor_materials m WHERE m.id=? AND m.version=? AND ${allowed})`,[identity.sessionHash,at(),identity.customer.id,new Date(Date.now()-300000).toISOString(),row.id,row.version,at(),identity.customer.id]),db.prepare('INSERT INTO distributor_material_issues(id,customer_id,material_id,purpose,issued_at,expires_at) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),identity.customer.id,row.id,p.purpose,issued,expires)]);
 return {url,expiresAt:expires,outcome:'link_issued'};
}
