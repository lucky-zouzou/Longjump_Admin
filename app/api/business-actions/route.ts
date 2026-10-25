import {database,ensureSchema} from '../../../lib/database';
import {requireActor} from '../../../lib/auth';
import {readBusinessActions,mutateBusinessAction,actionHistory,readActionFinanceDay} from '../../../lib/business-actions.mjs';
function error(e:any){if(e.status)return Response.json({error:e.message},{status:e.status});console.error('Business action request failed',e);return Response.json({error:'经营行动未保存，请保留内容并重试'},{status:500});}
export async function GET(request:Request){try{await ensureSchema();const actor=await requireActor(request),q=new URL(request.url).searchParams;return Response.json(q.has('financeDay')?await readActionFinanceDay(database(),actor,q.get('id'),q.get('financeDay')):q.has('history')?await actionHistory(database(),actor,q.get('history')):await readBusinessActions(database(),actor),{headers:{'Cache-Control':'private, no-store'}});}catch(e){return error(e);}}
export async function POST(request:Request){try{
 if(request.headers.get('origin')&&request.headers.get('origin')!==new URL(request.url).origin)return Response.json({error:'请求来源无效'},{status:403});
 await ensureSchema();const a=await requireActor(request),raw=await request.text();if(raw.length>20000)return Response.json({error:'内容过长'},{status:413});
 let p;try{p=JSON.parse(raw);}catch{return Response.json({error:'请求格式错误'},{status:400});}if(!p||typeof p!=='object'||Array.isArray(p))return Response.json({error:'请求格式错误'},{status:400});
 return Response.json(await mutateBusinessAction(database(),a,p));
 }catch(e){return error(e);}}
