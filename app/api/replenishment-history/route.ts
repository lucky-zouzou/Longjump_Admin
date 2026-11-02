import {database,ensureSchema} from '../../../lib/database';
import {requireActor} from '../../../lib/auth';
import {readReplenishmentHistory} from '../../../lib/replenishment-history.mjs';

export async function GET(request:Request){
  try{
    await ensureSchema();
    const actor=await requireActor(request);
    return Response.json(await readReplenishmentHistory(database(),actor,Object.fromEntries(new URL(request.url).searchParams)),{headers:{'Cache-Control':'private, no-store'}});
  }catch(error){
    const e=error as {status?:number;message?:string};
    if(e.status)return Response.json({error:e.message},{status:e.status});
    console.error('Replenishment history request failed',error);
    return Response.json({error:'历史补货计划读取失败，请刷新重试'},{status:500});
  }
}
