import {database,ensureSchema} from '../../../lib/database';
import {requireActor} from '../../../lib/auth';
import {readPilot,mutatePilot} from '../../../lib/agent-pilot.mjs';
function errorResponse(error:any){return Response.json({error:error.status?error.message:'试点巡检暂时未完成，已有待办会保留，请稍后重试'},{status:error.status||500});}
export async function GET(request:Request){try{await ensureSchema();return Response.json(await readPilot(database(),await requireActor(request)),{headers:{'Cache-Control':'no-store'}});}catch(error){return errorResponse(error);}}
export async function POST(request:Request){try{const origin=request.headers.get('origin');if(origin&&origin!==new URL(request.url).origin)return Response.json({error:'请求来源无效'},{status:403});await ensureSchema();const actor=await requireActor(request),body=await request.text();if(body.length>20000)return Response.json({error:'内容过长'},{status:413});let p;try{p=JSON.parse(body);}catch{return Response.json({error:'请求格式无效'},{status:400});}if(!p||Array.isArray(p)||typeof p!=='object')return Response.json({error:'请求格式无效'},{status:400});return Response.json(await mutatePilot(database(),actor,p));}catch(error){return errorResponse(error);}}
