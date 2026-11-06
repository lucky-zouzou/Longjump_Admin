import {readPracticeFile} from '../../../lib/creator-practice-file.mjs';
import {database,ensureSchema} from '../../../lib/database';
import {requireActor} from '../../../lib/auth';
import {readCreators,mutateCreator} from '../../../lib/creators.mjs';
function error(e:any){if(e.status)return Response.json({error:e.message},{status:e.status});console.error('Creator request failed',e);return Response.json({error:'达人记录未保存，请保留内容并重试'},{status:500});}
export async function GET(request:Request){try{await ensureSchema();const actor=await requireActor(request),fileId=new URL(request.url).searchParams.get('practiceFile');
 if(fileId){const f=await readPracticeFile(database(),actor,fileId);return new Response(Uint8Array.from(atob(f.payload),c=>c.charCodeAt(0)),{headers:{'Content-Type':f.mime,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(f.filename)}});}
 return Response.json(await readCreators(database(),actor),{headers:{'Cache-Control':'private, no-store'}});}catch(e){return error(e);}}
export async function POST(request:Request){try{
 if(request.headers.get('origin')&&request.headers.get('origin')!==new URL(request.url).origin)return Response.json({error:'请求来源无效'},{status:403});
 await ensureSchema();const actor=await requireActor(request),raw=await request.text();if(raw.length>1500000)return Response.json({error:'内容过长'},{status:413});
 let p;try{p=JSON.parse(raw);}catch{return Response.json({error:'请求格式错误'},{status:400});}if(!p||typeof p!=='object'||Array.isArray(p))return Response.json({error:'请求格式错误'},{status:400});
 if(raw.length>200000&&!['practiceCreate','practiceRevise'].includes(p.action))return Response.json({error:'内容过长'},{status:413});
 if(p.action==='round')return Response.json({error:'请在达人档案发起合作需求，由BD接收并确认。'},{status:409});
 return Response.json(await mutateCreator(database(),actor,p),{headers:{'Cache-Control':'private, no-store'}});
 }catch(e){return error(e);}}
