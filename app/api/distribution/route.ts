import {database,ensureSchema} from '../../../lib/database';
import {requireActor} from '../../../lib/auth';
import {readDistribution,mutateDistribution} from '../../../lib/distribution-management.mjs';
const failed=(e:any)=>Response.json({error:e.status?e.message:'分销服务暂不可用，请刷新后重试'},{status:e.status||500});
export async function GET(request:Request){try{await ensureSchema();return Response.json(await readDistribution(database(),await requireActor(request),Object.fromEntries(new URL(request.url).searchParams)),{headers:{'Cache-Control':'private, no-store'}});}catch(e){return failed(e);}}
export async function POST(request:Request){try{
 if(request.headers.get('origin')!==new URL(request.url).origin)return Response.json({error:'请求来源无效'},{status:403});
 const reader=request.body?.getReader();let raw='',size=0;const decoder=new TextDecoder();if(reader)for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>12000){await reader.cancel();return Response.json({error:'内容过长'},{status:413});}raw+=decoder.decode(value,{stream:true});}raw+=decoder.decode();
 let p;try{p=JSON.parse(raw);if(!p||typeof p!=='object'||Array.isArray(p))throw Error();}catch{return Response.json({error:'请求格式无效'},{status:400});}await ensureSchema();return Response.json(await mutateDistribution(database(),await requireActor(request),p),{headers:{'Cache-Control':'private, no-store'}});
 }catch(e){return failed(e);}}
