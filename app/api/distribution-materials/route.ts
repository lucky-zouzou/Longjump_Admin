import {env} from 'cloudflare:workers';
import {database,ensureSchema} from '../../../lib/database';
import {requireActor} from '../../../lib/auth';
import {readMaterialAdmin,mutateMaterialAdmin} from '../../../lib/distributor-materials.mjs';
const headers={'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer'};
const failed=(e:any)=>Response.json({error:e.status?e.message:'素材服务暂不可用'},{status:e.status||500,headers});
export async function GET(request:Request){try{await ensureSchema();return Response.json(await readMaterialAdmin(database(),await requireActor(request),env),{headers});}catch(e){return failed(e);}}
export async function POST(request:Request){try{
 if(request.headers.get('origin')!==new URL(request.url).origin||request.headers.get('content-type')?.split(';')[0]!=='application/json')return Response.json({error:'请求来源无效'},{status:403,headers});
 const actor=await requireActor(request);const reader=request.body?.getReader();let raw='',size=0;const decoder=new TextDecoder();if(reader)for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>12000){await reader.cancel();return Response.json({error:'仅接受素材元数据，大文件请直传存储'},{status:413,headers});}raw+=decoder.decode(value,{stream:true});}
 let p;try{p=JSON.parse(raw+decoder.decode());if(!p||typeof p!=='object'||Array.isArray(p))throw Error();}catch{return Response.json({error:'格式无效'},{status:400,headers});}
 await ensureSchema();return Response.json(await mutateMaterialAdmin(database(),actor,p,env),{headers});
 }catch(e){return failed(e);}}
