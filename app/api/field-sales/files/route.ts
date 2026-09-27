import {env} from 'cloudflare:workers';
import {database,ensureSchema} from '../../../../lib/database';
import {requireActor} from '../../../../lib/auth';
import {FieldError,fieldRecord} from '../../../../lib/field-sales.mjs';
import {assertWritable,atomicBatch,guardStatement} from '../../../../lib/atomic.mjs';
import {fieldError} from '../route';
interface Bucket{put(key:string,value:ArrayBuffer,options:{httpMetadata:{contentType:string}}):Promise<unknown>;get(key:string):Promise<{body:ReadableStream}|null>;delete(key:string):Promise<void>}
const bucket=()=>{if(!env.WHOLESALE_FILES)throw new FieldError('附件存储暂不可用',503);return env.WHOLESALE_FILES as Bucket;};
export async function POST(request:Request){try{
 if(request.headers.get('origin')&&request.headers.get('origin')!==new URL(request.url).origin)throw new FieldError('请求来源无效',403);
 if(Number(request.headers.get('content-length')||0)>11*1024*1024)throw new FieldError('附件不可超过10MB',413);
 await ensureSchema();const actor=await requireActor(request),db=database();await assertWritable(db);
 if(actor.role==='财务')throw new FieldError('财务仅可查看和导出',403);
 const form=await request.formData(),r=await fieldRecord(db,actor,form.get('recordId')),file=form.get('file');if(r.status!=='draft'||r.kind==='leave')throw new FieldError('仅拜访或合同草稿可上传附件',409);
 if(!(file instanceof File)||file.size<=0||file.size>10*1024*1024)throw new FieldError('请选择不超过10MB的附件');
 const b=new Uint8Array(await file.arrayBuffer()),ascii=(a:number,z:number)=>String.fromCharCode(...b.slice(a,z));
 const type=b[0]===255&&b[1]===216&&b[2]===255?'image/jpeg':b[0]===137&&ascii(1,8)==='PNG\r\n\x1a\n'?'image/png':ascii(0,4)==='RIFF'&&ascii(8,12)==='WEBP'?'image/webp':ascii(0,5)==='%PDF-'?'application/pdf':'';
 if(!type||(r.kind==='visit'&&type==='application/pdf'))throw new FieldError('拜访支持JPG、PNG、WebP；合同另支持PDF');
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),v=>v.toString(16).padStart(2,'0')).join(''),existing=await db.prepare('SELECT id FROM field_files WHERE record_id=? AND sha256=?').bind(r.id,hash).first();if(existing)return Response.json({ok:true,id:existing.id,replayed:true});
 const id='ff_'+crypto.randomUUID(),key=`field/${r.id}/${id}`,now=new Date().toISOString();await bucket().put(key,b.buffer,{httpMetadata:{contentType:type}});
 try{await atomicBatch(db,[guardStatement(db,actor,'field.upload',"EXISTS(SELECT 1 FROM field_records WHERE id=? AND version=? AND status='draft') AND (SELECT COUNT(*) FROM field_files WHERE record_id=?)<6",[r.id,r.version,r.id]),db.prepare('INSERT INTO field_files(id,record_id,object_key,name,content_type,size,sha256,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(id,r.id,key,file.name.replace(/[\r\n]/g,'').slice(0,180),type,file.size,hash,actor.id,now),db.prepare('UPDATE field_records SET version=version+1,updated_at=? WHERE id=?').bind(now,r.id),db.prepare('INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),'field.upload','field_record',r.id,JSON.stringify({fileId:id,sha256:hash}),actor.id,actor.name,now)]);}catch(e){await bucket().delete(key);throw e;}
 return Response.json({ok:true,id});
}catch(e){return fieldError(e);}}
export async function GET(request:Request){try{
 await ensureSchema();const actor=await requireActor(request),db=database(),params=new URL(request.url).searchParams;
 const f=await db.prepare('SELECT * FROM field_files WHERE id=?').bind(params.get('id')||'').first<{id:string;record_id:string;object_key:string;name:string;content_type:string;created_at:string}>();if(!f)throw new FieldError('附件不存在',404);await fieldRecord(db,actor,f.record_id);
 const object=await bucket().get(f.object_key);if(!object)throw new FieldError('附件暂时无法读取',404);
 const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox"};
 if(f.content_type.startsWith('image/')&&params.get('original')!=='1'){
  const bytes=new Uint8Array(await new Response(object.body).arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  const stamp=new Date(new Date(f.created_at).getTime()+7*3600000).toISOString().replace('T',' ').slice(0,19)+' WIB';
  // Fixed SVG with embedded raster only: immutable server upload time, never claimed to be EXIF capture time.
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="960" viewBox="0 0 1200 960"><rect width="1200" height="960" fill="#102238"/><image href="data:${f.content_type};base64,${btoa(binary)}" x="0" y="0" width="1200" height="880" preserveAspectRatio="xMidYMid meet"/><text x="24" y="918" font-size="26" font-family="sans-serif" fill="white">Uploaded / Waktu unggah: ${stamp}</text><text x="24" y="949" font-size="19" font-family="sans-serif" fill="#b7cee9">LOONG JUMP · ${f.id.replace(/[^a-zA-Z0-9_-]/g,'')}</text></svg>`;
  return new Response(svg,{headers:{...headers,'Content-Type':'image/svg+xml','Content-Disposition':`inline; filename="${f.id}.svg"`}});
 }
 return new Response(object.body,{headers:{...headers,'Content-Type':f.content_type,'Content-Disposition':`${f.content_type==='application/pdf'?'attachment':'inline'}; filename*=UTF-8''${encodeURIComponent(f.name)}`}});
}catch(e){return fieldError(e);}}
