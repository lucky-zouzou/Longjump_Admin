import {database,ensureSchema} from '../../../lib/database';
import {HttpError,requireActor} from '../../../lib/auth';
import {readSalesDashboard,SalesReportError} from '../../../lib/sales-dashboard.mjs';
export async function GET(request:Request){
  try{
    await ensureSchema();
    const actor=await requireActor(request),params=Object.fromEntries(new URL(request.url).searchParams);
    return Response.json(await readSalesDashboard(database(),actor,params),{headers:{'Cache-Control':'no-store'}});
  }catch(error){
    if(error instanceof HttpError||error instanceof SalesReportError)return Response.json({error:error.message},{status:error.status});
    console.error('Sales dashboard failed',error);
    return Response.json({error:'销售看板暂时无法加载，请重试'},{status:500});
  }
}
