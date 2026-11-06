import { database, ensureSchema } from "../../../../lib/database";
import { requireActor, HttpError } from "../../../../lib/auth";
import { manageDistributorLink } from "../../../../lib/distributor-ordering.mjs";
import { WholesaleError } from "../../../../lib/wholesale.mjs";
import { ConflictError } from "../../../../lib/atomic.mjs";

export async function POST(request:Request){
  const headers={"Cache-Control":"no-store"};
  try {
    if(request.headers.get("origin")!==new URL(request.url).origin) throw new HttpError(403,"请求来源无效");
    const actor=await requireActor(request);
    await ensureSchema();
    const result=await manageDistributorLink(database(),actor,await request.json());
    return Response.json(result,{headers});
  }catch(error){
    const known=error instanceof HttpError||error instanceof WholesaleError||error instanceof ConflictError;
    return Response.json({error:known?error.message:"无法更新客户链接，请刷新后重试"},{headers,status:known?error.status:500});
  }
}
