import * as XLSX from "xlsx";
import { database } from "../../../../lib/database";
import { HttpError, requireActor } from "../../../../lib/auth";
import { indonesiaDate, WholesaleError } from "../../../../lib/wholesale.mjs";
import { loadWholesaleExportSnapshot } from "../../../../lib/wholesale-export.mjs";
import { toWholesaleWorkbook, wholesaleExportSheets } from "../../../../lib/wholesale-finance.mjs";
import { wholesaleLanguage,wholesaleDownloadName,translateWholesale } from "../../../../lib/wholesale-i18n.mjs";

export async function GET(request:Request){try{
  const actor=await requireActor(request),params=new URL(request.url).searchParams,mode=params.get("mode")||"all",month=params.get("month")||indonesiaDate().slice(0,7);
  if(!["all","month"].includes(mode)||!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||month>indonesiaDate().slice(0,7))throw new HttpError(400,"请选择有效的导出范围和月份");
  const language=wholesaleLanguage(params.get("lang"));
  let snapshot=await loadWholesaleExportSnapshot(database(),actor);
  if(mode==="month"&&["管理员","财务"].includes(actor.role)){
    const period=await database().prepare("SELECT snapshot_json FROM wholesale_finance_periods WHERE month=? AND status='closed'").bind(month).first<{snapshot_json:string}>();
    if(period)snapshot={...JSON.parse(period.snapshot_json),actor};
  }
  const sheets=wholesaleExportSheets(snapshot,{mode,month,asOfDate:indonesiaDate(),exportedAt:new Date().toISOString(),language});
  const workbook=toWholesaleWorkbook(XLSX,sheets,language);
  const bytes=XLSX.write(workbook,{type:"array",bookType:"xlsx",compression:true});
  const name=wholesaleDownloadName(language,mode,mode==="all"?indonesiaDate():month);
  return new Response(bytes,{headers:{"Content-Type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","Content-Disposition":`attachment; filename*=UTF-8''${encodeURIComponent(name)}`,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});
}catch(error){
  const language=wholesaleLanguage(new URL(request.url).searchParams.get("lang"));
  if(error instanceof HttpError||error instanceof WholesaleError)return Response.json({error:translateWholesale(language,error.message),errorKey:error.message},{status:error.status});
  console.error("Wholesale export failed",error);const message="对账导出失败，请稍后重试；系统未生成不完整报表";return Response.json({error:translateWholesale(language,message),errorKey:message},{status:500});
}}
