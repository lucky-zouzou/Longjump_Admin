import {env} from 'cloudflare:workers';
import {database,ensureSchema} from '../../../../lib/database';
import {requireActor} from '../../../../lib/auth';
import {promotionRecord} from '../../../../lib/promotions.mjs';
import {uploadPromotionFile} from '../../../../lib/promotion-files.mjs';
import {PromotionError} from '../../../../lib/promotion-model.mjs';
import {promotionError} from '../route';
interface Bucket{put(key:string,value:ArrayBuffer,options:any):Promise<unknown>;get(key:string):Promise<{body:ReadableStream}|null>;delete(key:string):Promise<void>}
function bucket(){if(!env.WHOLESALE_FILES)throw new PromotionError('附件存储暂不可用',503);return env.WHOLESALE_FILES as Bucket;}
export async function POST(request:Request){try{if(request.headers.get('origin')&&request.headers.get('origin')!==new URL(request.url).origin)throw new PromotionError('请求来源无效',403);if(Number(request.headers.get('content-length')||0)>11*1024*1024)throw new PromotionError('图片过大',413);await ensureSchema();const a=await requireActor(request),f=await request.formData();return Response.json(await uploadPromotionFile(database(),bucket(),a,f.get('recordId'),f.get('purpose'),f.get('file')));}catch(e){return promotionError(e);}}
export async function GET(request:Request){try{await ensureSchema();const a=await requireActor(request);if(a.role==='供应链')throw new PromotionError('供应链仅查看库存及处理状态',403);const db=database(),f=await db.prepare('SELECT * FROM promotion_files WHERE id=?').bind(new URL(request.url).searchParams.get('id')||'').first<{record_id:string;object_key:string;name:string;content_type:string}>();if(!f)throw new PromotionError('附件不存在',404);await promotionRecord(db,a,f.record_id);const obj=await bucket().get(f.object_key);if(!obj)throw new PromotionError('附件暂不可用',404);return new Response(obj.body,{headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'Content-Type':f.content_type,'Content-Disposition':`inline; filename*=UTF-8''${encodeURIComponent(f.name)}`}});}catch(e){return promotionError(e);}}
