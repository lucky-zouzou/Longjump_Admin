import {env} from 'cloudflare:workers';
import {database,ensureSchema} from '../../../../lib/database';
import {requireActor} from '../../../../lib/auth';
import {uploadWorkplaceProof,readWorkplaceProof} from '../../../../lib/workplace-files.mjs';
import {workplaceError} from '../route';
export async function POST(request:Request){try{if(request.headers.get('origin')&&request.headers.get('origin')!==new URL(request.url).origin)return Response.json({error:'请求来源无效'},{status:403});if(Number(request.headers.get('content-length')||0)>11*1024*1024)return Response.json({error:'文件过大'},{status:413});await ensureSchema();const a=await requireActor(request),form=await request.formData();return Response.json(await uploadWorkplaceProof(database(),env.WHOLESALE_FILES,a,String(form.get('requestId')||''),form.get('file')));}catch(e){return workplaceError(e);}}
export async function GET(request:Request){try{await ensureSchema();const a=await requireActor(request),r=await readWorkplaceProof(database(),env.WHOLESALE_FILES,a,new URL(request.url).searchParams.get('id'));return new Response(r.object.body,{headers:{'Content-Type':r.file.mime,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(r.file.filename)}`,'Cache-Control':'private,no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"}});}catch(e){return workplaceError(e);}}
