import {database,ensureSchema} from '../../../lib/database';
import {requireActor,HttpError} from '../../../lib/auth';
import {InquiryError} from '../../../lib/website-inquiry-auth.mjs';
import {ConflictError} from '../../../lib/atomic.mjs';
import {readWebsiteLeads,mutateWebsiteLead} from '../../../lib/website-leads.mjs';
function failed(error:unknown){
 if(error instanceof InquiryError||error instanceof ConflictError||error instanceof HttpError)return Response.json({error:error.message},{status:error.status});
 console.error('Website lead request failed',error);
 return Response.json({error:'线索暂时无法读取或保存，请保留内容后重试'},{status:500});
}
export async function GET(request:Request){try{
 await ensureSchema();const actor=await requireActor(request);
 return Response.json(await readWebsiteLeads(database(),actor,Object.fromEntries(new URL(request.url).searchParams)),{headers:{'Cache-Control':'no-store'}});
}catch(error){return failed(error);}}
export async function POST(request:Request){try{
 if(request.headers.get('origin')!==new URL(request.url).origin)throw new HttpError(403,'请求来源无效');
 await ensureSchema();const actor=await requireActor(request);
 const reader=request.body?.getReader(),decoder=new TextDecoder();let raw='',size=0;
 if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>32000){await reader.cancel();throw new HttpError(413,'线索内容过大');}raw+=decoder.decode(value,{stream:true});}raw+=decoder.decode();
 let payload;try{payload=JSON.parse(raw);}catch{throw new HttpError(400,'请求格式无效');}
 if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new HttpError(400,'请求格式无效');
 return Response.json(await mutateWebsiteLead(database(),actor,payload));
}catch(error){return failed(error);}}
