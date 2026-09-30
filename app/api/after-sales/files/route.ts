import {env} from 'cloudflare:workers';
import {database,ensureSchema} from '../../../../lib/database';
import {requireActor} from '../../../../lib/auth';
import {AfterSalesError,afterRecord} from '../../../../lib/after-sales.mjs';
import {uploadAfterEvidence} from '../../../../lib/after-sales-files.mjs';
import {afterError} from '../route';
interface Bucket{put(key:string,value:ArrayBuffer,options:any):Promise<unknown>;get(key:string):Promise<{body:ReadableStream}|null>;delete(key:string):Promise<void>}
function bucket(){if(!env.WHOLESALE_FILES)throw new AfterSalesError('附件存储暂不可用',503);return env.WHOLESALE_FILES as Bucket;}
export async function POST(request:Request){try{
 if(request.headers.get('origin')&&request.headers.get('origin')!==new URL(request.url).origin)throw new AfterSalesError('请求来源无效',403);
 if(Number(request.headers.get('content-length')||0)>11*1024*1024)throw new AfterSalesError('图片不可超过10MB',413);
 await ensureSchema();const actor=await requireActor(request),form=await request.formData();return Response.json(await uploadAfterEvidence(database(),bucket(),actor,form.get('recordId'),form.get('file')));
}catch(e){return afterError(e);}}
export async function GET(request:Request){try{
 await ensureSchema();const actor=await requireActor(request),db=database();
 const f=await db.prepare('SELECT * FROM after_sales_files WHERE id=?').bind(new URL(request.url).searchParams.get('id')||'').first<{record_id:string;object_key:string;name:string;content_type:string}>();
 if(!f)throw new AfterSalesError('附件不存在',404);await afterRecord(db,actor,f.record_id);const object=await bucket().get(f.object_key);if(!object)throw new AfterSalesError('附件暂时无法读取',404);
 return new Response(object.body,{headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'Content-Type':f.content_type,'Content-Disposition':`inline; filename*=UTF-8''${encodeURIComponent(f.name)}`}});
}catch(e){return afterError(e);}}
