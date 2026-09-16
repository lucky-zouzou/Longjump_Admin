import {ConflictError} from "../../../lib/atomic.mjs";
import { database, ensureSchema } from "../../../lib/database";
import { HttpError, requireActor } from "../../../lib/auth";
import { indonesiaDate, mutateWholesale, readWholesale, WholesaleError } from "../../../lib/wholesale.mjs";

function errorResponse(error:unknown){
  if(error instanceof ConflictError||error instanceof WholesaleError||error instanceof HttpError)return Response.json({error:error.message},{status:error.status});
  console.error("Wholesale request failed",error);
  return Response.json({error:"线下业务暂时无法保存，请保留填写内容后重试；请勿重复创建同一订单"},{status:500});
}
export async function GET(request:Request){try{await ensureSchema();const actor=await requireActor(request);const month=new URL(request.url).searchParams.get("month")||indonesiaDate().slice(0,7);return Response.json(await readWholesale(database(),actor,month),{headers:{"Cache-Control":"no-store"}});}catch(error){return errorResponse(error);}}
export async function POST(request:Request){try{
  const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new HttpError(403,"请求来源无效");
  if(Number(request.headers.get("content-length")||0)>100000)throw new HttpError(413,"订单内容过大");
  await ensureSchema();const actor=await requireActor(request);const payload=await request.json();return Response.json(await mutateWholesale(database(),actor,payload));
}catch(error){return errorResponse(error);}}
