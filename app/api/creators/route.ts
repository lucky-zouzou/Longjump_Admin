import {database,ensureSchema} from '../../../lib/database';
import {requireActor} from '../../../lib/auth';
import {readCreators,mutateCreator} from '../../../lib/creators.mjs';
function error(e:any){if(e.status)return Response.json({error:e.message},{status:e.status});console.error('Creator request failed',e);return Response.json({error:'达人记录未保存，请保留内容并重试'},{status:500});}
export async function GET(request:Request){try{await ensureSchema();return Response.json(await readCreators(database(),await requireActor(request)),{headers:{'Cache-Control':'private, no-store'}});}catch(e){return error(e);}}
export async function POST(request:Request){try{
 if(request.headers.get('origin')&&request.headers.get('origin')!==new URL(request.url).origin)return Response.json({error:'请求来源无效'},{status:403});
 await ensureSchema();const actor=await requireActor(request),raw=await request.text();if(raw.length>40000)return Response.json({error:'内容过长'},{status:413});
 let p;try{p=JSON.parse(raw);}catch{return Response.json({error:'请求格式错误'},{status:400});}if(!p||typeof p!=='object'||Array.isArray(p))return Response.json({error:'请求格式错误'},{status:400});
 return Response.json(await mutateCreator(database(),actor,p),{headers:{'Cache-Control':'private, no-store'}});
 }catch(e){return error(e);}}
