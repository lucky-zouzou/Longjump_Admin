import {env} from "cloudflare:workers";
import {HttpError,requireActor,requireRole,type Actor} from "../../../lib/auth";

type CompanyAccounts={create:(actor:Actor,input:Record<string,unknown>)=>{userId:string}};
const accounts=()=>env.COMPANY_ACCOUNTS as CompanyAccounts|undefined;
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{"Cache-Control":"no-store"}});

function failure(error:unknown){
  if(error instanceof HttpError)return json({error:error.message},error.status);
  if(error instanceof Error&&"status" in error&&[400,403,409].includes(Number(error.status)))return json({error:error.message},Number(error.status));
  // Do not log submitted credentials or echo database errors to the client.
  return json({error:"新增用户失败，请稍后重试"},500);
}

export async function GET(request:Request){
  try{
    requireRole(await requireActor(request),["管理员"]);
    return json({canCreate:Boolean(accounts()),loginMode:accounts()?"company":"chatgpt"});
  }catch(error){return failure(error);}
}

export async function POST(request:Request){
  try{
    const actor=await requireActor(request);
    requireRole(actor,["管理员"]);
    if(request.headers.get("origin")!==new URL(request.url).origin)throw new HttpError(403,"请求来源无效，请从系统页面新增用户");
    const service=accounts();
    if(!service)throw new HttpError(409,"当前系统使用 ChatGPT 登录，请让成员先登录，再分配岗位权限");
    if(!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))throw new HttpError(400,"请求内容必须为 JSON");
    const text=await request.text();
    if(text.length>8192)throw new HttpError(413,"请求内容过大");
    let input:Record<string,unknown>;
    try{input=JSON.parse(text);}catch{throw new HttpError(400,"请求内容格式不正确");}
    return json({ok:true,...service.create(actor,input)},201);
  }catch(error){return failure(error);}
}
