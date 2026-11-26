import {database} from '../../../lib/database';
import {HttpError,requireActor} from '../../../lib/auth';
import {readAdvertisingTrend} from '../../../lib/advertising-trend.mjs';
import {AdvertisingTrendError} from '../../../lib/advertising-trend-model.mjs';
const headers={'Cache-Control':'private, no-store'};
export async function GET(request:Request){
 try{
  const actor=await requireActor(request),input=Object.fromEntries(new URL(request.url).searchParams);
  return Response.json(await readAdvertisingTrend(database(),actor,input),{headers});
 }catch(error){
  if(error instanceof HttpError||error instanceof AdvertisingTrendError)return Response.json({error:error.message},{status:error.status,headers});
  return Response.json({error:'广告费用趋势暂时没有读出来，请稍后刷新。'},{status:500,headers});
 }
}
