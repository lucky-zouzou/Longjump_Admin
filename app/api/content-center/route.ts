import { requireActor } from '../../../lib/auth';
import { database } from '../../../lib/database';
import {env} from 'cloudflare:workers';
import { readCenterCompass, previewReport, reportHistory, readPlatformReports, readCenter, mutateCenter, referenceLimit } from '../../../lib/content-center.mjs';

const headers={'Cache-Control':'private, no-store'};
function failure(e:any){
  if(!e.status)console.error('content-center',e);
  return Response.json({error:e.status?e.message:'内容中心操作失败，请刷新后核对记录。'},{status:e.status||500,headers});
}
export async function GET(request:Request){
  try{
    const actor=await requireActor(request),query=new URL(request.url).searchParams;
    const data=query.get('view')==='compass'
      ?await readCenterCompass(database(),actor,query.get('period')||'month',query.get('range')||'')
      :query.get('view')==='report-history'?await reportHistory(database(),actor,query.get('site'),query.get('start'),query.get('end'),query.get('videoId'),Number(query.get('offset')||0))
      :query.get('view')==='platform-report'?await readPlatformReports(database(),actor,query.get('site'),Number(query.get('offset')||0),query.get('period')||'all',Date.now(),query.get('range')||'',query.get('matching')||'all')
      :await readCenter(database(),actor);
    return Response.json(data,{headers});
  }
  catch(e){return failure(e);}
}
export async function POST(request:Request){
  try{
    if(request.headers.has('origin')&&request.headers.get('origin')!==new URL(request.url).origin)return Response.json({error:'请求来源无效'},{status:403});
    const actor=await requireActor(request);
    if(request.headers.get('content-type')?.startsWith('multipart/form-data')){
      if(Number(request.headers.get('content-length')||0)>referenceLimit+65536)return Response.json({error:'参考视频须在 16 MB 以内'},{status:413,headers});
      const data=await request.formData(),payload=data.get('payload'),file=data.get('reference');
      if(typeof payload!=='string'||payload.length>32000||!(file instanceof Blob))return Response.json({error:'请重新选择参考视频'},{status:400,headers});
      let form;try{form=JSON.parse(payload);}catch{return Response.json({error:'需求表单格式无效'},{status:400,headers});}
      const bucket=env.WHOLESALE_FILES as NonNullable<Parameters<typeof mutateCenter>[3]>['bucket']|undefined;
      if(!bucket)return Response.json({error:'参考视频存储暂不可用，请稍后重试'},{status:503,headers});
      return Response.json(await mutateCenter(database(),actor,form,{bucket,file}),{headers});
    }
    const raw=await request.text();
    if(raw.length>3*1024*1024)return Response.json({error:'请缩短表单内容'},{status:413});
    let form;try{form=JSON.parse(raw);}catch{return Response.json({error:'表单格式无效'},{status:400});}
    if(raw.length>240000&&!['previewPlatformReport','importPlatformReport'].includes(form?.action))return Response.json({error:'请缩短表单内容'},{status:413,headers});
    return Response.json(form?.action==='previewPlatformReport'?await previewReport(database(),actor,form):await mutateCenter(database(),actor,form),{headers});
  }catch(e){return failure(e);}
}
