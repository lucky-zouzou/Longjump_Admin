import {env} from 'cloudflare:workers';
import {database,ensureSchema} from '../../../../lib/database';
import {requireActor} from '../../../../lib/auth';
import {context,fail} from '../../../../lib/workplace-common.mjs';
import {readFeishuAttendance,saveFeishuSettings,saveFeishuUserLink} from '../../../../lib/feishu-store.mjs';
import {feishuCredentialIdentity,testFeishuConnection} from '../../../../lib/feishu-sync.mjs';
import {workplaceError} from '../route';
type Runtime={readFeishuCredentials?:()=>{appId:string;appSecret:string}|null;startFeishuSync?:(actor:unknown,input:unknown)=>Promise<unknown>};
const runtime=env as unknown as Runtime;
const credentials=()=>runtime.readFeishuCredentials?.()||null;
export async function GET(request:Request){try{await ensureSchema();const actor=await requireActor(request),q=Object.fromEntries(new URL(request.url).searchParams),data=await readFeishuAttendance(database(),actor,q) as Awaited<ReturnType<typeof readFeishuAttendance>> & {configuration?:unknown;credentialsConfigured?:boolean};if(data.configuration){try{data.credentialsConfigured=Boolean(credentials());}catch{data.credentialsConfigured=false;}}return Response.json(data,{headers:{'Cache-Control':'private,no-store'}});}catch(error){return workplaceError(error);}}
export async function POST(request:Request){try{
 if(request.headers.get('origin')!==new URL(request.url).origin)return Response.json({error:'请求来源无效'},{status:403});
 await ensureSchema();const actor=await requireActor(request),db=database();if((await context(db,actor)).a.role!=='管理员')fail('仅管理员配置飞书同步',403);
 const raw=await request.text();if(raw.length>16000)fail('内容过大',413);let p;try{p=JSON.parse(raw);}catch{fail('格式错误');}if(!p||typeof p!=='object'||Array.isArray(p))fail('格式错误');
 let result;
 if(p.action==='settings'){if(p.enabled===true)await testFeishuConnection(db,credentials(),{requireMappings:true});const key=p.enabled===true?await feishuCredentialIdentity(credentials()):{};result=await saveFeishuSettings(db,actor,p,key);}
 else if(p.action==='mapping')result=await saveFeishuUserLink(db,actor,p);
 else if(p.action==='test')result=await testFeishuConnection(db,credentials());
 else if(p.action==='sync'){if(!runtime.startFeishuSync)fail('当前部署尚未配置飞书后台同步服务',503);result=await runtime.startFeishuSync!(actor,{from:p.from,to:p.to});}
 else fail('飞书操作无效');
 return Response.json(result,{status:p.action==='sync'?202:200,headers:{'Cache-Control':'private,no-store'}});
 }catch(error){const e=error as {status?:number;code?:string};if(e.code&&!e.status)return Response.json({error:'飞书连接或数据读取未完成，请核对应用权限及员工范围。',code:e.code},{status:502});return workplaceError(error);}}
