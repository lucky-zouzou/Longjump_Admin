import { requireActor } from '../../../lib/auth';
import { database } from '../../../lib/database';
import { readCenter, mutateCenter } from '../../../lib/content-center.mjs';

const headers={'Cache-Control':'private, no-store'};
function failure(e:any){
  if(!e.status)console.error('content-center',e);
  return Response.json({error:e.status?e.message:'内容中心操作失败，请刷新后核对记录。'},{status:e.status||500,headers});
}
export async function GET(request:Request){
  try{return Response.json(await readCenter(database(),await requireActor(request)),{headers});}
  catch(e){return failure(e);}
}
export async function POST(request:Request){
  try{
    if(request.headers.has('origin')&&request.headers.get('origin')!==new URL(request.url).origin)return Response.json({error:'请求来源无效'},{status:403});
    const actor=await requireActor(request);
    const raw=await request.text();
    if(raw.length>64000)return Response.json({error:'请缩短表单内容'},{status:413});
    let form;try{form=JSON.parse(raw);}catch{return Response.json({error:'表单格式无效'},{status:400});}
    return Response.json(await mutateCenter(database(),actor,form),{headers});
  }catch(e){return failure(e);}
}
