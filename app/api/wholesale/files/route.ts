import { env } from "cloudflare:workers";
import { database } from "../../../../lib/database";
import { HttpError, requireActor } from "../../../../lib/auth";
import { uploadWholesaleFile,canFinanceProof } from "../../../../lib/wholesale-files.mjs";
import { ConflictError } from "../../../../lib/atomic.mjs";
import { canReadWholesaleOrder,WholesaleError } from "../../../../lib/wholesale.mjs";
import { translateWholesale,wholesaleLanguage } from "../../../../lib/wholesale-i18n.mjs";
type Order={id:string;status:string;supply_user_id:string;sales_user_id:string};
type FileRow={id:string;order_id:string;object_key:string;content_type:string;name:string;purpose:string};
interface Bucket {put(key:string,value:ArrayBuffer,options:{httpMetadata:{contentType:string}}):Promise<unknown>;get(key:string):Promise<{body:ReadableStream}|null>;delete(key:string):Promise<void>}
const bucket=()=>{if(!env.WHOLESALE_FILES)throw new HttpError(503,"凭证存储暂时不可用，请稍后重试");return env.WHOLESALE_FILES as Bucket;};
function errorResponse(error:unknown,request:Request){const language=wholesaleLanguage(new URL(request.url).searchParams.get("lang"));if(error instanceof HttpError||error instanceof WholesaleError||error instanceof ConflictError)return Response.json({error:translateWholesale(language,error.message),errorKey:error.message},{status:error.status});console.error("Wholesale file failed",error);const message="凭证读取或上传失败，请稍后重试";return Response.json({error:translateWholesale(language,message),errorKey:message},{status:500});}
export async function POST(request:Request){try{
  const actor=await requireActor(request),origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new HttpError(403,"请求来源无效");
  if(Number(request.headers.get("content-length")||0)>21*1024*1024)throw new HttpError(413,"每份附件不超过20MB");
  const form=await request.formData();
  const result=await uploadWholesaleFile(database(),bucket(),actor,{orderId:String(form.get("orderId")||"").slice(0,100),purpose:String(form.get("purpose")||"shipment"),entryId:String(form.get("entryId")||"").slice(0,100),file:form.get("file")});
  return Response.json(result);
}catch(error){return errorResponse(error,request);}}
export async function GET(request:Request){try{
  const actor=await requireActor(request),id=new URL(request.url).searchParams.get("id")||"";
  const file=await database().prepare("SELECT * FROM wholesale_files WHERE id=?").bind(id).first<FileRow>();
  if(!file)throw new HttpError(404,"凭证不存在");
  const order=await database().prepare("SELECT * FROM wholesale_orders WHERE id=?").bind(file.order_id).first<Order>();
  if(!order||!canReadWholesaleOrder(actor,order))throw new HttpError(403,"无权查看该出库凭证");
  if(file.purpose==="finance"&&!canFinanceProof(actor))throw new HttpError(403,"仅财务和管理员可上传或查看回款凭证");
  const object=await bucket().get(file.object_key);if(!object)throw new HttpError(404,"凭证暂时无法读取");
  return new Response(object.body,{headers:{"Content-Type":file.content_type,"Content-Disposition":`inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,"X-Content-Type-Options":"nosniff","Cache-Control":"private, no-store","Content-Security-Policy":"default-src 'none'; sandbox"}});
}catch(error){return errorResponse(error,request);}}
