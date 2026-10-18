import {env} from 'cloudflare:workers';
import {database} from '../../../../lib/database';
import {HttpError,requireActor} from '../../../../lib/auth';
import {FactoryDocumentError} from '../../../../lib/purchase-documents.mjs';
import {ConflictError} from '../../../../lib/atomic.mjs';
import {uploadFactoryFile,readFactoryFile} from '../../../../lib/factory-document-files.mjs';
interface Bucket{put(key:string,value:ArrayBuffer,options:{httpMetadata:{contentType:string}}):Promise<unknown>;get(key:string):Promise<{body:ReadableStream}|null>;delete(key:string):Promise<void>}
function bucket(){if(!env.WHOLESALE_FILES)throw new HttpError(503,'附件存储暂时不可用');return env.WHOLESALE_FILES as Bucket;}
function error(e:unknown){if(e instanceof HttpError||e instanceof FactoryDocumentError||e instanceof ConflictError)return Response.json({error:e.message},{status:e.status});console.error('Factory attachment',e);return Response.json({error:'附件读取或上传失败'},{status:500});}
export async function POST(request:Request){try{const a=await requireActor(request),origin=request.headers.get('origin');if(origin&&origin!==new URL(request.url).origin)throw new HttpError(403,'请求来源无效');if(Number(request.headers.get('content-length')||0)>21*1024*1024)throw new HttpError(413,'附件不能超过20MB');const f=await request.formData();return Response.json(await uploadFactoryFile(database(),bucket(),a,{noticeId:String(f.get('noticeId')||''),file:f.get('file')}));}catch(e){return error(e);}}
export async function GET(request:Request){try{const a=await requireActor(request),f=await readFactoryFile(database(),a,new URL(request.url).searchParams.get('id')||''),object=await bucket().get(f.object_key);if(!object)throw new HttpError(404,'附件暂时无法读取');return new Response(object.body,{headers:{'Content-Type':f.content_type,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"}});}catch(e){return error(e);}}
