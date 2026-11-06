import {env} from 'cloudflare:workers';
import {requireActor} from '../../../../lib/auth';
import {database} from '../../../../lib/database';
import {listMaterials,materialResponse,updateMaterials,uploadMaterialPart} from '../../../../lib/content-materials.mjs';

const headers={'Cache-Control':'private, no-store'};
function failure(error:any){
  if(!error?.status)console.error('content materials',error);
  return Response.json({error:error?.status?error.message:'素材操作失败，请重试'},{status:error?.status||500,headers});
}
export async function GET(request:Request){
  try{
    const actor=await requireActor(request),query=new URL(request.url).searchParams;
    if(query.has('id'))return await materialResponse(database(),env.WHOLESALE_FILES,actor,query.get('id'),request.headers.get('range'),query.get('download')==='1');
    return Response.json(await listMaterials(database(),actor,Object.fromEntries(query)),{headers});
  }catch(error){return failure(error);}
}
export async function POST(request:Request){
  try{
    if(request.headers.get('origin')!==new URL(request.url).origin)return Response.json({error:'请求来源无效'},{status:403,headers});
    const actor=await requireActor(request),type=request.headers.get('content-type')||'';
    if(type.startsWith('multipart/form-data')){
      if(Number(request.headers.get('content-length'))>9*1024*1024)return Response.json({error:'视频分片过大'},{status:413,headers});
      const form=await request.formData();
      let meta;try{meta=JSON.parse(String(form.get('meta')));}catch{return Response.json({error:'上传资料格式无效'},{status:400,headers});}
      if(!meta||typeof meta!=='object')return Response.json({error:'缺少素材资料'},{status:400,headers});
      const result=await uploadMaterialPart(database(),env.WHOLESALE_FILES,actor,meta,Number(form.get('part')??-1),form.get('file'));
      return Response.json(result,{headers});
    }
    const raw=await request.text();
    if(raw.length>12000)return Response.json({error:'请缩小本次操作范围'},{status:413,headers});
    let data;try{data=JSON.parse(raw);}catch{return Response.json({error:'请求格式无效'},{status:400,headers});}
    if(!data||typeof data!=='object')return Response.json({error:'请先选择素材'},{status:400,headers});
    return Response.json(await updateMaterials(database(),actor,data),{headers});
  }catch(error){return failure(error);}
}
