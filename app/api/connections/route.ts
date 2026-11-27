import {requireActor,requireRole} from '../../../lib/auth';
async function unavailable(request:Request){try{requireRole(await requireActor(request),['管理员']);return Response.json({error:'平台连接需使用 LOONG JUMP 公司服务器，请由管理员配置服务端连接服务'},{status:503,headers:{'Cache-Control':'no-store'}});}catch(e:any){return Response.json({error:e.status?e.message:'连接暂时不可用'},{status:e.status||503});}}
export const GET=unavailable;
export const POST=unavailable;
