import {financialSalesSummary} from '../../../lib/finance-sales.mjs';
import {database,ensureSchema} from '../../../lib/database';
import {HttpError,requireActor} from '../../../lib/auth';
import {readSalesDashboard,SalesReportError} from '../../../lib/sales-dashboard.mjs';
import {loadSalesFx,convertSalesSummary} from '../../../lib/sales-fx.mjs';
export async function GET(request:Request){
  try{
    await ensureSchema();
    const actor=await requireActor(request),params=Object.fromEntries(new URL(request.url).searchParams);
    const report=await readSalesDashboard(database(),actor,params);
    if(actor.role==='工厂')return Response.json(report,{headers:{'Cache-Control':'no-store'}});
    const cny=params.fxMode==='financial'?await financialSalesSummary(database(),actor,report):convertSalesSummary(report,await loadSalesFx(database()));
    return Response.json({...report,cny},{headers:{'Cache-Control':'no-store'}});
  }catch(error){
    if(error instanceof HttpError||error instanceof SalesReportError)return Response.json({error:error.message},{status:error.status});
    if((error as {status?:number}).status)return Response.json({error:(error as Error).message},{status:(error as {status:number}).status});
    console.error('Sales dashboard failed',error);
    return Response.json({error:'销售看板暂时无法加载，请重试'},{status:500});
  }
}
