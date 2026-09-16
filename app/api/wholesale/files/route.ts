import { env } from "cloudflare:workers";
import { database, makeId, nowIso } from "../../../../lib/database";
import { HttpError, requireActor } from "../../../../lib/auth";
import { hasPermission } from "../../../../lib/permissions.mjs";
import { canReadWholesaleOrder } from "../../../../lib/wholesale.mjs";
import { translateWholesale,wholesaleLanguage } from "../../../../lib/wholesale-i18n.mjs";
type Order={id:string;status:string;supply_user_id:string;sales_user_id:string};
type FileRow={id:string;order_id:string;object_key:string;content_type:string;name:string};
interface Bucket {put(key:string,value:ArrayBuffer,options:{httpMetadata:{contentType:string}}):Promise<unknown>;get(key:string):Promise<{body:ReadableStream}|null>;delete(key:string):Promise<void>}
const bucket=()=>{if(!env.WHOLESALE_FILES)throw new HttpError(503,"凭证存储暂时不可用，请稍后重试");return env.WHOLESALE_FILES as Bucket;};
function errorResponse(error:unknown,request:Request){const language=wholesaleLanguage(new URL(request.url).searchParams.get("lang"));if(error instanceof HttpError)return Response.json({error:translateWholesale(language,error.message),errorKey:error.message},{status:error.status});console.error("Wholesale file failed",error);const message="凭证读取或上传失败，请稍后重试";return Response.json({error:translateWholesale(language,message),errorKey:message},{status:500});}
export async function POST(request:Request){try{
  const actor=await requireActor(request),origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new HttpError(403,"请求来源无效");
  if(Number(request.headers.get("content-length")||0)>21*1024*1024)throw new HttpError(413,"每份照片或视频不超过20MB");
  const form=await request.formData(),file=form.get("file"),orderId=String(form.get("orderId")||"").slice(0,100);
  const order=await database().prepare("SELECT * FROM wholesale_orders WHERE id=?").bind(orderId).first<Order>();
  if(!order||!canReadWholesaleOrder(actor,order)||!hasPermission(actor.role,"wholesale.ship"))throw new HttpError(403,"仅该订单供应链负责人或管理员可上传发货凭证");
  if(!["approved","packing","partial"].includes(order.status))throw new HttpError(409,"请在订单审批后、发货完成前上传凭证");
  if(!(file instanceof File)||file.size<=0||file.size>20*1024*1024)throw new HttpError(400,"请选择不超过20MB的照片或视频");
  if(!["image/jpeg","image/png","image/webp","video/mp4","video/webm","video/quicktime"].includes(file.type))throw new HttpError(400,"支持 JPG、PNG、WebP、MP4、WebM、MOV");
  const bytes=await file.arrayBuffer(),b=new Uint8Array(bytes),ascii=(a:number,z:number)=>String.fromCharCode(...b.slice(a,z));
  const valid=file.type==="image/jpeg"?b[0]===255&&b[1]===216&&b[2]===255:file.type==="image/png"?b[0]===137&&ascii(1,4)==="PNG":file.type==="image/webp"?ascii(0,4)==="RIFF"&&ascii(8,12)==="WEBP":file.type==="video/webm"?b[0]===26&&b[1]===69&&b[2]===223&&b[3]===163:ascii(4,8)==="ftyp";
  if(!valid)throw new HttpError(400,"文件内容与照片／视频格式不符");
  const id=makeId("whfile"),key=`wholesale/${order.id}/${id}`,name=file.name.replace(/[\r\n]/g,"").slice(0,180);
  await bucket().put(key,bytes,{httpMetadata:{contentType:file.type}});
  try{await database().prepare("INSERT INTO wholesale_files (id,order_id,object_key,name,content_type,size,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(id,order.id,key,name,file.type,file.size,actor.id,nowIso()).run();}catch(error){await bucket().delete(key);throw error;}
  return Response.json({ok:true,id,name});
}catch(error){return errorResponse(error,request);}}
export async function GET(request:Request){try{
  const actor=await requireActor(request),id=new URL(request.url).searchParams.get("id")||"";
  const file=await database().prepare("SELECT * FROM wholesale_files WHERE id=?").bind(id).first<FileRow>();
  if(!file)throw new HttpError(404,"凭证不存在");
  const order=await database().prepare("SELECT * FROM wholesale_orders WHERE id=?").bind(file.order_id).first<Order>();
  if(!order||!canReadWholesaleOrder(actor,order))throw new HttpError(403,"无权查看该出库凭证");
  const object=await bucket().get(file.object_key);if(!object)throw new HttpError(404,"凭证暂时无法读取");
  return new Response(object.body,{headers:{"Content-Type":file.content_type,"Content-Disposition":`inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,"X-Content-Type-Options":"nosniff","Cache-Control":"private, no-store","Content-Security-Policy":"default-src 'none'; sandbox"}});
}catch(error){return errorResponse(error,request);}}
