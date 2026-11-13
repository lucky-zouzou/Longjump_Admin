import {atomicBatch, assertWritable, guardStatement} from './atomic.mjs';
import {materialAccess, sites} from './content-center.mjs';

export const partBytes=8*1024*1024;
export const maxVideoBytes=256*1024*1024;
const all=async(db,sql,...args)=>(await db.prepare(sql).bind(...args).all()).results;
const get=(db,sql,...args)=>db.prepare(sql).bind(...args).first();
const stmt=(db,sql,...args)=>db.prepare(sql).bind(...args);
function fail(message,status=400){throw Object.assign(new Error(message),{status});}
function text(value,max,label){
  if(typeof value!=='string'||value.trim().length>max)fail('请核对'+label);
  return value.trim();
}
function uuid(value){
  if(typeof value!=='string'||!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value))fail('上传编号无效');
  return value;
}
function date(value){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)fail('请填写有效的拍摄起止日期');
  return value;
}
function targetSites(value){
  if(!Array.isArray(value)||!value.length||value.some(site=>!sites.includes(site)))fail('请选择分发站点');
  return [...new Set(value)].sort();
}
export const defaultMaterialOptions={colors:['黑色','白色','棕色','米色','蓝色','卡其色','军绿','粉色','灰色'],directions:['新品种草','产品展示','开箱测评','容量展示','细节展示','场景搭配'],sellingPoints:['大容量','可折叠','防水','多颜色','材质质感','轻便']};
function materialMetadata(input={}){
 const result={productName:text(input.productName||'',180,'产品名称')};
 for(const key of Object.keys(defaultMaterialOptions)){
  const values=input[key]||[];
  if(!Array.isArray(values)||values.length>20)fail('快捷选项每项最多20个');
  result[key]=[...new Set(values.map(v=>text(v,80,'快捷选项')).filter(Boolean))];
 }
 return result;
}
async function optionSnapshot(db){const row=await get(db,"SELECT * FROM content_material_options WHERE id='global'");return {version:row?.version||0,values:row?JSON.parse(row.data_json):defaultMaterialOptions};}
const placeholders=arr=>arr.map(()=>'?').join(',');
const unlocked="NOT EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>?)";
function guard(db,actor,action,condition,args){
  return guardStatement(db,actor,action,unlocked+' AND ('+condition+')',[new Date().toISOString(),...args]);
}
function audit(db,actor,action,id,detail,at,changedOnly=false){
  const values=changedOnly?'SELECT ?,?,?,?,?,?,?,? WHERE changes()>0':'VALUES(?,?,?,?,?,?,?,?)';
  return stmt(db,'INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) '+values,crypto.randomUUID(),action,'content_material',id,JSON.stringify(detail),actor.id,actor.name,at);
}
function headerType(bytes){
  if(String.fromCharCode(...bytes.slice(4,8))==='ftyp'){
    const brand=String.fromCharCode(...bytes.slice(8,12));
    if(brand==='qt  ')return 'video/quicktime';
    if(/^(isom|iso[2-9m]|mp4[12v ]|avc1|M4V |MSNV|dash|3gp[456])$/.test(brand))return 'video/mp4';
  }
  if(bytes[0]===26&&bytes[1]===69&&bytes[2]===223&&bytes[3]===163&&new TextDecoder().decode(bytes.slice(0,512)).includes('webm'))return 'video/webm';
  fail('无法识别视频文件，请使用 MP4、MOV 或 WebM');
}
async function digest(bytes){
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
}
// Each committed part is referenced in the backup, including interrupted uploads.
// A material becomes visible to assigned sites only when the last part commits.
export async function uploadMaterialPart(db,bucket,identity,meta,index,blob){
  const {actor,manage}=await materialAccess(db,identity);
  if(!manage)fail('仅拍摄剪辑或内容管理人员可以上传',403);
  await assertWritable(db);
  const id=uuid(meta.id), batch=uuid(meta.batch), original=text(meta.original,255,'原文件名'), title=text(meta.title,180,'素材名称');
  const sku=text(meta.sku,120,'产品编码'),note=text(meta.note||'',1600,'备注'),from=date(meta.from),to=date(meta.to),targets=targetSites(meta.sites);
  if(!original||!title||!sku||from>to)fail('请填写素材名称、产品编码和正确的拍摄周期');
  const scriptId=meta.scriptId||null;
  if(scriptId){
    const parent=await get(db,"SELECT sku FROM content_scripts WHERE id=? AND source='studio'",uuid(scriptId));
    if(!parent||parent.sku!==sku)fail('关联的实拍需求须与产品编码一致');
  }
  const metadata=materialMetadata(meta.metadata),replaces=meta.replacesId?uuid(meta.replacesId):null;
  const previous=replaces?await get(db,'SELECT * FROM content_materials WHERE id=?',replaces):null;
  if(replaces&&(!previous||previous.state!=='ready'||previous.revision!==meta.replacesRevision)&&!await get(db,"SELECT id FROM content_materials WHERE id=? AND state='ready' AND replaces_id=?",id,replaces))fail('原素材已变化，请刷新后重新替换',409);
  const size=meta.size;
  if(!Number.isSafeInteger(size)||size<=0||size>maxVideoBytes)fail('单个视频须在 256 MB 以内');
  const count=Math.ceil(size/partBytes);
  if(!Number.isInteger(index)||index<0||index>=count||!(blob instanceof Blob)||blob.size!==Math.min(partBytes,size-index*partBytes))fail('视频分片不完整，请重试');
  const bytes=new Uint8Array(await blob.arrayBuffer()), hash=await digest(bytes);
  const uploadKey=JSON.stringify([batch,original,title,sku,note,from,to,size,targets,scriptId,metadata,replaces,meta.replacesRevision]);
  const verify=async()=>{
    const material=await get(db,'SELECT * FROM content_materials WHERE id=?',id);
    if(material&&(material.actor_id!==actor.id||material.upload_key!==uploadKey))fail('此编号已用于其他素材',409);
    const part=await get(db,'SELECT sha256 FROM content_material_parts WHERE material_id=? AND part_no=?',id,index);
    if(part&&part.sha256!==hash)fail('重试文件与原文件不一致',409);
    return {material,exists:!!part};
  };
  const {material,exists}=await verify();
  if(exists)return {id,ready:material.state==='ready'};
  if(!material&&index!==0)fail('请从第一段重新上传',409);
  const type=index===0?headerType(bytes):material.content_type;
  const key='content-materials/'+id+'/'+crypto.randomUUID(),at=new Date().toISOString();
  const sql=[guard(db,actor,'contentMaterialUpload','(SELECT COUNT(*) FROM content_material_parts WHERE material_id=?)=?',[id,index])];
  if(index===0){
    sql.push(stmt(db,'INSERT INTO content_materials(id,batch_id,script_id,original_name,title,sku,note,shoot_from,shoot_to,actor_id,created_at,size,content_type,upload_key,metadata_json,replaces_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',id,batch,scriptId,original,title,sku,note,from,to,actor.id,at,size,type,uploadKey,JSON.stringify(metadata),replaces));
    for(const site of targets)sql.push(stmt(db,'INSERT INTO content_material_sites(material_id,site) VALUES(?,?)',id,site));
  }
  sql.push(stmt(db,'INSERT INTO content_material_parts(id,material_id,part_no,object_key,size,content_type,sha256) VALUES(?,?,?,?,?,?,?)',crypto.randomUUID(),id,index,key,bytes.length,type,hash));
  if(index===count-1){
    if(replaces){
      sql.push(guard(db,actor,'contentMaterialReplace',"EXISTS(SELECT 1 FROM content_materials WHERE id=? AND state='ready' AND revision=?)",[replaces,meta.replacesRevision]));
      sql.push(stmt(db,"UPDATE content_materials SET state='archived',revision=revision+1 WHERE id=?",replaces));
      sql.push(audit(db,actor,'替换成片',replaces,{replacement:id,previousRevision:meta.replacesRevision},at));
    }
    sql.push(stmt(db,"UPDATE content_materials SET state='ready' WHERE id=?",id),audit(db,actor,'上传并分发成片',id,{batch,sites:targets,sku},at));
  }
  await bucket.put(key,bytes,{httpMetadata:{contentType:type}});
  try{await atomicBatch(db,sql);}catch(error){
    await bucket.delete(key);
    const again=await verify();
    if(!again.exists)throw error;
    return {id,ready:again.material.state==='ready'};
  }
  return {id,ready:index===count-1};
}

function visibleSites(scope){return scope.manage?sites:scope.writeSites;}
export async function listMaterials(db,identity,filters){
  const scope=await materialAccess(db,identity),allowed=visibleSites(scope);
  const pageSize=24,page=Math.max(1,Math.min(100000,parseInt(filters.page,10)||1));
  if(!allowed.length)return {items:[],total:0,page:1};
  const conditions=['m.state=?'],args=[scope.manage&&filters.archived==='1'?'archived':'ready'];
  let selection=allowed;
  if(filters.site){if(!allowed.includes(filters.site))return {items:[],total:0,page:1};selection=[filters.site];}
  let match='s.material_id=m.id AND s.site IN ('+placeholders(selection)+')';
  args.push(...selection);
  if(filters.status){if(!['pending','downloaded','failed'].includes(filters.status))fail('下载状态无效');match+=' AND s.status=?';args.push(filters.status);}
  conditions.push('EXISTS(SELECT 1 FROM content_material_sites s WHERE '+match+')');
  if(filters.q){const q=text(filters.q,180,'关键词');conditions.push('instr(lower(m.sku||\' \'||m.title||\' \'||m.original_name||\' \'||m.batch_id),lower(?))>0');args.push(q);}
  if(filters.by){conditions.push('m.actor_id=?');args.push(filters.by);}
  // The shared operations center uses Beijing time for audit dates.
  if(filters.from){conditions.push('m.created_at>=?');args.push(new Date(date(filters.from)+'T00:00:00+08:00').toISOString());}
  if(filters.to){conditions.push('m.created_at<?');args.push(new Date(Date.parse(date(filters.to)+'T00:00:00+08:00')+86400000).toISOString());}
  const where=conditions.join(' AND ');
  const {n}=await get(db,'SELECT COUNT(*) n FROM content_materials m WHERE '+where,...args);
  const actualPage=Math.min(page,Math.max(1,Math.ceil(n/pageSize)));
  const rows=await all(db,'SELECT m.id,m.script_id,m.batch_id,m.original_name,m.title,m.sku,m.note,m.shoot_from,m.shoot_to,m.created_at,m.size,m.state,m.revision,m.metadata_json,m.replaces_id,u.name uploader FROM content_materials m JOIN users u ON u.id=m.actor_id WHERE '+where+' ORDER BY m.created_at DESC,m.id LIMIT ? OFFSET ?',...args,pageSize,(actualPage-1)*pageSize);
  const ids=rows.map(row=>row.id);
  const assignments=ids.length?await all(db,'SELECT s.material_id,s.site,s.status,s.handled_at,u.name handled_by FROM content_material_sites s LEFT JOIN users u ON u.id=s.handled_by WHERE s.material_id IN ('+placeholders(ids)+') AND s.site IN ('+placeholders(allowed)+') ORDER BY s.site',...ids,...allowed):[];
  return {options:await optionSnapshot(db),total:n,page:actualPage,items:rows.map(({metadata_json,...row})=>({...row,metadata:JSON.parse(metadata_json),sites:assignments.filter(s=>s.material_id===row.id)}))};
}

export async function updateMaterials(db,identity,p){
  const scope=await materialAccess(db,identity),{actor}=scope;
  if(p.action==='options'){
    if(actor.role!=='管理员')fail('仅管理员可维护常用选项',403);
    const data=materialMetadata(p.options),current=await optionSnapshot(db);delete data.productName;
    if(Number(p.version)!==current.version)fail('常用选项已变化，请刷新',409);
    await atomicBatch(db,[guard(db,actor,'contentMaterialOptions',"COALESCE((SELECT version FROM content_material_options WHERE id='global'),0)=?",[current.version]),stmt(db,"INSERT INTO content_material_options(id,data_json,updated_at) VALUES('global',?,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json,version=version+1,updated_at=excluded.updated_at",JSON.stringify(data),new Date().toISOString()),audit(db,actor,'维护素材常用选项','global',data,new Date().toISOString())]);return {ok:true};
  }
  if(!Array.isArray(p.ids)||!p.ids.length||p.ids.length>24)fail('请在当前页选择素材');
  const ids=[...new Set(p.ids.map(uuid))],at=new Date().toISOString();
  const sql=[guard(db,actor,'contentMaterialUpdate'," (SELECT COUNT(*) FROM content_materials WHERE state='ready' AND id IN ("+placeholders(ids)+'))=?',[...ids,ids.length])];
  if(p.action==='edit'){
    if(!scope.manage||ids.length!==1)fail('仅内容管理人员可编辑单条素材',403);
    const row=await get(db,'SELECT * FROM content_materials WHERE id=?',ids[0]);
    if(!row||Number(p.version)!==row.revision)fail('素材已更新，请刷新',409);
    const title=text(p.title,180,'素材名称'),sku=text(p.sku,120,'产品编码'),note=text(p.note||'',1600,'备注'),metadata=materialMetadata(p.metadata);
    if(!title||!sku)fail('请填写名称及产品编码');
    if(row.script_id&&(await get(db,'SELECT sku FROM content_scripts WHERE id=?',row.script_id))?.sku!==sku)fail('产品编码须与关联实拍需求一致');
    sql.push(guard(db,actor,'contentMaterialEdit','EXISTS(SELECT 1 FROM content_materials WHERE id=? AND revision=?)',[row.id,row.revision]));
    sql.push(stmt(db,'UPDATE content_materials SET title=?,sku=?,note=?,metadata_json=?,revision=revision+1 WHERE id=?',title,sku,note,JSON.stringify(metadata),row.id));
    sql.push(audit(db,actor,'编辑成片信息',row.id,{before:{title:row.title,sku:row.sku,note:row.note,metadata:JSON.parse(row.metadata_json)},after:{title,sku,note,metadata}},at));
  }else if(p.action==='assign'||p.action==='archive'||p.action==='delete'){
    if(!scope.manage)fail('无权管理素材',403);
    const targets=p.action==='assign'?targetSites(p.sites):[];
    for(const id of ids){
      if(['archive','delete'].includes(p.action))sql.push(stmt(db,"UPDATE content_materials SET state='archived',revision=revision+1 WHERE id=?",id));
      else {sql.push(stmt(db,'UPDATE content_materials SET revision=revision+1 WHERE id=?',id));sql.push(stmt(db,'INSERT INTO content_material_sites(material_id,site) VALUES '+targets.map(()=>'(?,?)').join(',')+' ON CONFLICT(material_id,site) DO NOTHING',...targets.flatMap(s=>[id,s])));}
      sql.push(audit(db,actor,p.action==='delete'?'删除成片':p.action==='archive'?'归档成片':'分发成片',id,{sites:targets},at));
    }
  }else if(['downloaded','failed'].includes(p.action)){
    if(!scope.writeSites.includes(p.site))fail('仅本站运营或管理人员可登记下载结果',403);
    sql.push(guard(db,actor,'contentMaterialReceipt','(SELECT COUNT(*) FROM content_material_sites WHERE material_id IN ('+placeholders(ids)+') AND site=?)=?',[...ids,p.site,ids.length]));
    for(const id of ids){
      sql.push(stmt(db,"UPDATE content_material_sites SET status=?,handled_by=?,handled_at=? WHERE material_id=? AND site=? AND status<>'downloaded' AND status<>?",p.action,actor.id,at,id,p.site,p.action));
      sql.push(audit(db,actor,p.action==='failed'?'素材下载失败':'确认收到成片',id,{site:p.site},at,true));
    }
  }else fail('未知的素材操作');
  await atomicBatch(db,sql);
  return {ok:true};
}

export async function materialResponse(db,bucket,identity,id,range,download){
  const scope=await materialAccess(db,identity),allowed=visibleSites(scope);
  if(!allowed.length)fail('无权访问此素材',403);
  const file=await get(db,"SELECT m.* FROM content_materials m WHERE m.id=? AND (m.state='ready' OR (?=1 AND m.state='archived')) AND EXISTS(SELECT 1 FROM content_material_sites s WHERE s.material_id=m.id AND s.site IN ("+placeholders(allowed)+'))',uuid(id),scope.manage?1:0,...allowed);
  if(!file)fail('素材不存在或未分发到本站',404);
  const headers=new Headers({'Content-Type':file.content_type,'Accept-Ranges':'bytes','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':(download?'attachment':'inline')+"; filename*=UTF-8''"+encodeURIComponent(file.original_name)});
  let start=0,end=file.size-1;
  if(range){
    const r=/^bytes=(\d*)-(\d*)$/.exec(range);
    if(r&&(r[1]||r[2])){
      start=r[1]?Number(r[1]):Math.max(0,file.size-Number(r[2]));
      end=r[1]&&r[2]?Math.min(Number(r[2]),end):end;
    }
    if(!r||!r[1]&&!r[2]||start>end||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)){
      headers.set('Content-Range','bytes */'+file.size);
      return new Response(null,{status:416,headers});
    }
    headers.set('Content-Range','bytes '+start+'-'+end+'/'+file.size);
  }
  headers.set('Content-Length',String(end-start+1));
  const parts=await all(db,'SELECT object_key,part_no FROM content_material_parts WHERE material_id=? AND part_no BETWEEN ? AND ? ORDER BY part_no',id,Math.floor(start/partBytes),Math.floor(end/partBytes));
  if(parts.length!==Math.floor(end/partBytes)-Math.floor(start/partBytes)+1)fail('视频文件不完整，请联系上传人替换',503);
  let next=0,cancelled=false;
  const body=new ReadableStream({async pull(controller){
    if(cancelled)return;if(next>=parts.length){controller.close();return;}
    const part=parts[next++],object=await bucket.get(part.object_key);
    if(!object)throw new Error('素材分片暂时无法读取');
    const bytes=new Uint8Array(await new Response(object.body).arrayBuffer()),offset=part.part_no*partBytes;
    if(cancelled)return;controller.enqueue(bytes.subarray(Math.max(0,start-offset),Math.min(bytes.length,end-offset+1)));
  },cancel(){cancelled=true;}});
  return new Response(body,{status:range?206:200,headers});
}
