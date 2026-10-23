import {database,ensureSchema} from '../../../lib/database';
import {requireActor} from '../../../lib/auth';
import {readSalesTargets,saveSalesTarget,salesTargetHistory} from '../../../lib/sales-targets.mjs';
import {reportToday} from '../../../lib/sales-dashboard.mjs';
function error(e:any){if(e.status)return Response.json({error:e.message},{status:e.status});console.error('Monthly sales target request failed',e);return Response.json({error:'月度任务暂未完成，请保留填写内容并重试'},{status:500});}
export async function GET(request:Request){try{await ensureSchema();const a=await requireActor(request),q=new URL(request.url).searchParams;return Response.json(q.has('history')?await salesTargetHistory(database(),a,q.get('history')):await readSalesTargets(database(),a,q.get('month')||reportToday().slice(0,7)),{headers:{'Cache-Control':'private, no-store'}});}catch(e){return error(e);}}
export async function POST(request:Request){try{
 if(request.headers.get('origin')&&request.headers.get('origin')!==new URL(request.url).origin)return Response.json({error:'请求来源无效'},{status:403});
 await ensureSchema();const a=await requireActor(request),raw=await request.text();if(raw.length>12000)return Response.json({error:'内容过长'},{status:413});
 let p;try{p=JSON.parse(raw);}catch{return Response.json({error:'请求格式错误'},{status:400});}if(!p||typeof p!=='object'||Array.isArray(p))return Response.json({error:'请求格式错误'},{status:400});
 return Response.json(await saveSalesTarget(database(),a,p));
 }catch(e){return error(e);}}
