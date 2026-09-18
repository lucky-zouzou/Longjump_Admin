import {publicSystemSnapshot} from "../../../lib/system-response.mjs";
import {normalizeSales,SITE_CURRENCIES} from "../../../lib/sales-data.mjs";
import {validateImportRows,groupInboundRows} from "../../../lib/tabular-import.mjs";
import {planIntegrityGuards} from "../../../lib/plan-integrity.mjs";
import {systemChecks} from "../../../lib/system-checks.mjs";
import {saveForecastData} from "../../../lib/forecast-management.mjs";
import {loadForecast} from "../../../lib/forecast";
import { PLAN_ACTIONS, managePlan } from "../../../lib/plan-changes.mjs";
import { resolveInventoryHoldSources, transportCompletionStatements } from "../../../lib/inventory-holds.mjs";
import { guardStatement, atomicBatch, assertWritable, ConflictError } from "../../../lib/atomic.mjs";
import { countStatements, reversalStatements } from "../../../lib/inventory-guard.mjs";
import { wholesaleTasks, wholesaleSalesSummary } from "../../../lib/wholesale.mjs";
import { database, ensureSchema, makeId, nowIso } from "../../../lib/database";
import { HttpError, requireActor, requireScope, ROLES, type Actor, type Role } from "../../../lib/auth";
import { canReadDomain, hasPermission } from "../../../lib/permissions.mjs";
import { allocationMatchesTotal, calculateSupplyPlan, canAdvanceBatch, financeGatePasses, missingMonthlyScopes, newProductScopeGate, prorateAllocations, REQUIRED_MONTHLY_SCOPES, roundSupplyQuantity, sampleGateReady, shelfScopesComplete } from "../../../lib/rules.mjs";

const SITES = ["马来西亚", "印尼", "泰国", "越南", "菲律宾"];
const CHANNELS = ["TikTok", "Shopee", "线下分销"];
const NEW_PRODUCT_STAGE_LABEL:Record<string,string> = { selection:"选款立项", parallel_test:"调研与种草", finance:"财务测算", sample:"打板确认", production:"首批生产", abandoned:"已放弃" };
const BATCH_STAGE_LABEL:Record<string,string> = {
  supply_confirm:"备货计划确认", factory_production:"工厂生产", channel_allocation:"渠道分配",
  sea_freight:"海运运输", port_arrived:"已到港", last_mile_delivery:"派送中",
  awaiting_receipt:"等待到仓", shelf_pending:"待上架", on_shelf:"已上架",
  arrived:"已到仓（历史）", completed:"已完成",
};
const BATCH_FLOW: Record<string, { next:string; nextOwner:string }> = {
  supply_confirm: { next:"factory_production", nextOwner:"工厂" },
  factory_production: { next:"channel_allocation", nextOwner:"供应链" },
  channel_allocation: { next:"sea_freight", nextOwner:"海运" },
  sea_freight: { next:"port_arrived", nextOwner:"海运" },
  port_arrived: { next:"last_mile_delivery", nextOwner:"海运" },
  last_mile_delivery: { next:"awaiting_receipt", nextOwner:"供应链" },
};
const BATCH_STAGE_ORDER=["supply_confirm","factory_production","channel_allocation","sea_freight","port_arrived","last_mile_delivery","awaiting_receipt","shelf_pending","on_shelf"];
const BATCH_STALL_DAYS:Record<string,number>={supply_confirm:2,factory_production:21,channel_allocation:2,sea_freight:45,port_arrived:3,last_mile_delivery:5,awaiting_receipt:2,shelf_pending:2};
const SHIPMENT_FLOW:Record<string,{next:string;nextOwner:string}>={
  channel_allocation:{next:"sea_freight",nextOwner:"海运"},
  sea_freight:{next:"port_arrived",nextOwner:"海运"},
  port_arrived:{next:"last_mile_delivery",nextOwner:"海运"},
  last_mile_delivery:{next:"awaiting_receipt",nextOwner:"供应链"},
};
const SHIPMENT_STAGE_ORDER=["channel_allocation","sea_freight","port_arrived","last_mile_delivery","awaiting_receipt","shelf_pending","on_shelf"];
const SHIPMENT_STALL_DAYS:Record<string,number>={channel_allocation:2,sea_freight:45,port_arrived:3,last_mile_delivery:5,awaiting_receipt:2,shelf_pending:2};
const TRANSPORT_FLOW:Record<string,{next:string;nextOwner:string}>={
  booking:{next:"sea_freight",nextOwner:"海运"},
  sea_freight:{next:"port_arrived",nextOwner:"海运"},
  port_arrived:{next:"customs_clearance",nextOwner:"海运"},
  customs_clearance:{next:"last_mile_delivery",nextOwner:"海运"},
  last_mile_delivery:{next:"awaiting_receipt",nextOwner:"供应链"},
};
const TRANSPORT_STAGE_ORDER=["booking","sea_freight","port_arrived","customs_clearance","last_mile_delivery","awaiting_receipt","shelf_pending","on_shelf"];
const TRANSPORT_STALL_DAYS:Record<string,number>={booking:2,sea_freight:45,port_arrived:2,customs_clearance:5,last_mile_delivery:5,awaiting_receipt:2,shelf_pending:2};

// Database rows are intentionally dynamic because this endpoint joins multiple D1 tables.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRow = Record<string, any>;
type SaleInput = { sku?:unknown; name?:unknown; qty?:unknown };
type PlanItem = { sku:string; name:string; qty:number; reason:string };

function cleanSku(value: unknown) { return String(value ?? "").trim().toUpperCase(); }
function cleanText(value: unknown, max = 240) { return String(value ?? "").trim().slice(0, max); }
function int(value: unknown) { const n = Number(value); return Number.isFinite(n) ? Math.round(n) : NaN; }
function chinaDate(offsetDays = 0) {
  const date = new Date(Date.now() + 8 * 3600_000 + offsetDays * 86400_000);
  return date.toISOString().slice(0, 10);
}
function monthKey() { return chinaDate().slice(0, 7); }
function dueAfter(days:number) { return new Date(Date.now()+days*86400_000).toISOString(); }
function daysFromToday(value:unknown) {
  const date = cleanText(value,10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return Math.ceil((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${chinaDate()}T00:00:00Z`)) / 86400_000);
}
function parseJson<T>(value: unknown, fallback: T): T { try { return JSON.parse(String(value)) as T; } catch { return fallback; } }
function scoped(actor: Actor, alias = "") {
  const prefix = alias ? `${alias}.` : "";
  if (actor.role !== "运营") return { clause:"", args:[] as unknown[] };
  return { clause:` WHERE ${prefix}site=? AND ${prefix}channel=?`, args:[actor.site, actor.channel] };
}
function audit(actor: Actor, action:string, entityType:string, entityId:string, detail:unknown) {
  return database().prepare("INSERT INTO audit_logs (id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .bind(makeId("audit"), action, entityType, entityId, JSON.stringify(detail), actor.id, actor.name, nowIso());
}
function validSiteChannel(site:string, channel:string) {
  if (!SITES.includes(site) || !CHANNELS.includes(channel)) throw new HttpError(400, "站点或渠道无效");
}
function requireBusinessPermission(actor:Actor, permission:string) {
  if(!hasPermission(actor.role,permission)) throw new HttpError(403,"当前账号没有执行此业务动作的权限");
}
function requireAssignedActor(actor:Actor, ownerRole:string, assignedUserId:unknown, actionLabel:string) {
  if(actor.role==="管理员") return;
  if(actor.role!==ownerRole) throw new HttpError(403,`当前节点只能由${ownerRole}处理`);
  const assigned=cleanText(assignedUserId,160);
  if(!assigned) throw new HttpError(409,`${actionLabel}尚未分配具体负责人，请联系管理员或供应链`);
  if(assigned!==actor.id) throw new HttpError(403,`${actionLabel}已分配给其他负责人`);
}
async function all(sql:string, args:unknown[] = []) {
  return (await database().prepare(sql).bind(...args).all<AnyRow>()).results ?? [];
}
async function body(request:Request) {
  const text=await request.text();
  if(text.length>2_000_000)throw new HttpError(413,"导入内容过大，请拆分文件");
  try { const value=JSON.parse(text);if(!value||typeof value!=="object"||Array.isArray(value))throw Error();return value as AnyRow; } catch { throw new HttpError(400, "请求内容格式不正确"); }
}
function normalizedSales(rows:SaleInput[],currency="") {
  try { return normalizeSales(rows,currency); } catch(error) { throw new HttpError(400,error instanceof Error?error.message:"销售明细无效"); }
}

export async function GET(request:Request) {
  try {
    await ensureSchema();
    const actor = await requireActor(request);
    const requestUrl = new URL(request.url);
    if (requestUrl.searchParams.get("backup") === "1") {
      requireBusinessPermission(actor,"backup.export");
      return Response.redirect(new URL("/api/backup",request.url),307);
    }
    if(actor.role==="销售") return Response.json({actor,currentMonth:monthKey(),metrics:{},myTasks:await wholesaleTasks(database(),actor),...Object.fromEntries(["inventory", "movements", "sales", "imports", "receipts", "submissions", "approvals", "batches", "skuSettings", "audit", "users", "suggestions", "monthlyStatus", "issues", "newProductProjects", "salesScopeStatus", "salesTopSkus", "purchaseOrders", "productionOrders", "shipmentBatches", "shipmentReceipts", "transportBatches", "transportReceipts", "businessPartners", "warehouses", "countRequests"].map(key=>[key,[]]))});
    const scope = scoped(actor);
    const today=chinaDate(),cutoff7=chinaDate(-6);
    const results: AnyRow[][] = await Promise.all([
      all(`SELECT * FROM inventory_balances${scope.clause} ORDER BY site,channel,sku`, scope.args),
      all(`SELECT * FROM inventory_movements${scope.clause} ORDER BY created_at DESC LIMIT 500`, scope.args),
      all(`SELECT * FROM sales_records${scope.clause}${scope.clause?" AND":" WHERE"} reversed_at IS NULL ORDER BY business_date DESC,created_at DESC LIMIT 1000`, scope.args),
      all(`SELECT * FROM sales_imports${scope.clause} ORDER BY created_at DESC LIMIT 100`, scope.args),
      all("SELECT site,channel,MAX(CASE WHEN report_kind IN ('complete','zero') THEN business_date END) last_sale_date,MAX(business_date) last_import_date,SUM(CASE WHEN business_date=? THEN total_qty ELSE 0 END) sales_today,SUM(CASE WHEN business_date>=? THEN total_qty ELSE 0 END) sales_7_qty,COUNT(DISTINCT CASE WHEN business_date>=? AND report_kind IN ('complete','zero') THEN business_date END) import_days_7 FROM sales_imports WHERE reversed_at IS NULL GROUP BY site,channel",[today,cutoff7,cutoff7]),
      all(`SELECT site,channel,sku,SUM(qty) qty FROM sales_records WHERE reversed_at IS NULL AND business_date>=?${actor.role==="运营"?" AND site=? AND channel=?":""} GROUP BY site,channel,sku ORDER BY qty DESC LIMIT 100`,actor.role==="运营"?[cutoff7,actor.site,actor.channel]:[cutoff7]),
      actor.role === "运营"
        ? all("SELECT r.*, GROUP_CONCAT(a.site||'|'||a.channel||'|'||a.qty, ';;') allocations FROM inbound_receipts r JOIN inbound_allocations a ON a.receipt_id=r.id AND a.site=? AND a.channel=? GROUP BY r.id ORDER BY r.received_at DESC LIMIT 200",[actor.site,actor.channel])
        : all("SELECT r.*, GROUP_CONCAT(a.site||'|'||a.channel||'|'||a.qty, ';;') allocations FROM inbound_receipts r LEFT JOIN inbound_allocations a ON a.receipt_id=r.id GROUP BY r.id ORDER BY r.received_at DESC LIMIT 200"),
      actor.role === "运营" ? all("SELECT * FROM monthly_submissions WHERE site=? AND channel=? ORDER BY month DESC", [actor.site, actor.channel]) : all("SELECT * FROM monthly_submissions ORDER BY month DESC,site,channel"),
      all("SELECT month,site,channel FROM monthly_submissions ORDER BY month DESC"),
      ["管理员","供应链"].includes(actor.role) ? all("SELECT * FROM approval_requests WHERE status='pending' OR id IN (SELECT id FROM approval_requests ORDER BY created_at DESC LIMIT 100) ORDER BY created_at DESC") : all("SELECT id,type,month,status,stage,decision_comment,created_at,updated_at FROM approval_requests WHERE 1=0"),
      all("SELECT * FROM production_batches WHERE stage NOT IN ('arrived','completed','on_shelf') OR id IN (SELECT id FROM production_batches ORDER BY updated_at DESC LIMIT 300) ORDER BY updated_at DESC"),
      all("SELECT * FROM new_product_projects WHERE status NOT IN ('completed','abandoned') OR id IN (SELECT id FROM new_product_projects ORDER BY updated_at DESC LIMIT 200) ORDER BY updated_at DESC"),
      all("SELECT * FROM new_product_stage_records ORDER BY submitted_at DESC"),
      all("SELECT * FROM sku_settings ORDER BY sku"),
      actor.role === "管理员" ? all("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 500") : all("SELECT * FROM audit_logs WHERE actor_id=? ORDER BY created_at DESC LIMIT 200", [actor.id]),
      all("SELECT * FROM series_purchase_orders ORDER BY updated_at DESC"),
      all("SELECT * FROM series_purchase_order_items ORDER BY updated_at DESC"),
      all("SELECT * FROM series_production_orders ORDER BY updated_at DESC"),
      all("SELECT * FROM series_production_order_items ORDER BY updated_at DESC"),
      all("SELECT * FROM shipment_batches WHERE stage NOT IN ('on_shelf') OR id IN (SELECT id FROM shipment_batches ORDER BY updated_at DESC LIMIT 500) ORDER BY updated_at DESC"),
      all("SELECT * FROM shipment_batch_items ORDER BY updated_at DESC"),
      all("SELECT * FROM shipment_receipts ORDER BY received_at DESC LIMIT 500"),
      all("SELECT * FROM shipment_receipt_items ORDER BY created_at DESC LIMIT 5000"),
      all("SELECT * FROM shipment_shelf_confirmations ORDER BY confirmed_at DESC"),
      actor.role === "管理员" ? all("SELECT * FROM users ORDER BY created_at") : actor.role==="供应链" ? all("SELECT id,email,name,role,responsibility_unit,active FROM users WHERE active=1 AND role IN ('供应链','工厂','海运') ORDER BY role,name") : all("SELECT * FROM users WHERE id=?", [actor.id]),
      canReadDomain(actor.role,"master") ? all("SELECT * FROM business_partners ORDER BY type,name") : all("SELECT * FROM business_partners WHERE 1=0"),
      canReadDomain(actor.role,"master")||canReadDomain(actor.role,"transport") ? all("SELECT * FROM warehouses ORDER BY site,channel,name") : all("SELECT * FROM warehouses WHERE 1=0"),
      canReadDomain(actor.role,"inventory") ? (actor.role==="运营"?all("SELECT * FROM inventory_count_requests WHERE site=? AND channel=? AND (status='pending' OR id IN (SELECT id FROM inventory_count_requests ORDER BY created_at DESC LIMIT 300)) ORDER BY created_at DESC",[actor.site,actor.channel]):all("SELECT * FROM inventory_count_requests WHERE status='pending' OR id IN (SELECT id FROM inventory_count_requests ORDER BY created_at DESC LIMIT 300) ORDER BY created_at DESC")) : all("SELECT * FROM inventory_count_requests WHERE 1=0"),
      canReadDomain(actor.role,"transport") ? all("SELECT * FROM transport_batches WHERE status<>'completed' OR id IN (SELECT id FROM transport_batches ORDER BY updated_at DESC LIMIT 200) ORDER BY updated_at DESC") : all("SELECT * FROM transport_batches WHERE 1=0"),
      canReadDomain(actor.role,"transport") ? all("SELECT * FROM transport_batch_items WHERE batch_id IN (SELECT id FROM transport_batches WHERE status<>'completed' OR id IN (SELECT id FROM transport_batches ORDER BY updated_at DESC LIMIT 200)) ORDER BY updated_at DESC") : all("SELECT * FROM transport_batch_items WHERE 1=0"),
      canReadDomain(actor.role,"transport") ? all("SELECT * FROM transport_legs WHERE stage<>'on_shelf' OR id IN (SELECT id FROM transport_legs ORDER BY updated_at DESC LIMIT 400) ORDER BY updated_at DESC") : all("SELECT * FROM transport_legs WHERE 1=0"),
      canReadDomain(actor.role,"transport") ? all("SELECT * FROM transport_leg_items WHERE leg_id IN (SELECT id FROM transport_legs WHERE stage<>'on_shelf' OR id IN (SELECT id FROM transport_legs ORDER BY updated_at DESC LIMIT 400)) ORDER BY updated_at DESC") : all("SELECT * FROM transport_leg_items WHERE 1=0"),
      canReadDomain(actor.role,"transport") ? all("SELECT * FROM transport_receipts ORDER BY received_at DESC LIMIT 500") : all("SELECT * FROM transport_receipts WHERE 1=0"),
      canReadDomain(actor.role,"transport") ? all("SELECT * FROM transport_receipt_items ORDER BY created_at DESC LIMIT 3000") : all("SELECT * FROM transport_receipt_items WHERE 1=0"),
      canReadDomain(actor.role,"transport") ? all("SELECT * FROM transport_shelf_confirmations ORDER BY confirmed_at DESC") : all("SELECT * FROM transport_shelf_confirmations WHERE 1=0"),
    ]);
    const [inventory, movements, sales, imports, salesScopeRows, salesTopSkus, receipts, submissions, submissionScopeRows, approvals, batches, newProductRows, newProductStageRows, skuSettings, auditRows, purchaseOrderRows, purchaseItemRows, productionOrderRows, productionItemRows, shipmentRows, shipmentItemRows, shipmentReceiptRows, shipmentReceiptItemRows, shelfConfirmationRows, users,businessPartners,warehouses,countRequests,transportRows,transportItemRows,transportLegRows,transportLegItemRows,transportReceiptRows,transportReceiptItemRows,transportShelfRows] = results;

    const salesScopeMap=new Map<string,AnyRow>(salesScopeRows.map((row)=>[`${row.site}|${row.channel}`,row]));
    const salesScopeStatus=REQUIRED_MONTHLY_SCOPES
      .filter((row)=>actor.role!=="运营"||(row.site===actor.site&&row.channel===actor.channel))
      .map((row)=>{
        const status=salesScopeMap.get(`${row.site}|${row.channel}`)??{};
        return {...row,lastImportDate:status.last_import_date||"",lastSaleDate:status.last_sale_date||"",salesToday:Number(status.sales_today||0),sales7Qty:Number(status.sales_7_qty||0),importDays7:Number(status.import_days_7||0),updatedToday:status.last_sale_date===today};
      });

    const batchViews:AnyRow[]=batches.map((batch):AnyRow=>{
      const allocations=parseJson<Array<{site:string;channel:string;qty:number}>>(batch.allocations_json,[]);
      const evidence=parseJson<AnyRow[]>(batch.evidence_json,[]);
      const shelfKeys=new Set(evidence.filter((row)=>row.stage==="on_shelf").map((row)=>`${row.site}|${row.channel}`));
      const updatedAt=Date.parse(batch.updated_at),stageAgeDays=Number.isFinite(updatedAt)?Math.max(0,Math.floor((Date.now()-updatedAt)/86400_000)):0;
      const threshold=BATCH_STALL_DAYS[batch.stage]??null;
      const stageIndex=BATCH_STAGE_ORDER.indexOf(batch.stage);
      return {...batch,allocations,evidence,stageAgeDays,stalled:threshold!==null&&stageAgeDays>threshold,stageProgress:["arrived","completed","on_shelf"].includes(batch.stage)?1:Math.max(0,stageIndex)/(BATCH_STAGE_ORDER.length-1),shelfConfirmedCount:shelfKeys.size,shelfRequiredCount:new Set(allocations.map((row)=>`${row.site}|${row.channel}`)).size};
    });
    const visibleBatches:AnyRow[]=actor.role==="运营"?batchViews.filter((batch)=>batch.allocations.some((row:AnyRow)=>row.site===actor.site&&row.channel===actor.channel)).map((batch):AnyRow=>{
      const allocations=batch.allocations.filter((row:AnyRow)=>row.site===actor.site&&row.channel===actor.channel);
      const evidence=batch.evidence.filter((row:AnyRow)=>row.stage!=="on_shelf"||(row.site===actor.site&&row.channel===actor.channel));
      return {...batch,qty:allocations.reduce((sum:number,row:AnyRow)=>sum+Number(row.qty||0),0),allocations,evidence,shelfConfirmedCount:evidence.filter((row:AnyRow)=>row.stage==="on_shelf").length,shelfRequiredCount:allocations.length};
    }):batchViews;

    const scopedAllocations=(value:unknown)=>{
      const rows=parseJson<Array<{site:string;channel:string;qty:number}>>(value,[]);
      return actor.role==="运营"?rows.filter((row)=>row.site===actor.site&&row.channel===actor.channel):rows;
    };
    const purchaseItemsByOrder=new Map<string,AnyRow[]>();
    for(const item of purchaseItemRows){
      const allocations=scopedAllocations(item.allocations_json);
      if(actor.role==="运营"&&!allocations.length) continue;
      const rows=purchaseItemsByOrder.get(item.purchase_order_id)??[];
      rows.push({...item,allocations,visibleQty:actor.role==="运营"?allocations.reduce((sum,row)=>sum+Number(row.qty||0),0):Number(item.ordered_qty||0)});
      purchaseItemsByOrder.set(item.purchase_order_id,rows);
    }
    const purchaseOrders:AnyRow[]=purchaseOrderRows.map((order):AnyRow=>{
      const items=purchaseItemsByOrder.get(order.id)??[];
      return {...order,items,visibleQty:items.reduce((sum,row)=>sum+Number(row.visibleQty||0),0),visibleSkuCount:items.length};
    }).filter((order)=>actor.role!=="运营"||order.items.length>0);

    const purchaseItemById=new Map<string,AnyRow>(purchaseItemRows.map((row)=>[row.id,row]));
    const productionItemById=new Map<string,AnyRow>(productionItemRows.map((row)=>[row.id,row]));
    const shippedByProductionItem=new Map<string,number>();
    for(const item of shipmentItemRows) shippedByProductionItem.set(item.production_order_item_id,(shippedByProductionItem.get(item.production_order_item_id)??0)+Number(item.shipped_qty||0));
    for(const item of transportItemRows) shippedByProductionItem.set(item.production_order_item_id,(shippedByProductionItem.get(item.production_order_item_id)??0)+Number(item.shipped_qty||0));
    const productionItemsByOrder=new Map<string,AnyRow[]>();
    for(const item of productionItemRows){
      const purchaseItem=purchaseItemById.get(item.purchase_order_item_id)??{};
      const allAllocations=parseJson<Array<{site:string;channel:string;qty:number}>>(purchaseItem.allocations_json,[]);
      const allocations=actor.role==="运营"?allAllocations.filter((row)=>row.site===actor.site&&row.channel===actor.channel):allAllocations;
      if(actor.role==="运营"&&!allocations.length) continue;
      const producedAllocations=prorateAllocations(allAllocations,Number(item.produced_qty||0));
      const visibleProduced=actor.role==="运营"?producedAllocations.filter((row)=>row.site===actor.site&&row.channel===actor.channel).reduce((sum,row)=>sum+row.qty,0):Number(item.produced_qty||0);
      const rows=productionItemsByOrder.get(item.production_order_id)??[];
      rows.push({...item,allocations,orderedQty:Number(purchaseItem.ordered_qty||item.planned_qty||0),visiblePlanned:actor.role==="运营"?allocations.reduce((sum,row)=>sum+Number(row.qty||0),0):Number(item.planned_qty||0),visibleProduced,shippedQty:shippedByProductionItem.get(item.id)??0,remainingToShip:Math.max(0,Number(item.produced_qty||0)-(shippedByProductionItem.get(item.id)??0))});
      productionItemsByOrder.set(item.production_order_id,rows);
    }
    const productionOrders:AnyRow[]=productionOrderRows.map((order):AnyRow=>{
      const items=productionItemsByOrder.get(order.id)??[];
      const producedVariance=Number(order.total_produced_qty||0)!==Number(order.total_planned_qty||0);
      return {...order,items,visiblePlannedQty:items.reduce((sum,row)=>sum+Number(row.visiblePlanned||0),0),visibleProducedQty:items.reduce((sum,row)=>sum+Number(row.visibleProduced||0),0),remainingToShip:items.reduce((sum,row)=>sum+Number(row.remainingToShip||0),0),producedVariance,evidence:parseJson(order.evidence_json,[])};
    }).filter((order)=>actor.role!=="运营"||order.items.length>0)
      .filter((order)=>actor.role!=="工厂"||order.assigned_user_id===actor.id)
      .sort((a,b)=>Number(b.producedVariance)-Number(a.producedVariance)||Date.parse(b.updated_at)-Date.parse(a.updated_at));

    const receiptItemsByBatchItem=new Map<string,AnyRow[]>();
    for(const item of shipmentReceiptItemRows){const rows=receiptItemsByBatchItem.get(item.batch_item_id)??[];rows.push({...item,allocations:parseJson(item.allocations_json,[])});receiptItemsByBatchItem.set(item.batch_item_id,rows);}
    const confirmationsByBatchItem=new Map<string,AnyRow[]>();
    for(const row of shelfConfirmationRows){const rows=confirmationsByBatchItem.get(row.batch_item_id)??[];rows.push(row);confirmationsByBatchItem.set(row.batch_item_id,rows);}
    const shipmentItemsByBatch=new Map<string,AnyRow[]>();
    for(const item of shipmentItemRows){
      const allAllocations=parseJson<Array<{site:string;channel:string;qty:number}>>(item.allocations_json,[]);
      const allocations=actor.role==="运营"?allAllocations.filter((row)=>row.site===actor.site&&row.channel===actor.channel):allAllocations;
      if(actor.role==="运营"&&!allocations.length) continue;
      const receiptItems=receiptItemsByBatchItem.get(item.id)??[];
      const visibleReceived=actor.role==="运营"?receiptItems.flatMap((row)=>row.allocations).filter((row:AnyRow)=>row.site===actor.site&&row.channel===actor.channel).reduce((sum:number,row:AnyRow)=>sum+Number(row.qty||0),0):Number(item.received_qty||0);
      const confirmations=(confirmationsByBatchItem.get(item.id)??[]).filter((row)=>actor.role!=="运营"||(row.site===actor.site&&row.channel===actor.channel));
      const productionItem=productionItemById.get(item.production_order_item_id)??{};
      const purchaseItem=purchaseItemById.get(productionItem.purchase_order_item_id)??{};
      const rows=shipmentItemsByBatch.get(item.batch_id)??[];
      rows.push({...item,allocations,confirmations,orderedQty:Number(purchaseItem.ordered_qty||productionItem.planned_qty||0),plannedQty:Number(productionItem.planned_qty||0),producedQty:Number(productionItem.produced_qty||0),visibleShipped:actor.role==="运营"?allocations.reduce((sum,row)=>sum+Number(row.qty||0),0):Number(item.shipped_qty||0),visibleReceived,visibleShelved:confirmations.reduce((sum,row)=>sum+Number(row.shelved_qty||0),0)});
      shipmentItemsByBatch.set(item.batch_id,rows);
    }
    const productionOrderById=new Map<string,AnyRow>(productionOrderRows.map((row)=>[row.id,row]));
    const shipmentBatches:AnyRow[]=shipmentRows.map((batch):AnyRow=>{
      const items=shipmentItemsByBatch.get(batch.id)??[];
      const evidence=parseJson<AnyRow[]>(batch.evidence_json,[]);
      const updatedAt=Date.parse(batch.updated_at),stageAgeDays=Number.isFinite(updatedAt)?Math.max(0,Math.floor((Date.now()-updatedAt)/86400_000)):0;
      const threshold=SHIPMENT_STALL_DAYS[batch.stage]??null;
      const exceptions:Array<{level:string;type:string;detail:string}>=[];
      if(threshold!==null&&stageAgeDays>threshold) exceptions.push({level:"red",type:"节点停滞",detail:`已${stageAgeDays}天未更新，请${batch.stage_owner}跟进`});
      const etaDays=daysFromToday(batch.estimated_arrival_date);
      if(["sea_freight","port_arrived","last_mile_delivery"].includes(batch.stage)&&!batch.estimated_arrival_date) exceptions.push({level:"amber",type:"缺少ETA",detail:"海运批次尚未维护预计到仓日期"});
      if(etaDays!==null&&etaDays<0&&!['shelf_pending','on_shelf'].includes(batch.stage)) exceptions.push({level:"red",type:"ETA逾期",detail:`预计到仓已逾期${Math.abs(etaDays)}天`});
      const receivedQty=items.reduce((sum,row)=>sum+Number(row.visibleReceived||0),0),shippedQty=items.reduce((sum,row)=>sum+Number(row.visibleShipped||0),0),shelvedQty=items.reduce((sum,row)=>sum+Number(row.visibleShelved||0),0);
      if(batch.stage==="awaiting_receipt"&&receivedQty>0&&receivedQty<shippedQty) exceptions.push({level:"amber",type:"部分到仓",detail:`仍有${shippedQty-receivedQty}件未到仓`});
      const productionOrder=productionOrderById.get(batch.production_order_id);
      if(productionOrder&&Number(productionOrder.total_produced_qty)!==Number(productionOrder.total_planned_qty)) exceptions.push({level:"amber",type:"生产差异",detail:`计划${productionOrder.total_planned_qty}件，完工${productionOrder.total_produced_qty}件`});
      const destinations=new Set(items.flatMap((row)=>row.allocations.map((allocation:AnyRow)=>`${allocation.site}|${allocation.channel}`)));
      const exceptionRank=exceptions.some((row)=>row.level==="red")?2:exceptions.length?1:0;
      const stageIndex=SHIPMENT_STAGE_ORDER.indexOf(batch.stage);
      return {...batch,items,evidence,exceptions,exceptionRank,stageAgeDays,stalled:exceptions.some((row)=>row.type==="节点停滞"),destinationCount:destinations.size,visibleShippedQty:shippedQty,visibleReceivedQty:receivedQty,visibleShelvedQty:shelvedQty,visibleSkuCount:items.length,stageProgress:batch.stage==="on_shelf"?1:Math.max(0,stageIndex)/(SHIPMENT_STAGE_ORDER.length-1)};
    }).filter((batch)=>actor.role!=="运营"||batch.items.length>0).sort((a,b)=>b.exceptionRank-a.exceptionRank||Number(b.stage!=="on_shelf")-Number(a.stage!=="on_shelf")||Date.parse(b.updated_at)-Date.parse(a.updated_at));
    const shipmentReceipts:AnyRow[]=shipmentReceiptRows.map((receipt):AnyRow=>({...receipt,items:shipmentReceiptItemRows.filter((item)=>item.receipt_id===receipt.id).map((item)=>({...item,allocations:scopedAllocations(item.allocations_json)})).filter((item)=>actor.role!=="运营"||item.allocations.length)})).filter((receipt)=>actor.role!=="运营"||receipt.items.length);

    const transportBatchItemById=new Map<string,AnyRow>(transportItemRows.map((row)=>[row.id,row]));
    const transportLegItemsByLeg=new Map<string,AnyRow[]>();
    for(const item of transportLegItemRows){
      const source=transportBatchItemById.get(item.batch_item_id)??{};
      const rows=transportLegItemsByLeg.get(item.leg_id)??[];
      rows.push({...item,name:source.name||"",seriesName:source.series_name||"",productionOrderId:source.production_order_id||"",shelfConfirmations:transportShelfRows.filter((row)=>row.leg_item_id===item.id)});
      transportLegItemsByLeg.set(item.leg_id,rows);
    }
    const roleVisibleTransportLegs=transportLegRows.filter((leg)=>{
      if(actor.role==="运营") return leg.site===actor.site&&leg.channel===actor.channel;
      if(actor.role==="海运") return leg.assigned_user_id===actor.id;
      return true;
    });
    const transportLegViews:AnyRow[]=roleVisibleTransportLegs.map((leg):AnyRow=>{
      const items=transportLegItemsByLeg.get(leg.id)??[];
      const stageIndex=TRANSPORT_STAGE_ORDER.indexOf(leg.stage);
      const age=Math.max(0,Math.floor((Date.now()-Date.parse(leg.updated_at))/86400_000));
      const threshold=TRANSPORT_STALL_DAYS[leg.stage]??null;
      const etaDays=daysFromToday(leg.eta);
      const pendingShelf=items.reduce((sum,row)=>sum+Number(row.pending_shelf_qty||0),0);
      const quarantine=items.reduce((sum,row)=>sum+Number(row.quarantine_qty||0),0);
      const received=items.reduce((sum,row)=>sum+Number(row.received_qty||0),0);
      const sellable=items.reduce((sum,row)=>sum+Number(row.sellable_qty||0),0);
      const exceptions:Array<{level:string;type:string;detail:string}>=[];
      if(threshold!==null&&age>threshold) exceptions.push({level:"red",type:"节点停滞",detail:`已${age}天未更新，请${leg.stage_owner}跟进`});
      if(["sea_freight","port_arrived","customs_clearance","last_mile_delivery"].includes(leg.stage)&&!leg.eta) exceptions.push({level:"amber",type:"缺少ETA",detail:"目的地运输分批尚未维护ETA"});
      if(etaDays!==null&&etaDays<0&&!['shelf_pending','on_shelf'].includes(leg.stage)) exceptions.push({level:"red",type:"ETA逾期",detail:`预计到仓已逾期${Math.abs(etaDays)}天`});
      if(quarantine>0) exceptions.push({level:"amber",type:"隔离库存",detail:`${quarantine}件待质检或报损处理`});
      return {...leg,items,evidence:parseJson(leg.evidence_json,[]),stageAgeDays:age,exceptions,pendingShelfQty:pendingShelf,quarantineQty:quarantine,receivedQty:received,sellableQty:sellable,progress:leg.stage==="on_shelf"?1:Math.max(0,stageIndex)/(TRANSPORT_STAGE_ORDER.length-1)};
    });
    const transportLegsByBatch=new Map<string,AnyRow[]>();
    for(const leg of transportLegViews){const rows=transportLegsByBatch.get(leg.batch_id)??[];rows.push(leg);transportLegsByBatch.set(leg.batch_id,rows);}
    const transportBatches:AnyRow[]=transportRows.map((batch):AnyRow=>{
      const legs=transportLegsByBatch.get(batch.id)??[];
      const batchItems=transportItemRows.filter((item)=>item.batch_id===batch.id);
      const visibleSkuIds=new Set(legs.flatMap((leg)=>leg.items.map((item:AnyRow)=>item.batch_item_id)));
      const visibleItems=batchItems.filter((item)=>actor.role!=="运营"&&actor.role!=="海运"||visibleSkuIds.has(item.id));
      const exceptions=legs.flatMap((leg)=>leg.exceptions.map((issue:AnyRow)=>({...issue,legNo:leg.leg_no,site:leg.site,channel:leg.channel})));
      return {...batch,legs,items:visibleItems,exceptions,visibleLegCount:legs.length,visibleSkuCount:new Set(visibleItems.map((item)=>item.sku)).size,visibleQty:legs.reduce((sum,leg)=>sum+Number(leg.total_qty||0),0)};
    }).filter((batch)=>actor.role!=="运营"&&actor.role!=="海运"||batch.legs.length>0)
      .sort((a,b)=>Number(b.exceptions.some((row:AnyRow)=>row.level==="red"))-Number(a.exceptions.some((row:AnyRow)=>row.level==="red"))||Date.parse(b.updated_at)-Date.parse(a.updated_at));
    const transportReceipts=transportReceiptRows.map((receipt)=>({...receipt,items:transportReceiptItemRows.filter((item)=>item.receipt_id===receipt.id)}));

    const newProductRecords=new Map<string,AnyRow[]>();
    for(const record of newProductStageRows){
      const rows=newProductRecords.get(record.project_id)??[];
      rows.push({...record,data:parseJson(record.data_json,{})});
      newProductRecords.set(record.project_id,rows);
    }
    const batchesById=new Map<string,AnyRow>(batches.map((batch)=>[batch.id,batch]));
    const productionOrdersById=new Map<string,AnyRow>(productionOrders.map((order)=>[order.id,order]));
    const newProductProjects:AnyRow[]=newProductRows.map((project)=>{
      const records=newProductRecords.get(project.id)??[];
      const researchCount=records.filter((record)=>record.stage_key==="research").length;
      const seedingCount=records.filter((record)=>record.stage_key==="seeding").length;
      const productionBatch=project.production_batch_id?batchesById.get(project.production_batch_id):null;
      const productionOrder=project.production_batch_id?productionOrdersById.get(project.production_batch_id):null;
      const stageStarted=Date.parse(project.stage_started_at);
      const researchDueAt=project.stage==="parallel_test"&&Number.isFinite(stageStarted)?new Date(stageStarted+3*86400_000).toISOString():null;
      const researchOverdue=Boolean(researchDueAt&&researchCount<REQUIRED_MONTHLY_SCOPES.length&&Date.parse(researchDueAt)<Date.now());
      return {
        ...project,records,researchCount,seedingCount,researchDueAt,researchOverdue,
        decisionHistory:parseJson(project.decision_history_json,[]),
        overdue:project.status==="active"&&project.stage!=="abandoned"&&(Date.parse(project.current_due_at)<Date.now()||researchOverdue),
        productionBatch:productionBatch?{...productionBatch,allocations:parseJson(productionBatch.allocations_json,[])}:null,
        productionOrder:productionOrder??null,
      } as AnyRow;
    });

    const {suggestions,salesDaily,policies}=await loadForecast(database(),actor);

    const currentMonth = monthKey();
    const submittedSet = new Set(submissionScopeRows.filter((r) => r.month === currentMonth).map((r) => `${r.site}|${r.channel}`));
    const monthlyStatus = REQUIRED_MONTHLY_SCOPES.map((r) => ({ ...r, submitted:submittedSet.has(`${r.site}|${r.channel}`) }));
    const negativeInventory = inventory.filter((r) => Number(r.qty) < 0);
    const reservationIssues=inventory.filter(r=>Number(r.qty)<Number(r.reserved_qty||0)).map(r=>({level:"critical",type:"预留库存不足",detail:`${r.site} · ${r.channel} · ${r.sku}：账面${r.qty}件，已预留${r.reserved_qty}件，线下发货将被阻止`}));
    const supplyIssues:AnyRow[]=suggestions.filter((row)=>["critical","data","eta"].includes(String(row.alertLevel))).map((row)=>({
      level:row.alertLevel,type:row.alertLabel,
      detail:`${row.site} · ${row.channel} · ${row.sku}：${row.alertReason}`,
    }));
    supplyIssues.unshift(...reservationIssues);
    if(actor.role==="管理员")supplyIssues.unshift(...(await systemChecks(database())).issues);
    const currentMonthNewProducts=newProductProjects.filter((project)=>project.cycle_month===currentMonth);
    if(Number(chinaDate().slice(8,10))>=7&&currentMonthNewProducts.length===0) supplyIssues.unshift({level:"eta",type:"本月新品测试未发起",detail:`${currentMonth} 已到每月7号新品测试节点，请管理员发起候选款测试`});
    for(const project of newProductProjects.filter((row)=>row.overdue)) supplyIssues.unshift({level:"eta",type:"新品阶段逾期",detail:`${project.sku} · ${NEW_PRODUCT_STAGE_LABEL[project.stage]||project.stage} 已超过截止时间`});
    for(const batch of shipmentBatches.filter((row)=>row.exceptions.length)) for(const issue of batch.exceptions) supplyIssues.unshift({level:issue.level==="red"?"critical":"eta",type:`${batch.batch_no} · ${issue.type}`,detail:`${batch.series_name}：${issue.detail}`});
    for(const batch of transportBatches) for(const leg of batch.legs) for(const issue of leg.exceptions) supplyIssues.unshift({level:issue.level==="red"?"critical":"eta",type:`${leg.leg_no} · ${issue.type}`,detail:`${leg.site} · ${leg.channel}：${issue.detail}`});
    for(const order of productionOrders.filter((row)=>row.producedVariance&&["completed","completed_with_variance"].includes(row.status))) supplyIssues.unshift({level:"eta",type:"系列生产数量差异",detail:`${order.series_name}：计划${order.total_planned_qty}件，实际完工${order.total_produced_qty}件`});
    for(const batch of visibleBatches.filter((row)=>row.stalled)) supplyIssues.unshift({level:"eta",type:"全链路节点停滞",detail:`${batch.sku} · ${BATCH_STAGE_LABEL[batch.stage]||batch.stage} 已${batch.stageAgeDays}天未更新，请${batch.stage_owner}跟进`});
    const batchStageCounts=visibleBatches.reduce((counts:Record<string,number>,batch)=>{counts[batch.stage]=(counts[batch.stage]??0)+1;return counts;},{});
    for(const batch of shipmentBatches) batchStageCounts[batch.stage]=(batchStageCounts[batch.stage]??0)+1;
    for(const leg of transportLegViews) batchStageCounts[leg.stage]=(batchStageCounts[leg.stage]??0)+1;
    batchStageCounts.supply_confirm=(batchStageCounts.supply_confirm??0)+purchaseOrders.filter((row)=>["draft","supplier_confirmed"].includes(row.status)).length;
    batchStageCounts.factory_production=(batchStageCounts.factory_production??0)+productionOrders.filter((row)=>!["cancelled","completed","completed_with_variance"].includes(row.status)).length;
    const activeShipments=shipmentBatches.filter((row)=>row.stage!=="on_shelf");
    const activeTransportBatches=transportBatches.filter((row)=>row.status!=="completed");
    const activeLegacyBatches=visibleBatches.filter((row)=>!["arrived","completed","on_shelf"].includes(row.stage));
    const offlineSales=await wholesaleSalesSummary(database(),actor,cutoff7,today);
    salesTopSkus.push(...offlineSales.topSkus);salesTopSkus.sort((a,b)=>Number(b.qty)-Number(a.qty));
    const metrics = {
      inventoryQty:inventory.reduce((sum,r) => sum + Number(r.qty)-Number(r.reserved_qty||0), 0),
      pendingShelfQty:inventory.reduce((sum,r)=>sum+Number(r.pending_shelf_qty||0),0),
      reservedQty:inventory.reduce((sum,r)=>sum+Number(r.reserved_qty||0),0),
      quarantineQty:inventory.reduce((sum,r)=>sum+Number(r.quarantine_qty||0),0),
      negativeSkuCount:negativeInventory.length,
      salesToday:salesScopeStatus.reduce((sum,r) => sum + Number(r.salesToday), 0)+offlineSales.todayQty,
      sales7Qty:salesDaily.filter(r=>r.business_date>=cutoff7&&r.business_date<=today).reduce((sum,r)=>sum+Number(r.qty),0)+offlineSales.periodQty,
      offlineSales7Qty:offlineSales.periodQty,
      seaTransitQty:suggestions.reduce((sum,row)=>sum+Number(row.seaInTransit),0),
      productionInProgressQty:suggestions.reduce((sum,row)=>sum+Number(row.productionInProgress),0),
      suggestedProductionQty:suggestions.reduce((sum,row)=>sum+Number(row.suggestedProduction),0),
      criticalAlertCount:suggestions.filter((row)=>row.alertLevel==="critical").length,
      actionAlertCount:suggestions.filter((row)=>["critical","warning","eta"].includes(String(row.alertLevel))).length+shipmentBatches.filter((row)=>row.exceptions.length).length+transportBatches.reduce((sum,row)=>sum+row.exceptions.length,0),
      dataGapCount:suggestions.filter((row)=>row.alertLevel==="data").length,
      activeNewProductCount:newProductProjects.filter((row)=>row.status==="active").length,
      currentMonthNewProductCount:currentMonthNewProducts.length,
      overdueNewProductCount:newProductProjects.filter((row)=>row.overdue).length,
      activeBatchCount:activeTransportBatches.length+activeShipments.length+activeLegacyBatches.length,
      activeTransportBatchCount:activeTransportBatches.length,
      transportBatchCount:transportBatches.length,
      transportLegCount:transportLegViews.length,
      transportExceptionCount:transportBatches.reduce((sum,row)=>sum+row.exceptions.length,0),
      activeShipmentCount:activeShipments.length,
      shipmentBatchCount:shipmentBatches.length,
      exceptionBatchCount:shipmentBatches.filter((row)=>row.exceptions.length).length,
      seriesOrderCount:purchaseOrders.length,
      activeProductionOrderCount:productionOrders.filter((row)=>!["cancelled","completed","completed_with_variance"].includes(row.status)).length,
      readyToShipProductionOrderCount:productionOrders.filter((row)=>["completed","completed_with_variance"].includes(row.status)&&row.qc_status==="passed"&&row.remainingToShip>0).length,
      stalledBatchCount:visibleBatches.filter((row)=>row.stalled).length+shipmentBatches.filter((row)=>row.stalled).length,
      pendingShelfCount:visibleBatches.filter((row)=>row.stage==="shelf_pending").length+shipmentBatches.filter((row)=>row.stage==="shelf_pending").length,
      salesScopesUpdatedToday:salesScopeStatus.filter((row)=>row.updatedToday).length,
      salesScopesRequired:salesScopeStatus.length,
      batchStageCounts,
      pendingApprovals:approvals.filter((r) => r.status === "pending").length,
      monthlySubmitted:monthlyStatus.filter((r) => r.submitted).length,
      monthlyRequired:monthlyStatus.length,
    };

    const warehouseCapacityIssues:AnyRow[]=[];
    for(const warehouse of warehouses.filter((row)=>Number(row.active)===1&&Number(row.capacity_qty)>0)){
      const used=inventory.filter((row)=>row.site===warehouse.site&&row.channel===warehouse.channel).reduce((sum,row)=>sum+Number(row.qty||0)+Number(row.pending_shelf_qty||0)+Number(row.quarantine_qty||0),0);
      if(used>Number(warehouse.capacity_qty)) warehouseCapacityIssues.push({level:"eta",type:"仓库容量超限",detail:`${warehouse.name}：当前${used}件，容量${warehouse.capacity_qty}件`});
    }
    supplyIssues.unshift(...warehouseCapacityIssues);
    const myTasks:AnyRow[]=await wholesaleTasks(database(),actor);
    if(actor.role==="运营"){
      const ownStatus=salesScopeStatus[0];
      if(ownStatus&&!ownStatus.updatedToday) myTasks.push({level:"red",title:"导入今日销售",detail:`${actor.site} · ${actor.channel} 今日尚未更新`,tab:"sales"});
      const ownMonthly=monthlyStatus.find((row)=>row.site===actor.site&&row.channel===actor.channel);
      if(ownMonthly&&!ownMonthly.submitted) myTasks.push({level:"amber",title:"提交月度需求",detail:`${currentMonth} 需求尚未提交`,tab:"suggestions"});
      for(const leg of transportLegViews.filter((row)=>row.stage==="shelf_pending"&&row.pendingShelfQty>0)) myTasks.push({level:"amber",title:"确认上架",detail:`${leg.leg_no} · ${leg.pendingShelfQty}件待转可售`,tab:"batches"});
    }
    if(["供应链","管理员"].includes(actor.role)){
      for(const request of countRequests.filter((row)=>row.status==="pending")) myTasks.push({level:"amber",title:"复核盘点差异",detail:`${request.site} · ${request.channel} · ${request.sku}`,tab:"inventory"});
      for(const order of purchaseOrders.filter((row)=>["draft","ordered"].includes(row.status)&&!row.supplier_confirmed_at&&(actor.role==="管理员"||row.assigned_supply_user_id===actor.id))) myTasks.push({level:"amber",title:"确认供应商接单",detail:`${order.series_name} · ${order.total_qty}件`,tab:"fulfillment"});
      for(const order of productionOrders.filter((row)=>["completed","completed_with_variance"].includes(row.status)&&row.qc_status!=="passed")) myTasks.push({level:"red",title:"确认生产质检",detail:`${order.series_name} 已完工待质检`,tab:"fulfillment"});
      for(const leg of transportLegViews.filter((row)=>["booking","awaiting_receipt"].includes(row.stage))) myTasks.push({level:"amber",title:leg.stage==="booking"?"完成订舱交接":"登记目的地到仓",detail:`${leg.leg_no} · ${leg.site} · ${leg.channel}`,tab:"batches"});
    }
    if(actor.role==="工厂") for(const order of productionOrders.filter((row)=>["awaiting_factory","in_production","pending"].includes(row.status))) myTasks.push({level:order.promised_completion_date&&String(order.promised_completion_date)<today?"red":"amber",title:order.status==="in_production"?"更新生产进度":"确认生产接单",detail:`${order.series_name} · ${order.total_planned_qty}件`,tab:"fulfillment"});
    if(actor.role==="海运") for(const leg of transportLegViews.filter((row)=>row.stage_owner==="海运"&&row.stage!=="on_shelf")) myTasks.push({level:leg.exceptions.some((item:AnyRow)=>item.level==="red")?"red":"amber",title:"更新运输节点",detail:`${leg.leg_no} · ${leg.site} · ${leg.channel}`,tab:"batches"});
    if(actor.role==="管理员") for(const approval of approvals.filter((row)=>row.status==="pending")) myTasks.push({level:"red",title:"审批月度备货",detail:`${approval.month} 计划待审批`,tab:"approval"});

    const visibleNewProductProjects=canReadDomain(actor.role,"new_product")?newProductProjects.map((project)=>({
      ...project,
      records:project.records.map((record:AnyRow)=>record.stage_key==="finance"&&!canReadDomain(actor.role,"finance_detail")?{...record,data:{submitted:true},conclusion:"财务测算已提交"}:record),
    })):[];
    return Response.json(publicSystemSnapshot({
      actor, currentMonth, metrics, myTasks,
      inventory:canReadDomain(actor.role,"inventory")?inventory:[],
      movements:canReadDomain(actor.role,"inventory")?movements:[],
      sales:canReadDomain(actor.role,"sales")?sales:[],
      imports:canReadDomain(actor.role,"sales")?imports:[],
      receipts:canReadDomain(actor.role,"inventory")?receipts:[],
      supplyPolicies:canReadDomain(actor.role,"planning")?policies:[],
      forecastHistory:canReadDomain(actor.role,"planning")?await all(`SELECT f.*,COALESCE((SELECT SUM(s.qty) FROM sales_records s WHERE s.sku=f.sku AND s.site=f.site AND s.channel=f.channel AND substr(s.business_date,1,7)=f.month AND s.reversed_at IS NULL),0)-COALESCE((SELECT SUM(c.return_qty) FROM sales_demand_corrections c WHERE c.sku=f.sku AND c.site=f.site AND c.channel=f.channel AND substr(c.business_date,1,7)=f.month),0) actual_sales FROM forecast_snapshots f${actor.role==="运营"?" WHERE f.site=? AND f.channel=?":""} ORDER BY month DESC`,actor.role==="运营"?[actor.site,actor.channel]:[]):[],
      planChanges: ["管理员","供应链"].includes(actor.role)?(await all("SELECT * FROM plan_changes ORDER BY created_at DESC")).map(r=>({...r,old:parseJson(r.old_json,{}),next:parseJson(r.new_json,{})})):[],
      submissions:canReadDomain(actor.role,"planning")?submissions.map((r) => ({ ...r, items:parseJson(r.items_json, []) })):[],
      approvals:canReadDomain(actor.role,"planning")?approvals.map((r) => ({ ...r, payload:parseJson(r.payload_json, {}) })):[],
      batches:canReadDomain(actor.role,"transport")?visibleBatches:[],
      purchaseOrders:canReadDomain(actor.role,"fulfillment")?(actor.role==="工厂"?purchaseOrders.filter((order)=>productionOrders.some((production)=>production.purchase_order_id===order.id)):purchaseOrders):[],
      productionOrders:canReadDomain(actor.role,"fulfillment")?productionOrders:[],
      shipmentBatches:canReadDomain(actor.role,"transport")?shipmentBatches:[],
      shipmentReceipts:canReadDomain(actor.role,"transport")?shipmentReceipts:[],
      transportBatches:canReadDomain(actor.role,"transport")?transportBatches:[],
      transportReceipts:canReadDomain(actor.role,"transport")?transportReceipts:[],
      businessPartners,warehouses,countRequests,
      skuSettings:canReadDomain(actor.role,"inventory")||canReadDomain(actor.role,"fulfillment")||canReadDomain(actor.role,"master")?skuSettings:[],
      audit:canReadDomain(actor.role,"audit")?auditRows.map((r) => ({ ...r, detail:parseJson(r.detail_json, {}) })):[],
      users:canReadDomain(actor.role,"users")||canReadDomain(actor.role,"master")?users:[],
      suggestions:canReadDomain(actor.role,"inventory")?suggestions:[],
      monthlyStatus:canReadDomain(actor.role,"planning")?monthlyStatus:[],
      newProductProjects:visibleNewProductProjects,
      salesScopeStatus:canReadDomain(actor.role,"sales")?salesScopeStatus:[],
      salesTopSkus:canReadDomain(actor.role,"sales")?salesTopSkus:[],
      issues:supplyIssues,
    }));
  } catch (error) { return errorResponse(error); }
}

export async function POST(request:Request) {
  try {
    const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new HttpError(403,"请求来源无效");
    await ensureSchema();
    const actor = await requireActor(request);
    const payload = await body(request);
    const action = cleanText(payload.action, 40);
    await assertWritable(database());
    if (action === "bulkImport") return await bulkImport(actor,payload);
    if (action === "confirmSalesDay") return await confirmSalesDay(actor,payload);
    if (action === "salesImport") return await salesImport(actor, payload);
    if (action === "reverseSalesImport") return await reverseSalesImport(actor,payload);
    if (action === "inventoryAdjust") return await inventoryAdjust(actor, payload);
    if (action === "submitInventoryCount") return await submitInventoryCount(actor,payload);
    if (action === "decideInventoryCount") return await decideInventoryCount(actor,payload);
    if (action === "resolveInventoryHold") return await resolveInventoryHold(actor,payload);
    if (action === "receiveInbound") return await receiveInbound(actor, payload);
    if (["supplyPolicySave","demandCorrectionSave"].includes(action)) return Response.json(await saveForecastData(database(),actor,payload));
    if (PLAN_ACTIONS.has(action)) return Response.json(await managePlan(database(),actor,payload,{buildSeriesOrders}));
    if (action === "monthlySubmit") return await monthlySubmit(actor, payload);
    if (action === "submitPlan") return await submitPlan(actor, payload);
    if (action === "decideApproval") return await decideApproval(actor, payload);
    if (action === "confirmPurchaseOrder") return await confirmPurchaseOrder(actor,payload);
    if (action === "acceptProductionOrder") return await acceptProductionOrder(actor,payload);
    if (action === "updateProductionProgress") return await updateProductionProgress(actor,payload);
    if (action === "completeProductionOrder") return await completeProductionOrder(actor,payload);
    if (action === "confirmProductionQc") return await confirmProductionQc(actor,payload);
    if (action === "createShipmentBatch") return await createShipmentBatch(actor,payload);
    if (action === "advanceShipmentBatch") return await advanceShipmentBatch(actor,payload);
    if (action === "updateShipmentEta") return await updateShipmentEta(actor,payload);
    if (action === "receiveShipmentBatch") return await receiveShipmentBatch(actor,payload);
    if (action === "confirmShipmentShelf") return await confirmShipmentShelf(actor,payload);
    if (action === "createTransportBatch") return await createTransportBatch(actor,payload);
    if (action === "advanceTransportLeg") return await advanceTransportLeg(actor,payload);
    if (action === "updateTransportLegPlan") return await updateTransportLegPlan(actor,payload);
    if (action === "receiveTransportLeg") return await receiveTransportLeg(actor,payload);
    if (action === "confirmTransportShelf") return await confirmTransportShelf(actor,payload);
    if (action === "advanceBatch") return await advanceBatch(actor, payload);
    if (action === "updateBatchEta") return await updateBatchEta(actor, payload);
    if (action === "confirmBatchShelf") return await confirmBatchShelf(actor, payload);
    if (action === "startNewProductTest") return await startNewProductTest(actor, payload);
    if (action === "submitNewProductStage") return await submitNewProductStage(actor, payload);
    if (action === "decideNewProduct") return await decideNewProduct(actor, payload);
    if (action === "assignUser") return await assignUser(actor, payload);
    if (action === "saveSkuSetting") return await saveSkuSetting(actor, payload);
    if (action === "saveBusinessPartner") return await saveBusinessPartner(actor,payload);
    if (action === "saveWarehouse") return await saveWarehouse(actor,payload);
    throw new HttpError(400, "未知操作");
  } catch (error) { return errorResponse(error); }
}

async function bulkImport(actor:Actor,payload:AnyRow){
  const kind=String(payload.kind||"");
  if(!["inventory","inbound"].includes(kind))throw new HttpError(400,"不支持的批量导入类型");
  requireBusinessPermission(actor,kind==="inbound"?"inbound.receive":actor.role==="管理员"?"inventory.adjust":"inventory.count.submit");
  let rows:AnyRow[];
  try{const parsed=validateImportRows(kind,payload.rows);if(parsed.errors.length)throw Error(parsed.errors.map((e:{row:number;message:string})=>`第${e.row}行：${e.message}`).join("；"));rows=parsed.rows;}catch(error){throw new HttpError(400,error instanceof Error?error.message:"导入明细无效");}
  const fileName=cleanText(payload.fileName,180),fileHash=cleanText(payload.fileHash,64);
  if(!/^[a-f0-9]{64}$/.test(fileHash))throw new HttpError(400,"文件校验码无效，请重新选择文件");
  const canonical=JSON.stringify(rows.map(({_row,...row})=>row).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(canonical));
  const key=`data_import:${kind}:${Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("")}`,db=database();
  if(await db.prepare("SELECT id FROM system_operations WHERE id=?").bind(key).first())throw new HttpError(409,"这份数据已经导入，系统已阻止重复写入；新盘点请填写新的调整原因");
  let entries=rows;
  if(kind==="inbound"){try{entries=groupInboundRows(rows);}catch(error){throw new HttpError(400,error instanceof Error?error.message:"到仓单分组无效");}}
  const statements:D1PreparedStatement[]=[guardStatement(db,actor,"批量文件导入","1=1",[],key,{kind,fileName,fileHash,rows:rows.length})];
  let imported=0,skipped=0;
  for(const entry of entries){
    try{const result=await (kind==="inbound"?receiveInbound(actor,entry,statements):actor.role==="管理员"?inventoryAdjust(actor,entry,statements):submitInventoryCount(actor,entry,statements));const detail=await result.json();if(detail.skipped)skipped++;else imported++;}
    catch(error){if(error instanceof HttpError)throw new HttpError(error.status,`第${entry._row}行：${error.message}。整份文件未写入`);throw error;}
  }
  if(statements.length>950)throw new HttpError(400,"本次涉及的渠道分配过多，请拆分文件后重试；整份文件未写入");
  statements.push(audit(actor,"批量文件导入","data_import",key,{kind,fileName,fileHash,rows:rows.length,imported,skipped}));
  try{await atomicBatch(db,statements);}catch(error){if(/UNIQUE/.test(String(error)))throw new HttpError(409,"文件、单号或盘点记录已存在，本次整批未写入");throw error;}
  return Response.json({ok:true,imported,skipped,rows:rows.length});
}

async function confirmSalesDay(actor:Actor,payload:AnyRow){
  requireBusinessPermission(actor,"sales.import");
  const site=cleanText(payload.site,20),channel=cleanText(payload.channel,20),date=cleanText(payload.businessDate,10);
  validSiteChannel(site,channel);requireScope(actor,site,channel);
  if(channel==="线下分销"||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date||date>chinaDate()||date<chinaDate(-90))throw new HttpError(400,"请选择近90天内有效的线上销售日期");
  if(payload.confirmed!==true)throw new HttpError(400,"请确认已核对该日全部销售，包括零销售情况");
  const note=cleanText(payload.note,240);if(note.length<4)throw new HttpError(400,"请填写日报核对依据，至少4个字符");
  const db=database(),idsSql="SELECT id FROM sales_imports WHERE site=? AND channel=? AND business_date=? AND total_qty>0 AND reversed_at IS NULL ORDER BY id";
  const rows=await all(idsSql,[site,channel,date]),fingerprint=rows.map(r=>r.id).join('|');
  const key=`coverage|${site}|${channel}|${date}`,timestamp=nowIso(),id=makeId('sale_day');
  await db.batch([
    guardStatement(db,actor,"销售日报完整度确认",`COALESCE((SELECT GROUP_CONCAT(id,'|') FROM (${idsSql})), '')=?`,[site,channel,date,fingerprint]),
    db.prepare("UPDATE sales_imports SET report_kind='partial' WHERE site=? AND channel=? AND business_date=? AND report_kind IN ('complete','zero') AND reversed_at IS NULL").bind(site,channel,date),
    db.prepare("INSERT INTO sales_imports(id,import_key,business_date,site,channel,file_name,source_batch_ref,row_count,total_qty,actor_id,created_at,report_kind) VALUES(?,?,?,?,?,?,?,0,0,?,?,?) ON CONFLICT(import_key) DO UPDATE SET report_kind=excluded.report_kind,reversed_at=NULL,reversed_by=NULL,reversal_reason='',actor_id=excluded.actor_id,created_at=excluded.created_at,file_name=excluded.file_name").bind(id,key,date,site,channel,note,'日报核对',actor.id,timestamp,rows.length?'complete':'zero'),
    audit(actor,"确认销售日报完整","sales_day",key,{date,site,channel,note,sourceImportIds:rows.map(r=>r.id),zero:!rows.length}),
  ]);
  return Response.json({ok:true,zero:!rows.length});
}

async function salesImport(actor:Actor, payload:AnyRow) {
  requireBusinessPermission(actor,"sales.import");
  const site = cleanText(payload.site, 20), channel = cleanText(payload.channel, 20);
  validSiteChannel(site, channel); requireScope(actor, site, channel);
  if(site==="印尼"&&channel==="线下分销") throw new HttpError(409,"印尼线下销售请通过线下批发订单发货生成，禁止再次导入扣库");
  const businessDate = cleanText(payload.businessDate, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)||!Number.isFinite(Date.parse(businessDate))||new Date(businessDate).toISOString().slice(0,10)!==businessDate) throw new HttpError(400, "销售日期无效");
  if(businessDate>chinaDate()||businessDate<chinaDate(-90)) throw new HttpError(400,"销售日期只能选择今天或近90天内日期");
  const rows = normalizedSales(payload.rows,payload.currency||SITE_CURRENCIES[site as keyof typeof SITE_CURRENCIES]);
  const importKey = cleanText(payload.importKey, 160);
  const sourceBatchRef=cleanText(payload.sourceBatchRef,100).toUpperCase();
  if(sourceBatchRef.length<3) throw new HttpError(400,"请填写平台订单批次、日报编号或唯一手工凭证号");
  if (importKey.length < 12) throw new HttpError(400, "缺少有效的导入唯一标识");
  const db = database();
  const exists = await db.prepare("SELECT id FROM sales_imports WHERE import_key=?").bind(importKey).first();
  if (exists) throw new HttpError(409, "该文件或记录已经导入，系统已阻止重复扣库存");
  if(await db.prepare("SELECT id FROM sales_imports WHERE site=? AND channel=? AND business_date=? AND source_batch_ref=? AND reversed_at IS NULL").bind(site,channel,businessDate,sourceBatchRef).first()) throw new HttpError(409,"该平台批次或手工凭证号已经导入，系统已阻止重复扣库存");
  const importId = makeId("sale_import"), timestamp = nowIso();
  const totalQty = rows.reduce((sum,r) => sum + r.qty, 0);
  const reportKind=totalQty===0?"cost":payload.reportKind==="complete"?"complete":"partial";
  if(payload.reportKind==="cost"&&totalQty>0)throw new HttpError(400,"费用补录只能包含销量为0的费用行");
  if(payload.reportKind==="complete"&&totalQty===0)throw new HttpError(400,"费用文件不能作为完整销售日报；零销售日请使用确认入口");
  const settings = await all("SELECT sku,unit_price,name FROM sku_settings");
  const settingMap = new Map<string, AnyRow>(settings.map((r:AnyRow) => [r.sku, r]));
  const statements = [
    ...(totalQty>0?[db.prepare("UPDATE sales_imports SET report_kind='partial' WHERE site=? AND channel=? AND business_date=? AND report_kind IN ('complete','zero') AND reversed_at IS NULL").bind(site,channel,businessDate)]:[]),
    db.prepare("INSERT INTO sales_imports (id,import_key,business_date,site,channel,file_name,source_batch_ref,row_count,total_qty,actor_id,created_at,report_kind) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(importId, importKey, businessDate, site, channel, cleanText(payload.fileName, 180),sourceBatchRef, new Set(rows.map(row=>row.sku)).size, totalQty, actor.id, timestamp,reportKind),
  ];
  if(reportKind==="complete")statements.unshift(guardStatement(db,actor,"完整销售日报校验","NOT EXISTS(SELECT 1 FROM sales_imports WHERE site=? AND channel=? AND business_date=? AND total_qty>0 AND reversed_at IS NULL)",[site,channel,businessDate]));
  rows.forEach((row) => {
    const setting = settingMap.get(row.sku);
    const name = row.name || cleanText(setting?.name, 120);
    const price = row.amount===null||!row.qty?0:row.amount/row.qty;
    const saleId = makeId("sale");
    statements.push(
      db.prepare("INSERT INTO sku_settings (sku,name,product_type,unit_price,lead_time_days,safety_pct,updated_at) VALUES (?,?,'老款',0,63,.25,?) ON CONFLICT(sku) DO UPDATE SET name=CASE WHEN excluded.name<>'' THEN excluded.name ELSE sku_settings.name END,updated_at=excluded.updated_at").bind(row.sku, name, timestamp),
      db.prepare("INSERT INTO sales_records (id,import_id,business_date,site,channel,sku,qty,unit_price,amount,source_ref,actor_id,created_at,currency,reported_amount,ad_cost) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(saleId, importId, businessDate, site, channel, row.sku, row.qty, price, row.amount??0, sourceBatchRef, actor.id, timestamp,row.currency,row.amount,row.adCost),
    );
    if(row.qty>0) statements.push(
      db.prepare("INSERT INTO inventory_balances (site,channel,sku,name,qty,updated_at) VALUES (?,?,?,?,-?,?) ON CONFLICT(site,channel,sku) DO UPDATE SET qty=inventory_balances.qty-?,name=CASE WHEN excluded.name<>'' THEN excluded.name ELSE inventory_balances.name END,updated_at=excluded.updated_at")
        .bind(site, channel, row.sku, name, row.qty, timestamp, row.qty),
      db.prepare("INSERT INTO inventory_movements (id,site,channel,sku,name,movement_type,qty_delta,balance_after,reference_type,reference_id,note,actor_id,created_at) SELECT ?,site,channel,sku,name,'销售出库',-?,qty,'销售导入',?,'销售统一扣库',?,? FROM inventory_balances WHERE site=? AND channel=? AND sku=?")
        .bind(makeId("move"), row.qty, importId, actor.id, timestamp, site, channel, row.sku),
    );
  });
  statements.push(audit(actor, "销售导入并扣库", "sales_import", importId, { businessDate, site, channel, rows:rows.length, totalQty, importKey,sourceBatchRef }));
  try { await db.batch(statements); } catch (error) {
    if (String(error).includes("UNIQUE")) throw new HttpError(409, "该文件或记录已经导入");
    throw error;
  }
  return Response.json({ ok:true, importId, rows:rows.length, totalQty });
}

async function reverseSalesImport(actor:Actor,payload:AnyRow){
  requireBusinessPermission(actor,"sales.reverse");
  const importId=cleanText(payload.importId,120),reason=cleanText(payload.reason,500);
  if(reason.length<5) throw new HttpError(400,"冲销必须填写至少5个字的原因");
  const db=database(),source=await db.prepare("SELECT * FROM sales_imports WHERE id=?").bind(importId).first<AnyRow>();
  if(!source) throw new HttpError(404,"销售导入批次不存在");
  if(source.reversed_at) throw new HttpError(409,"该销售导入批次已经冲销");
  const rows=await all("SELECT r.sku,COALESCE(s.name,'') name,r.qty FROM sales_records r LEFT JOIN sku_settings s ON s.sku=r.sku WHERE r.import_id=? AND r.reversed_at IS NULL",[importId]);
  if(!rows.length&&!String(source.import_key).startsWith("coverage|")) throw new HttpError(409,"该批次没有可冲销销售明细");
  const timestamp=nowIso(),statements=[...(Number(source.total_qty)>0?[db.prepare("UPDATE sales_imports SET report_kind='partial' WHERE site=? AND channel=? AND business_date=? AND report_kind IN ('complete','zero') AND reversed_at IS NULL").bind(source.site,source.channel,source.business_date)]:[]),guardStatement(db,actor,"销售冲销校验","EXISTS(SELECT 1 FROM sales_imports WHERE id=? AND reversed_at IS NULL)",[importId]),...reversalStatements(db,{source,records:rows.filter(row=>row.qty>0),reason,actorId:actor.id,timestamp})];
  statements.push(
    db.prepare("UPDATE sales_records SET reversed_at=? WHERE import_id=? AND reversed_at IS NULL").bind(timestamp,importId),
    db.prepare("UPDATE sales_imports SET reversed_at=?,reversed_by=?,reversal_reason=? WHERE id=? AND reversed_at IS NULL").bind(timestamp,actor.id,reason,importId),
    audit(actor,"冲销错误销售导入","sales_import",importId,{reason,totalQty:source.total_qty,site:source.site,channel:source.channel}),
  );
  await db.batch(statements);
  return Response.json({ok:true,importId,reversedQty:Number(source.total_qty||0)});
}

async function inventoryAdjust(actor:Actor, payload:AnyRow, staged?:D1PreparedStatement[]) {
  requireBusinessPermission(actor,"inventory.adjust");
  const site = cleanText(payload.site, 20), channel = cleanText(payload.channel, 20), sku = cleanSku(payload.sku);
  validSiteChannel(site, channel); requireScope(actor, site, channel);
  const countedQty = Number(payload.countedQty), reason = cleanText(payload.reason, 240);
  if (!sku || !Number.isSafeInteger(countedQty) || countedQty < 0) throw new HttpError(400, "盘点数量必须是非负整数");
  if (reason.length < 4) throw new HttpError(400, "请填写盘点调整原因");
  const db = database(), timestamp = nowIso();
  const current = await db.prepare("SELECT qty,name FROM inventory_balances WHERE site=? AND channel=? AND sku=?").bind(site,channel,sku).first<AnyRow>();
  const oldQty = Number(current?.qty ?? 0), delta = countedQty - oldQty;
  if (delta === 0 && staged) return Response.json({ok:true,skipped:true});
  if (delta === 0) throw new HttpError(400, "盘点数量与系统库存一致，无需调整");
  const ref = makeId("count");
  const statements=[
    db.prepare("INSERT INTO sku_settings(sku,name,updated_at) VALUES (?,?,?) ON CONFLICT(sku) DO NOTHING").bind(sku,cleanText(current?.name||payload.name,120),timestamp),
    ...countStatements(db,{site,channel,sku,name:cleanText(current?.name||payload.name,120),from:oldQty,to:countedQty,reference:ref,actorId:actor.id,reason,timestamp}),
    audit(actor, "库存盘点调整", "inventory", `${site}|${channel}|${sku}`, { oldQty, countedQty, delta, reason }),
  ];
  if(staged)staged.push(...statements);else await db.batch(statements);
  return Response.json({ ok:true, oldQty, countedQty, delta });
}

async function submitInventoryCount(actor:Actor,payload:AnyRow,staged?:D1PreparedStatement[]){
  requireBusinessPermission(actor,"inventory.count.submit");
  const site=cleanText(payload.site,20),channel=cleanText(payload.channel,20),sku=cleanSku(payload.sku),reason=cleanText(payload.reason,500),countedQty=Number(payload.countedQty);
  validSiteChannel(site,channel);requireScope(actor,site,channel);
  if(!sku||!Number.isSafeInteger(countedQty)||countedQty<0||reason.length<4) throw new HttpError(400,"请填写有效盘点实数和差异原因");
  const db=database(),current=await db.prepare("SELECT qty FROM inventory_balances WHERE site=? AND channel=? AND sku=?").bind(site,channel,sku).first<AnyRow>();
  const systemQty=Number(current?.qty??0);
  if(systemQty===countedQty&&staged)return Response.json({ok:true,skipped:true});
  if(systemQty===countedQty) throw new HttpError(400,"盘点数量与当前可售库存一致，无需提交");
  if(await db.prepare("SELECT id FROM inventory_count_requests WHERE site=? AND channel=? AND sku=? AND status='pending'").bind(site,channel,sku).first()) throw new HttpError(409,"该SKU已有待复核盘点差异");
  const idValue=makeId("count_request"),timestamp=nowIso();
  const statements=[
    guardStatement(db,actor,"盘点提交校验","NOT EXISTS(SELECT 1 FROM inventory_count_requests WHERE site=? AND channel=? AND sku=? AND status='pending') AND COALESCE((SELECT qty FROM inventory_balances WHERE site=? AND channel=? AND sku=?),0)=?",[site,channel,sku,site,channel,sku,systemQty]),
    db.prepare("INSERT INTO inventory_count_requests (id,site,channel,sku,system_qty,counted_qty,reason,status,decision_comment,creator_id,decided_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'pending','',?,NULL,?,?)").bind(idValue,site,channel,sku,systemQty,countedQty,reason,actor.id,timestamp,timestamp),
    audit(actor,"提交库存盘点差异","inventory_count",idValue,{site,channel,sku,systemQty,countedQty,reason}),
  ];
  if(staged)staged.push(...statements);else await db.batch(statements);
  return Response.json({ok:true,id:idValue,systemQty,countedQty});
}

async function decideInventoryCount(actor:Actor,payload:AnyRow){
  requireBusinessPermission(actor,"inventory.count.approve");
  const requestId=cleanText(payload.requestId,120),decision=cleanText(payload.decision,20),comment=cleanText(payload.comment,500);
  if(!["approve","reject"].includes(decision)||comment.length<3) throw new HttpError(400,"请选择复核结果并填写意见");
  const db=database(),request=await db.prepare("SELECT * FROM inventory_count_requests WHERE id=? AND status='pending'").bind(requestId).first<AnyRow>();
  if(!request) throw new HttpError(404,"待复核盘点差异不存在或已处理");
  const timestamp=nowIso();
  if(decision==="reject"){
    await db.batch([db.prepare("UPDATE inventory_count_requests SET status='rejected',decision_comment=?,decided_by=?,updated_at=? WHERE id=? AND status='pending'").bind(comment,actor.id,timestamp,requestId),audit(actor,"驳回库存盘点差异","inventory_count",requestId,{comment})]);
    return Response.json({ok:true,status:"rejected"});
  }
  const current=await db.prepare("SELECT qty,name FROM inventory_balances WHERE site=? AND channel=? AND sku=?").bind(request.site,request.channel,request.sku).first<AnyRow>();
  const currentQty=Number(current?.qty??0);
  if(currentQty!==Number(request.system_qty)) throw new HttpError(409,`提交后库存已从${request.system_qty}变为${currentQty}，请运营重新盘点，系统已阻止覆盖`);
  const delta=Number(request.counted_qty)-currentQty;
  await db.batch([
    ...countStatements(db,{site:request.site,channel:request.channel,sku:request.sku,name:cleanText(current?.name,120),from:currentQty,to:Number(request.counted_qty),reference:requestId,actorId:actor.id,reason:comment,timestamp,requestId}),
    db.prepare("UPDATE inventory_count_requests SET status='approved',decision_comment=?,decided_by=?,updated_at=? WHERE id=? AND status='pending'").bind(comment,actor.id,timestamp,requestId),
    audit(actor,"批准库存盘点差异","inventory_count",requestId,{from:currentQty,to:request.counted_qty,delta,comment}),
  ]);
  return Response.json({ok:true,status:"approved",delta});
}

async function resolveInventoryHold(actor:Actor,payload:AnyRow){
  requireBusinessPermission(actor,"inventory.hold.resolve");
  const site=cleanText(payload.site,20),channel=cleanText(payload.channel,20),sku=cleanSku(payload.sku);
  validSiteChannel(site,channel);
  return Response.json(await resolveInventoryHoldSources(database(),actor,{...payload,site,channel,sku}));
}

async function receiveInbound(actor:Actor, payload:AnyRow, staged?:D1PreparedStatement[]) {
  requireBusinessPermission(actor,"inbound.receive");
  const receiptNo = cleanText(payload.receiptNo, 80), sku = cleanSku(payload.sku), name = cleanText(payload.name,120);
  const proofRef = cleanText(payload.proofRef, 240), sourceBatch = cleanText(payload.sourceBatch,80);
  if (!receiptNo || !sku || !proofRef) throw new HttpError(400, "到仓单号、SKU和到仓凭证均为必填");
  if(!sourceBatch&&actor.role!=="管理员") throw new HttpError(403,"供应链到仓必须关联系统批次；只有管理员可处理历史或线下例外入库");
  const allocationMap = new Map<string,{site:string;channel:string;qty:number}>();
  for (const raw of Array.isArray(payload.allocations) ? payload.allocations : []) {
    const site = cleanText(raw.site,20), channel = cleanText(raw.channel,20), qty = Number(raw.qty);
    validSiteChannel(site,channel);
    if (!Number.isSafeInteger(qty) || qty <= 0) throw new HttpError(400, "渠道分配数量必须是正整数");
    const key = `${site}|${channel}`, previous = allocationMap.get(key);
    allocationMap.set(key, { site, channel, qty:(previous?.qty ?? 0) + qty });
  }
  const allocations = [...allocationMap.values()];
  const totalQty = allocations.reduce((sum,r) => sum + r.qty,0);
  if (!allocations.length || !allocationMatchesTotal(Number(payload.totalQty), allocations)) throw new HttpError(400, "站点＋渠道分配合计必须等于实收到仓总数");
  const db = database();
  if (await db.prepare("SELECT id FROM inbound_receipts WHERE receipt_no=?").bind(receiptNo).first()) throw new HttpError(409, "该到仓单号已经入库，系统已阻止重复入库");
  const receiptId = makeId("receipt"), timestamp = nowIso();
  const statements = [
    db.prepare("INSERT INTO inbound_receipts (id,receipt_no,sku,name,source_batch,proof_ref,total_qty,actor_id,received_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(receiptId,receiptNo,sku,name,sourceBatch,proofRef,totalQty,actor.id,timestamp),
    db.prepare("INSERT INTO sku_settings (sku,name,product_type,unit_price,lead_time_days,safety_pct,updated_at) VALUES (?,?,'老款',0,63,.25,?) ON CONFLICT(sku) DO UPDATE SET name=CASE WHEN excluded.name<>'' THEN excluded.name ELSE sku_settings.name END,updated_at=excluded.updated_at").bind(sku,name,timestamp),
  ];
  allocations.forEach((a) => statements.push(
    db.prepare("INSERT INTO inbound_allocations (receipt_id,site,channel,qty) VALUES (?,?,?,?)").bind(receiptId,a.site,a.channel,a.qty),
    sourceBatch
      ? db.prepare("INSERT INTO inventory_balances (site,channel,sku,name,qty,pending_shelf_qty,updated_at) VALUES (?,?,?,?,0,?,?) ON CONFLICT(site,channel,sku) DO UPDATE SET pending_shelf_qty=inventory_balances.pending_shelf_qty+excluded.pending_shelf_qty,name=CASE WHEN excluded.name<>'' THEN excluded.name ELSE inventory_balances.name END,updated_at=excluded.updated_at").bind(a.site,a.channel,sku,name,a.qty,timestamp)
      : db.prepare("INSERT INTO inventory_balances (site,channel,sku,name,qty,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(site,channel,sku) DO UPDATE SET qty=inventory_balances.qty+excluded.qty,name=CASE WHEN excluded.name<>'' THEN excluded.name ELSE inventory_balances.name END,updated_at=excluded.updated_at").bind(a.site,a.channel,sku,name,a.qty,timestamp),
    db.prepare("INSERT INTO inventory_movements (id,site,channel,sku,name,movement_type,qty_delta,balance_after,reference_type,reference_id,note,actor_id,created_at) SELECT ?,site,channel,sku,name,?,?,qty,'到仓单',?,?,?,? FROM inventory_balances WHERE site=? AND channel=? AND sku=?").bind(makeId("move"),sourceBatch?"到仓待上架":"管理员例外入库",sourceBatch?0:a.qty,receiptNo,proofRef,actor.id,timestamp,a.site,a.channel,sku),
  ));
  if (sourceBatch) {
    const batch = await db.prepare("SELECT id,sku,qty,stage,allocations_json,evidence_json FROM production_batches WHERE id=?").bind(sourceBatch).first<AnyRow>();
    if (!batch) throw new HttpError(404,"关联生产批次不存在");
    if (batch.stage!=="awaiting_receipt") throw new HttpError(409,"关联批次尚未进入等待到仓节点");
    if (batch.sku!==sku||Number(batch.qty)!==totalQty) throw new HttpError(409,"到仓SKU或实收总数与生产批次不一致");
    const planned=parseJson<Array<{site:string;channel:string;qty:number}>>(batch.allocations_json,[]);
    const plannedMap=new Map(planned.map((row)=>[`${row.site}|${row.channel}`,Number(row.qty)]));
    if(allocations.length!==plannedMap.size||allocations.some((row)=>plannedMap.get(`${row.site}|${row.channel}`)!==row.qty)) throw new HttpError(409,"到仓站点渠道分配与生产批次不一致");
    statements.unshift(guardStatement(db,actor,"到仓批次校验","EXISTS(SELECT 1 FROM production_batches WHERE id=? AND stage='awaiting_receipt' AND sku=? AND qty=? AND allocations_json=?)",[sourceBatch,sku,totalQty,batch.allocations_json]));
    const evidence = parseJson<AnyRow[]>(batch.evidence_json, []);
    evidence.push({ stage:"warehouse_received", reference:receiptNo, proofRef, at:timestamp, by:actor.name, role:actor.role });
    statements.push(db.prepare("UPDATE production_batches SET stage='shelf_pending',stage_owner='运营',evidence_json=?,updated_at=? WHERE id=?").bind(JSON.stringify(evidence),timestamp,sourceBatch));
  }
  statements.push(audit(actor,"渠道级到仓入库","receipt",receiptNo,{sku,totalQty,allocations,sourceBatch,proofRef}));
  if(staged)staged.push(...statements);else await db.batch(statements);
  return Response.json({ ok:true, receiptId, totalQty, allocations, nextStage:sourceBatch?"shelf_pending":null });
}

function normalizePlanItems(raw:unknown): PlanItem[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 1000) throw new HttpError(400, "备货明细需为1—1000行");
  const map = new Map<string,PlanItem>();
  for (const item of raw) {
    if (!item || typeof item !== "object" || !["string","number"].includes(typeof item.qty)) throw new HttpError(400, "备货明细格式无效");
    const sku = cleanSku(item.sku), qty = Number(item.qty);
    if (!sku || sku.length > 120 || !Number.isSafeInteger(qty) || qty <= 0 || qty > 1_000_000_000) throw new HttpError(400, "备货明细存在空SKU或无效数量，数量须为1—1,000,000,000的整数");
    const previous = map.get(sku);
    if ((previous?.qty??0)+qty > 1_000_000_000) throw new HttpError(400, "同一SKU备货总量不能超过1,000,000,000");
    map.set(sku,{ sku,name:cleanText(item.name,120)||previous?.name||"",qty:(previous?.qty??0)+qty,reason:cleanText(item.reason,240)||previous?.reason||"" });
  }
  return [...map.values()];
}

function buildSeriesOrders(items:AnyRow[],settingsRows:AnyRow[]) {
  const settingMap=new Map<string,AnyRow>(settingsRows.map((row)=>[String(row.sku),row]));
  const missing:string[]=[];
  const groups=new Map<string,AnyRow>();
  for(const item of items){
    const setting=settingMap.get(item.sku)??{};
    const seriesName=cleanText(setting.product_series,120);
    if(!seriesName||seriesName==="待归类"){missing.push(item.sku);continue;}
    const supplierName=cleanText(setting.supplier_name,120);
    const factoryName=cleanText(setting.factory_name,120);
    if(!supplierName||!factoryName){missing.push(item.sku);continue;}
    const key=`${supplierName}|${factoryName}|${seriesName}`;
    const group=groups.get(key)??{seriesName,supplierName,factoryName,totalQty:0,items:[]};
    const enriched={...item,seriesName,supplierName,factoryName};
    group.items.push(enriched);group.totalQty+=Number(item.total||0);groups.set(key,group);
  }
  if(missing.length) throw new HttpError(409,`以下SKU尚未完整维护产品系列、供应商和工厂：${missing.slice(0,12).join("、")}${missing.length>12?`等${missing.length}个`:""}。请先完善主数据`);
  return [...groups.values()];
}

async function monthlySubmit(actor:Actor, payload:AnyRow) {
  requireBusinessPermission(actor,"monthly.submit");
  const month = cleanText(payload.month,7), site = cleanText(payload.site,20), channel = cleanText(payload.channel,20);
  if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400,"月份无效");
  validSiteChannel(site,channel); requireScope(actor,site,channel);
  if (channel === "线下分销") throw new HttpError(400,"月度协同提交仅统计TikTok和Shopee");
  const zeroDemand=payload.zeroDemand===true,zeroReason=cleanText(payload.zeroReason,500);
  if(zeroDemand&&zeroReason.length<4) throw new HttpError(400,"无需备货也需填写确认说明");
  const items = zeroDemand?[]:normalizePlanItems(payload.items);
  const db = database();
  const locked = await db.prepare("SELECT status FROM approval_requests WHERE type='monthly_plan' AND month=? AND status IN ('pending','approved')").bind(month).first();
  if (locked) throw new HttpError(409,"该月计划已进入审批或已批准，不能直接覆盖；请走变更审批");
  const idValue = `monthly_${month}_${site}_${channel}`, timestamp=nowIso(), totalQty=items.reduce((s,r)=>s+r.qty,0);
  const forecasts=await loadForecast(db,{...actor,role:"运营",site,channel});
  for(const item of items)if(!forecasts.suggestions.some(r=>r.sku===item.sku))forecasts.suggestions.push({sku:item.sku,site,channel,name:item.name,suggestedProduction:0,forecastDaily:0,confidence:"无销量历史",forecastVersion:"7-21-56-v1",note:"运营人工追加SKU，无历史数据可生成系统建议"});
  const snapshots=forecasts.suggestions.filter((r:AnyRow)=>r.site===site&&r.channel===channel).map((r:AnyRow)=>db.prepare("INSERT INTO forecast_snapshots (id,month,sku,site,channel,system_qty,forecast_sales,operator_qty,model_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(month,sku,site,channel) DO UPDATE SET system_qty=excluded.system_qty,forecast_sales=excluded.forecast_sales,operator_qty=excluded.operator_qty,model_json=excluded.model_json,created_at=excluded.created_at").bind(makeId("forecast"),month,r.sku,site,channel,r.suggestedProduction,r.forecastDaily*new Date(Number(month.slice(0,4)),Number(month.slice(5,7)),0).getDate(),items.find(i=>i.sku===r.sku)?.qty||0,JSON.stringify(r),timestamp));
  await atomicBatch(db,[
    // Removed manual-only SKUs may no longer occur in the current forecast rows.
    // Clear their previous operator demand along with the replaced submission.
    db.prepare("UPDATE forecast_snapshots SET operator_qty=0 WHERE month=? AND site=? AND channel=?").bind(month,site,channel),
    ...snapshots,
    guardStatement(db,actor,"monthlySubmit","NOT EXISTS (SELECT 1 FROM approval_requests WHERE type='monthly_plan' AND month=? AND status IN ('pending','approved'))",[month]),
    db.prepare("INSERT INTO monthly_submissions (id,month,site,channel,items_json,total_qty,actor_id,submitted_at,zero_demand,zero_reason) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(month,site,channel) DO UPDATE SET items_json=excluded.items_json,total_qty=excluded.total_qty,actor_id=excluded.actor_id,submitted_at=excluded.submitted_at,zero_demand=excluded.zero_demand,zero_reason=excluded.zero_reason,version=monthly_submissions.version+1")
      .bind(idValue,month,site,channel,JSON.stringify(items),totalQty,actor.id,timestamp,zeroDemand?1:0,zeroReason),
    audit(actor,"提交月度备货需求","monthly_submission",idValue,{month,site,channel,totalQty,skuCount:items.length}),
  ]);
  return Response.json({ok:true,totalQty,skuCount:items.length});
}

async function submitPlan(actor:Actor,payload:AnyRow) {
  requireBusinessPermission(actor,"plan.submit");
  const month=cleanText(payload.month,7);
  if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400,"月份无效");
  const submissions=await all("SELECT * FROM monthly_submissions WHERE month=?",[month]);
  const missing=missingMonthlyScopes(submissions);
  if(missing.length) throw new HttpError(409,`仍有${missing.length}个站点渠道未提交，不能进入审批`);
  const summary=new Map<string,{sku:string;name:string;total:number;allocations:Array<{site:string;channel:string;qty:number}>}>();
  for(const submission of submissions){
    for(const item of parseJson<PlanItem[]>(submission.items_json,[])){
      const row=summary.get(item.sku)??{sku:item.sku,name:item.name,total:0,allocations:[]};
      row.total+=item.qty; row.allocations.push({site:submission.site,channel:submission.channel,qty:item.qty});
      if(!row.name) row.name=item.name; summary.set(item.sku,row);
    }
  }
  const items=[...summary.values()];
  // A fully confirmed zero-demand month is still a valid plan.
  for(const item of items){ if(!allocationMatchesTotal(item.total,item.allocations)) throw new HttpError(409,`${item.sku}总量与站点渠道分配不一致`); }
  const db=database(), timestamp=nowIso();
  const seriesOrders=buildSeriesOrders(items,await all("SELECT sku,product_series,supplier_name,factory_name FROM sku_settings"));
  const existing=await db.prepare("SELECT * FROM approval_requests WHERE type='monthly_plan' AND month=?").bind(month).first<AnyRow>();
  if(existing && existing.status!=="rejected") throw new HttpError(409,"该月计划已经提交审批");
  const approvalId=existing?.id??makeId("approval");
  const sql=existing
    ? "UPDATE approval_requests SET version=version+1,status='pending',stage='admin_review',creator_id=?,creator_role=?,payload_json=?,decision_comment='',approved_by=NULL,updated_at=? WHERE id=?"
    : "INSERT INTO approval_requests (id,type,month,status,stage,creator_id,creator_role,payload_json,decision_comment,approved_by,created_at,updated_at) VALUES (?,'monthly_plan',?,'pending','admin_review',?,?,?,'',NULL,?,?)";
  const statement=existing
    ? db.prepare(sql).bind(actor.id,actor.role,JSON.stringify({items,seriesOrders}),timestamp,approvalId)
    : db.prepare(sql).bind(approvalId,month,actor.id,actor.role,JSON.stringify({items,seriesOrders}),timestamp,timestamp);
  await atomicBatch(db,[...submissions.map(row=>guardStatement(db,actor,"submitPlan","EXISTS (SELECT 1 FROM monthly_submissions WHERE id=? AND version=?)",[row.id,row.version])),guardStatement(db,actor,"submitPlan",existing?"EXISTS (SELECT 1 FROM approval_requests WHERE id=? AND version=? AND status='rejected')":"NOT EXISTS (SELECT 1 FROM approval_requests WHERE type='monthly_plan' AND month=?)",existing?[existing.id,existing.version]:[month]),statement,audit(actor,"按系列提交月度计划审批","approval",approvalId,{month,seriesCount:seriesOrders.length,skuCount:items.length,totalQty:items.reduce((s,r)=>s+r.total,0)})]);
  return Response.json({ok:true,approvalId,seriesCount:seriesOrders.length,skuCount:items.length});
}

async function decideApproval(actor:Actor,payload:AnyRow) {
  requireBusinessPermission(actor,"approval.decide");
  const approvalId=cleanText(payload.approvalId,80), decision=cleanText(payload.decision,12), comment=cleanText(payload.comment,300);
  if(!["approve","reject"].includes(decision)||comment.length<3) throw new HttpError(400,"请选择审批结果并填写审批意见");
  const db=database(), approval=await db.prepare("SELECT * FROM approval_requests WHERE id=?").bind(approvalId).first<AnyRow>();
  if(!approval||approval.status!=="pending") throw new HttpError(404,"待审批记录不存在或已经处理");
  if(approval.creator_id===actor.id) throw new HttpError(403,"申请人不能审批自己提交的计划");
  const timestamp=nowIso(), status=decision==="approve"?"approved":"rejected";
  const statements=[
    guardStatement(db,actor,"decideApproval","EXISTS (SELECT 1 FROM approval_requests WHERE id=? AND status='pending' AND version=?)",[approvalId,approval.version]),
    db.prepare("UPDATE approval_requests SET status=?,stage=?,decision_comment=?,approved_by=?,updated_at=?,version=version+1 WHERE id=?").bind(status,status,comment,actor.id,timestamp,approvalId),
  ];
  if(decision==="approve"){
    const supplyId=await resolveSupplyUser(payload.supplyUserId,approval.creator_id);
    const plan=parseJson<AnyRow>(approval.payload_json,{items:[]});
    statements.push(...planIntegrityGuards(db,actor,plan.items||[]));
    statements.push(db.prepare("UPDATE forecast_snapshots SET approved_qty=0,approval_id=? WHERE month=?").bind(approvalId,approval.month));
    for(const r of plan.items||[])for(const a of r.allocations||[])statements.push(db.prepare("UPDATE forecast_snapshots SET approved_qty=?,approval_id=? WHERE month=? AND sku=? AND site=? AND channel=?").bind(a.qty,approvalId,approval.month,r.sku,a.site,a.channel));
    const seriesOrders:Array<AnyRow>=Array.isArray(plan.seriesOrders)&&plan.seriesOrders.length?plan.seriesOrders:buildSeriesOrders(plan.items??[],await all("SELECT sku,product_series,supplier_name,factory_name FROM sku_settings"));
    for(const series of seriesOrders){
      const items=Array.isArray(series.items)?series.items:[];
      if(!items.length) throw new HttpError(409,`${series.seriesName}没有有效SKU明细`);
      for(const item of items) if(!allocationMatchesTotal(item.total,item.allocations as Array<{qty:number}>)) throw new HttpError(409,`${item.sku}分配合计异常，审批已阻止`);
      const supplier=await db.prepare("SELECT * FROM business_partners WHERE type='supplier' AND name=? AND active=1").bind(series.supplierName).first<AnyRow>();
      const factory=await db.prepare("SELECT * FROM business_partners WHERE type='factory' AND name=? AND active=1").bind(series.factoryName).first<AnyRow>();
      if(!supplier) throw new HttpError(409,`${series.supplierName}尚未建立启用中的供应商主数据`);
      if(!factory?.assigned_user_id) throw new HttpError(409,`${series.factoryName}尚未建立工厂主数据或未绑定工厂账号`);
      const purchaseOrderId=makeId("series_po"),productionOrderId=makeId("series_mo");
      const totalQty=items.reduce((sum,item)=>sum+Number(item.total||0),0);
      statements.push(
        db.prepare("INSERT INTO series_purchase_orders (id,month,series_name,supplier_name,factory_name,status,total_qty,sku_count,approval_id,creator_id,assigned_supply_user_id,created_at,updated_at) VALUES (?,?,?,?,?,'draft',?,?,?,?,?,?,?)")
          .bind(purchaseOrderId,approval.month,series.seriesName,series.supplierName,series.factoryName,totalQty,items.length,approval.id,approval.creator_id,supplyId,timestamp,timestamp),
        db.prepare("INSERT INTO series_production_orders (id,purchase_order_id,month,series_name,factory_name,status,total_planned_qty,total_produced_qty,evidence_json,creator_id,assigned_user_id,progress_pct,qc_status,started_at,completed_at,created_at,updated_at) VALUES (?,?,?,?,?,'awaiting_order',?,0,'[]',?,?,0,'pending',NULL,NULL,?,?)")
          .bind(productionOrderId,purchaseOrderId,approval.month,series.seriesName,series.factoryName,totalQty,approval.creator_id,factory.assigned_user_id,timestamp,timestamp),
      );
      for(const item of items){
        const purchaseItemId=makeId("series_po_item"),productionItemId=makeId("series_mo_item");
        statements.push(
          db.prepare("INSERT INTO series_purchase_order_items (id,purchase_order_id,sku,name,ordered_qty,allocations_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
            .bind(purchaseItemId,purchaseOrderId,item.sku,item.name,item.total,JSON.stringify(item.allocations),timestamp,timestamp),
          db.prepare("INSERT INTO series_production_order_items (id,production_order_id,purchase_order_item_id,sku,name,planned_qty,produced_qty,created_at,updated_at) VALUES (?,?,?,?,?,?,0,?,?)")
            .bind(productionItemId,productionOrderId,purchaseItemId,item.sku,item.name,item.total,timestamp,timestamp),
        );
      }
    }
  }
  statements.push(audit(actor,decision==="approve"?"批准计划并生成系列采购生产单":"驳回月度计划","approval",approvalId,{comment,status}));
  await atomicBatch(db,statements);
  return Response.json({ok:true,status});
}

async function confirmPurchaseOrder(actor:Actor,payload:AnyRow){
  requireBusinessPermission(actor,"purchase.confirm");
  const purchaseOrderId=cleanText(payload.purchaseOrderId,120),orderRef=cleanText(payload.orderRef,120),expectedCompletionDate=cleanText(payload.expectedCompletionDate,10),note=cleanText(payload.note,500);
  if(!orderRef||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(expectedCompletionDate)||expectedCompletionDate<chinaDate()) throw new HttpError(400,"请填写供应商订单号和不早于今天的预计完工日");
  const db=database(),order=await db.prepare("SELECT * FROM series_purchase_orders WHERE id=?").bind(purchaseOrderId).first<AnyRow>();
  if(!order||!["draft","ordered"].includes(order.status)||order.supplier_confirmed_at) throw new HttpError(409,"该采购单当前不能重复确认");
  requireAssignedActor(actor,"供应链",order.assigned_supply_user_id,"采购单");
  const timestamp=nowIso();
  await atomicBatch(db,[
    guardStatement(db,actor,"confirmPurchaseOrder","EXISTS (SELECT 1 FROM series_purchase_orders WHERE id=? AND status=? AND updated_at=? AND supplier_confirmed_at IS NULL)",[order.id,order.status,order.updated_at]),
    db.prepare("UPDATE series_purchase_orders SET status='supplier_confirmed',order_ref=?,supplier_confirmed_at=?,expected_completion_date=?,updated_at=? WHERE id=? AND supplier_confirmed_at IS NULL").bind(orderRef,timestamp,expectedCompletionDate,timestamp,purchaseOrderId),
    db.prepare("UPDATE series_production_orders SET status='awaiting_factory',promised_completion_date=?,updated_at=? WHERE purchase_order_id=? AND status='awaiting_order'").bind(expectedCompletionDate,timestamp,purchaseOrderId),
    audit(actor,"确认供应商接单","series_purchase_order",purchaseOrderId,{orderRef,expectedCompletionDate,note}),
  ]);
  return Response.json({ok:true,status:"supplier_confirmed"});
}

async function acceptProductionOrder(actor:Actor,payload:AnyRow){
  requireBusinessPermission(actor,"production.accept");
  const productionOrderId=cleanText(payload.productionOrderId,120),promisedCompletionDate=cleanText(payload.promisedCompletionDate,10),evidenceRef=cleanText(payload.evidenceRef,240),note=cleanText(payload.note,500);
  if(!evidenceRef||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(promisedCompletionDate)||promisedCompletionDate<chinaDate()) throw new HttpError(400,"请填写工厂接单凭证和有效承诺完工日");
  const db=database(),order=await db.prepare("SELECT * FROM series_production_orders WHERE id=?").bind(productionOrderId).first<AnyRow>();
  if(!order||order.status!=="awaiting_factory") throw new HttpError(409,"该生产单当前不能接单");
  requireAssignedActor(actor,"工厂",order.assigned_user_id,"生产单");
  const timestamp=nowIso(),evidence=parseJson<AnyRow[]>(order.evidence_json,[]);
  evidence.push({stage:"factory_accepted",reference:evidenceRef,note,promisedCompletionDate,at:timestamp,by:actor.name,role:actor.role});
  await db.batch([
    db.prepare("UPDATE series_production_orders SET status='in_production',promised_completion_date=?,progress_pct=1,evidence_json=?,started_at=?,updated_at=? WHERE id=? AND status='awaiting_factory'").bind(promisedCompletionDate,JSON.stringify(evidence),timestamp,timestamp,productionOrderId),
    db.prepare("UPDATE series_purchase_orders SET status='in_production',updated_at=? WHERE id=?").bind(timestamp,order.purchase_order_id),
    audit(actor,"工厂确认生产接单","series_production_order",productionOrderId,{promisedCompletionDate,evidenceRef,note}),
  ]);
  return Response.json({ok:true,status:"in_production"});
}

async function updateProductionProgress(actor:Actor,payload:AnyRow){
  requireBusinessPermission(actor,"production.progress");
  const productionOrderId=cleanText(payload.productionOrderId,120),progressPct=int(payload.progressPct),evidenceRef=cleanText(payload.evidenceRef,240),note=cleanText(payload.note,500);
  if(!Number.isInteger(progressPct)||progressPct<1||progressPct>99||!evidenceRef) throw new HttpError(400,"生产进度需为1—99%，并填写进度凭证");
  const db=database(),order=await db.prepare("SELECT * FROM series_production_orders WHERE id=?").bind(productionOrderId).first<AnyRow>();
  if(!order||order.status!=="in_production") throw new HttpError(409,"只有生产中的订单可以更新进度");
  requireAssignedActor(actor,"工厂",order.assigned_user_id,"生产单");
  if(progressPct<Number(order.progress_pct||0)) throw new HttpError(409,"生产进度不能倒退");
  const timestamp=nowIso(),evidence=parseJson<AnyRow[]>(order.evidence_json,[]);
  evidence.push({stage:"production_progress",reference:evidenceRef,note,progressPct,at:timestamp,by:actor.name,role:actor.role});
  await db.batch([db.prepare("UPDATE series_production_orders SET progress_pct=?,evidence_json=?,updated_at=? WHERE id=? AND status='in_production' AND progress_pct<=?").bind(progressPct,JSON.stringify(evidence),timestamp,productionOrderId,progressPct),audit(actor,"更新生产进度","series_production_order",productionOrderId,{progressPct,evidenceRef,note})]);
  return Response.json({ok:true,progressPct});
}

async function completeProductionOrder(actor:Actor,payload:AnyRow){
  requireBusinessPermission(actor,"production.complete");
  const productionOrderId=cleanText(payload.productionOrderId,120),evidenceRef=cleanText(payload.evidenceRef,240),note=cleanText(payload.note,500);
  if(!evidenceRef||note.length<2) throw new HttpError(400,"完成生产必须填写生产单据编号和完工说明");
  const db=database(),order=await db.prepare("SELECT * FROM series_production_orders WHERE id=?").bind(productionOrderId).first<AnyRow>();
  if(!order) throw new HttpError(404,"系列生产单不存在");
  requireAssignedActor(actor,"工厂",order.assigned_user_id,"生产单");
  if(!["in_production","pending"].includes(order.status)) throw new HttpError(409,"生产单尚未接单或当前状态不能登记完工");
  if(["completed","completed_with_variance"].includes(order.status)) throw new HttpError(409,"该系列生产单已经完成，不能重复登记");
  const sourceItems=await all("SELECT * FROM series_production_order_items WHERE production_order_id=?",[productionOrderId]);
  const inputMap=new Map<string,number>();
  for(const row of Array.isArray(payload.items)?payload.items:[]){const idValue=cleanText(row.id,120),qty=int(row.producedQty);if(idValue&&Number.isInteger(qty))inputMap.set(idValue,qty);}
  if(sourceItems.some((row)=>!inputMap.has(row.id))) throw new HttpError(400,"请完整填写该系列下所有SKU的完工数量");
  let totalProduced=0;
  for(const item of sourceItems){const qty=Number(inputMap.get(item.id));if(qty<0||qty>Number(item.planned_qty)*2)throw new HttpError(400,`${item.sku}完工数量不合法`);totalProduced+=qty;}
  const timestamp=nowIso(),status=totalProduced===Number(order.total_planned_qty)?"completed":"completed_with_variance";
  const evidence=parseJson<AnyRow[]>(order.evidence_json,[]);evidence.push({stage:"production_completed",reference:evidenceRef,note,plannedQty:Number(order.total_planned_qty),producedQty:totalProduced,at:timestamp,by:actor.name,role:actor.role});
  const statements=[guardStatement(db,actor,"生产完工状态校验","EXISTS(SELECT 1 FROM series_production_orders WHERE id=? AND status=? AND updated_at=?)",[productionOrderId,order.status,order.updated_at]),...sourceItems.map((item)=>db.prepare("UPDATE series_production_order_items SET produced_qty=?,updated_at=? WHERE id=?").bind(inputMap.get(item.id),timestamp,item.id))];
  statements.push(
    db.prepare("UPDATE series_production_orders SET status=?,total_produced_qty=?,progress_pct=100,qc_status='pending',evidence_json=?,started_at=COALESCE(started_at,created_at),completed_at=?,updated_at=? WHERE id=?").bind(status,totalProduced,JSON.stringify(evidence),timestamp,timestamp,productionOrderId),
    db.prepare("UPDATE series_purchase_orders SET status='awaiting_qc',updated_at=? WHERE id=?").bind(timestamp,order.purchase_order_id),
    audit(actor,"完成系列生产","series_production_order",productionOrderId,{seriesName:order.series_name,plannedQty:order.total_planned_qty,producedQty:totalProduced,status,evidenceRef}),
  );
  await db.batch(statements);
  return Response.json({ok:true,status,totalProduced,variance:totalProduced-Number(order.total_planned_qty)});
}

async function confirmProductionQc(actor:Actor,payload:AnyRow){
  requireBusinessPermission(actor,"production.qc");
  const productionOrderId=cleanText(payload.productionOrderId,120),decision=cleanText(payload.decision,20),evidenceRef=cleanText(payload.evidenceRef,240),note=cleanText(payload.note,500);
  if(!["pass","reject"].includes(decision)||!evidenceRef||note.length<3) throw new HttpError(400,"请选择质检结果，并填写质检报告编号和说明");
  const db=database(),order=await db.prepare("SELECT * FROM series_production_orders WHERE id=?").bind(productionOrderId).first<AnyRow>();
  if(!order||!["completed","completed_with_variance"].includes(order.status)) throw new HttpError(409,"只有已完工生产单可以质检");
  const timestamp=nowIso(),qcStatus=decision==="pass"?"passed":"rejected";
  await db.batch([
    db.prepare("UPDATE series_production_orders SET qc_status=?,qc_evidence=?,qc_at=?,qc_by=?,updated_at=? WHERE id=?").bind(qcStatus,evidenceRef,timestamp,actor.id,timestamp,productionOrderId),
    db.prepare("UPDATE series_purchase_orders SET status=?,updated_at=? WHERE id=?").bind(decision==="pass"?"ready_to_ship":"qc_rejected",timestamp,order.purchase_order_id),
    audit(actor,decision==="pass"?"生产质检通过":"生产质检不通过","series_production_order",productionOrderId,{evidenceRef,note}),
  ]);
  return Response.json({ok:true,qcStatus});
}

async function createTransportBatch(actor:Actor,payload:AnyRow){
  requireBusinessPermission(actor,"transport.create");
  const batchNo=cleanText(payload.batchNo,100).toUpperCase(),containerNo=cleanText(payload.containerNo,100).toUpperCase(),billNo=cleanText(payload.billNo,100).toUpperCase(),carrierName=cleanText(payload.carrierName,120),note=cleanText(payload.note,500);
  if(batchNo.length<3||!carrierName) throw new HttpError(400,"请填写运输主批次号和承运商");
  const db=database();
  if(await db.prepare("SELECT id FROM transport_batches WHERE batch_no=?").bind(batchNo).first()) throw new HttpError(409,"该运输主批次号已经存在");
  const carrier=await db.prepare("SELECT * FROM business_partners WHERE type='carrier' AND name=? AND active=1").bind(carrierName).first<AnyRow>();
  if(!carrier?.assigned_user_id) throw new HttpError(409,"承运商未启用或尚未绑定海运账号");
  const rawItems=Array.isArray(payload.items)?payload.items:[];
  if(!rawItems.length||rawItems.length>500) throw new HttpError(400,"运输批次需选择1—500个SKU");
  const itemInputs=new Map<string,AnyRow>();
  for(const raw of rawItems){
    const idValue=cleanText(raw.productionOrderItemId||raw.id,120),shippedQty=int(raw.shippedQty),allocations=Array.isArray(raw.allocations)?raw.allocations:[];
    if(!idValue||!Number.isInteger(shippedQty)||shippedQty<=0||!allocations.length) throw new HttpError(400,"每个发货SKU必须填写正整数数量和目的地分配");
    const normalized=allocations.map((row:AnyRow)=>({site:cleanText(row.site,20),channel:cleanText(row.channel,20),warehouseId:cleanText(row.warehouseId,120),qty:int(row.qty)}));
    for(const row of normalized){validSiteChannel(row.site,row.channel);if(!row.warehouseId||!Number.isInteger(row.qty)||row.qty<=0)throw new HttpError(400,"目的地仓库和分配数量不能为空");}
    if(!allocationMatchesTotal(shippedQty,normalized)) throw new HttpError(409,"SKU发货数量与目的地分配合计不一致");
    itemInputs.set(idValue,{shippedQty,allocations:normalized});
  }
  const placeholders=[...itemInputs.keys()].map(()=>"?").join(",");
  const sourceItems=await all(`SELECT i.*,o.series_name,o.id production_order_id,o.qc_status,p.allocations_json FROM series_production_order_items i JOIN series_production_orders o ON o.id=i.production_order_id JOIN series_purchase_order_items p ON p.id=i.purchase_order_item_id WHERE i.id IN (${placeholders})`,[...itemInputs.keys()]);
  if(sourceItems.length!==itemInputs.size) throw new HttpError(404,"部分生产SKU不存在");
  const legacyShipped=await all(`SELECT production_order_item_id,SUM(shipped_qty) qty FROM shipment_batch_items WHERE production_order_item_id IN (${placeholders}) GROUP BY production_order_item_id`,[...itemInputs.keys()]);
  const v2Shipped=await all(`SELECT production_order_item_id,SUM(shipped_qty) qty FROM transport_batch_items WHERE production_order_item_id IN (${placeholders}) GROUP BY production_order_item_id`,[...itemInputs.keys()]);
  const legacyAllocationRows=await all(`SELECT production_order_item_id,allocations_json FROM shipment_batch_items WHERE production_order_item_id IN (${placeholders})`,[...itemInputs.keys()]);
  const v2AllocationRows=await all(`SELECT bi.production_order_item_id,l.site,l.channel,SUM(li.qty) qty FROM transport_leg_items li JOIN transport_legs l ON l.id=li.leg_id JOIN transport_batch_items bi ON bi.id=li.batch_item_id WHERE bi.production_order_item_id IN (${placeholders}) GROUP BY bi.production_order_item_id,l.site,l.channel`,[...itemInputs.keys()]);
  const shippedMap=new Map<string,number>();
  for(const row of [...legacyShipped,...v2Shipped]) shippedMap.set(row.production_order_item_id,(shippedMap.get(row.production_order_item_id)??0)+Number(row.qty||0));
  const usedScopeMap=new Map<string,number>();
  for(const row of legacyAllocationRows) for(const allocation of parseJson<AnyRow[]>(row.allocations_json,[])){const key=`${row.production_order_item_id}|${allocation.site}|${allocation.channel}`;usedScopeMap.set(key,(usedScopeMap.get(key)??0)+Number(allocation.qty||0));}
  for(const row of v2AllocationRows){const key=`${row.production_order_item_id}|${row.site}|${row.channel}`;usedScopeMap.set(key,(usedScopeMap.get(key)??0)+Number(row.qty||0));}
  const warehouseRows=await all("SELECT * FROM warehouses WHERE active=1");
  const warehouseMap=new Map<string,AnyRow>(warehouseRows.map((row)=>[row.id,row]));
  const incomingByWarehouse=new Map<string,number>();
  for(const source of sourceItems){
    if(source.qc_status!=="passed") throw new HttpError(409,`${source.sku}所在生产单尚未质检通过`);
    const input=itemInputs.get(source.id)!,available=Math.max(0,Number(source.produced_qty||0)-(shippedMap.get(source.id)??0));
    if(input.shippedQty>available) throw new HttpError(409,`${source.sku}最多还可发${available}件`);
    const planned=new Map<string,number>();
    for(const row of parseJson<AnyRow[]>(source.allocations_json,[])) planned.set(`${row.site}|${row.channel}`,(planned.get(`${row.site}|${row.channel}`)??0)+Number(row.qty||0));
    const inputScope=new Map<string,number>();
    for(const allocation of input.allocations){
      const warehouse=warehouseMap.get(allocation.warehouseId);
      if(!warehouse||warehouse.site!==allocation.site||warehouse.channel!==allocation.channel) throw new HttpError(409,`${allocation.site} · ${allocation.channel}的目的仓无效`);
      incomingByWarehouse.set(allocation.warehouseId,(incomingByWarehouse.get(allocation.warehouseId)??0)+allocation.qty);
      const scopeKey=`${allocation.site}|${allocation.channel}`;
      inputScope.set(scopeKey,(inputScope.get(scopeKey)??0)+allocation.qty);
    }
    for(const [scopeKey,qty] of inputScope){const already=usedScopeMap.get(`${source.id}|${scopeKey}`)??0;if(qty+already>Number(planned.get(scopeKey)||0)) throw new HttpError(409,`${source.sku}累计分配到${scopeKey}的数量超过原始需求`);}
  }
  for(const [warehouseId,incoming] of incomingByWarehouse){
    const warehouse=warehouseMap.get(warehouseId)!;if(Number(warehouse.capacity_qty||0)<=0)continue;
    const used=await db.prepare("SELECT COALESCE(SUM(qty+pending_shelf_qty+quarantine_qty),0) total FROM inventory_balances WHERE site=? AND channel=?").bind(warehouse.site,warehouse.channel).first<AnyRow>();
    const committed=await db.prepare("SELECT COALESCE(SUM(li.qty-li.received_qty),0) total FROM transport_leg_items li JOIN transport_legs l ON l.id=li.leg_id WHERE l.warehouse_id=? AND l.stage<>'on_shelf'").bind(warehouseId).first<AnyRow>();
    const projected=Number(used?.total||0)+Number(committed?.total||0)+incoming;
    if(projected>Number(warehouse.capacity_qty)) throw new HttpError(409,`${warehouse.name}预计占用${projected}件，超过容量${warehouse.capacity_qty}件`);
  }
  const batchId=makeId("transport"),timestamp=nowIso(),statements:ReturnType<ReturnType<typeof database>["prepare"]>[]=[];
  const totalQty=sourceItems.reduce((sum,row)=>sum+Number(itemInputs.get(row.id)!.shippedQty),0),seriesCount=new Set(sourceItems.map((row)=>row.series_name)).size;
  statements.push(db.prepare("INSERT INTO transport_batches (id,batch_no,container_no,bill_no,carrier_name,status,total_shipped_qty,sku_count,series_count,creator_id,created_at,updated_at) VALUES (?,?,?,?,?,'booking',?,?,?,?,?,?)").bind(batchId,batchNo,containerNo,billNo,carrierName,totalQty,sourceItems.length,seriesCount,actor.id,timestamp,timestamp));
  const legGroups=new Map<string,{site:string;channel:string;warehouse:AnyRow;items:Array<{batchItemId:string;sku:string;qty:number}>}>();
  for(const source of sourceItems){
    const input=itemInputs.get(source.id)!,batchItemId=makeId("transport_item");
    statements.push(db.prepare("INSERT INTO transport_batch_items (id,batch_id,production_order_id,production_order_item_id,series_name,sku,name,shipped_qty,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(batchItemId,batchId,source.production_order_id,source.id,source.series_name,source.sku,source.name,input.shippedQty,timestamp,timestamp));
    for(const allocation of input.allocations){
      const warehouse=warehouseMap.get(allocation.warehouseId)!,key=`${allocation.site}|${allocation.channel}|${allocation.warehouseId}`;
      const group=legGroups.get(key)??{site:allocation.site,channel:allocation.channel,warehouse,items:[] as Array<{batchItemId:string;sku:string;qty:number}>};
      group.items.push({batchItemId,sku:source.sku,qty:allocation.qty});legGroups.set(key,group);
    }
  }
  let legIndex=0;
  for(const group of legGroups.values()){
    legIndex+=1;const legId=makeId("leg"),legNo=`${batchNo}-${String(legIndex).padStart(2,"0")}`,legQty=group.items.reduce((sum,row)=>sum+row.qty,0);
    statements.push(db.prepare("INSERT INTO transport_legs (id,batch_id,leg_no,site,channel,warehouse_id,warehouse_name,stage,stage_owner,assigned_user_id,total_qty,evidence_json,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'booking','供应链',?,?,'[]',1,?,?)").bind(legId,batchId,legNo,group.site,group.channel,group.warehouse.id,group.warehouse.name,carrier.assigned_user_id,legQty,timestamp,timestamp));
    for(const item of group.items) statements.push(db.prepare("INSERT INTO transport_leg_items (id,leg_id,batch_item_id,sku,qty,received_qty,pending_shelf_qty,sellable_qty,quarantine_qty,created_at,updated_at) VALUES (?,?,?,?,?,0,0,0,0,?,?)").bind(makeId("leg_item"),legId,item.batchItemId,item.sku,item.qty,timestamp,timestamp));
  }
  statements.push(audit(actor,"创建跨系列运输主批次","transport_batch",batchId,{batchNo,containerNo,billNo,carrierName,totalQty,skuCount:sourceItems.length,seriesCount,destinationLegs:legGroups.size,note}));
  await db.batch(statements);
  return Response.json({ok:true,batchId,batchNo,totalQty,skuCount:sourceItems.length,seriesCount,legCount:legGroups.size});
}

async function advanceTransportLeg(actor:Actor,payload:AnyRow){
  if(!hasPermission(actor.role,"transport.advance.supply")&&!hasPermission(actor.role,"transport.advance.sea")) throw new HttpError(403,"当前账号没有推进运输节点的权限");
  const legId=cleanText(payload.legId,120),version=int(payload.version),evidenceRef=cleanText(payload.evidenceRef,240),note=cleanText(payload.note,500),etd=cleanText(payload.etd,10),eta=cleanText(payload.eta,10),ata=cleanText(payload.ata,10),portName=cleanText(payload.portName,120);
  if(!legId||!evidenceRef||note.length<2) throw new HttpError(400,"推进节点必须填写业务凭证和说明");
  const db=database(),leg=await db.prepare("SELECT * FROM transport_legs WHERE id=?").bind(legId).first<AnyRow>();
  if(!leg) throw new HttpError(404,"目的地运输分腿不存在");
  const transition=TRANSPORT_FLOW[leg.stage];
  if(!transition) throw new HttpError(409,leg.stage==="awaiting_receipt"?"该分腿需登记到仓":"该分腿已进入上架阶段");
  if(leg.stage==="booking") requireBusinessPermission(actor,"transport.advance.supply");
  else {requireBusinessPermission(actor,"transport.advance.sea");requireAssignedActor(actor,"海运",leg.assigned_user_id,"运输分腿");}
  if(leg.stage==="booking"&&(!/^\d{4}-\d{2}-\d{2}$/.test(etd)||!/^\d{4}-\d{2}-\d{2}$/.test(eta)||eta<etd)) throw new HttpError(400,"订舱交接必须填写有效ETD、ETA，且ETA不早于ETD");
  if(transition.next==="customs_clearance"&&!ata) throw new HttpError(400,"到港转清关必须填写实际到港日");
  const expectedVersion=Number.isInteger(version)?version:Number(leg.version),timestamp=nowIso(),evidence=parseJson<AnyRow[]>(leg.evidence_json,[]);
  evidence.push({stage:leg.stage,reference:evidenceRef,note,etd:etd||undefined,eta:eta||undefined,ata:ata||undefined,portName:portName||undefined,at:timestamp,by:actor.name,role:actor.role});
  const result=await db.prepare("UPDATE transport_legs SET stage=?,stage_owner=?,etd=CASE WHEN ?<>'' THEN ? ELSE etd END,eta=CASE WHEN ?<>'' THEN ? ELSE eta END,ata=CASE WHEN ?<>'' THEN ? ELSE ata END,port_name=CASE WHEN ?<>'' THEN ? ELSE port_name END,evidence_json=?,version=version+1,updated_at=? WHERE id=? AND version=?").bind(transition.next,transition.nextOwner,etd,etd,eta,eta,ata,ata,portName,portName,JSON.stringify(evidence),timestamp,legId,expectedVersion).run();
  if(!result.meta.changes) throw new HttpError(409,"该运输节点已被其他人更新，请刷新后重试");
  await db.batch([db.prepare("UPDATE transport_batches SET status='active',updated_at=? WHERE id=?").bind(timestamp,leg.batch_id),audit(actor,"推进目的地运输节点","transport_leg",legId,{from:leg.stage,to:transition.next,evidenceRef,note,etd,eta,ata,portName})]);
  return Response.json({ok:true,stage:transition.next,version:expectedVersion+1});
}

async function updateTransportLegPlan(actor:Actor,payload:AnyRow){
  requireBusinessPermission(actor,"transport.eta");
  const legId=cleanText(payload.legId,120),eta=cleanText(payload.eta,10),etd=cleanText(payload.etd,10),reason=cleanText(payload.reason,500);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(eta)||eta<chinaDate()||reason.length<3) throw new HttpError(400,"请填写今天或未来的ETA及调整原因");
  const db=database(),leg=await db.prepare("SELECT * FROM transport_legs WHERE id=?").bind(legId).first<AnyRow>();
  if(!leg||!["booking","sea_freight","port_arrived","customs_clearance","last_mile_delivery"].includes(leg.stage)) throw new HttpError(409,"该分腿当前不能调整ETA");
  if(actor.role!=="管理员") requireAssignedActor(actor,"海运",leg.assigned_user_id,"运输分腿");
  const timestamp=nowIso();
  await db.batch([db.prepare("UPDATE transport_legs SET etd=CASE WHEN ?<>'' THEN ? ELSE etd END,eta=?,version=version+1,updated_at=? WHERE id=?").bind(etd,etd,eta,timestamp,legId),audit(actor,"调整目的地运输计划","transport_leg",legId,{from:leg.eta||null,to:eta,etd:etd||leg.etd||null,reason})]);
  return Response.json({ok:true,eta});
}

async function receiveTransportLeg(actor:Actor,payload:AnyRow){
  requireBusinessPermission(actor,"transport.receive");
  const legId=cleanText(payload.legId,120),receiptNo=cleanText(payload.receiptNo,100),proofRef=cleanText(payload.proofRef,240),note=cleanText(payload.note,500);
  if(!legId||!receiptNo||!proofRef) throw new HttpError(400,"请填写到仓单号和到仓凭证");
  const db=database(),leg=await db.prepare("SELECT * FROM transport_legs WHERE id=?").bind(legId).first<AnyRow>();
  if(!leg||leg.stage!=="awaiting_receipt") throw new HttpError(409,"该目的地分腿当前不在等待到仓节点");
  if(await db.prepare("SELECT id FROM transport_receipts WHERE receipt_no=?").bind(receiptNo).first()) throw new HttpError(409,"到仓单号已经登记");
  const sourceItems=await all("SELECT li.*,bi.name FROM transport_leg_items li JOIN transport_batch_items bi ON bi.id=li.batch_item_id WHERE li.leg_id=?",[legId]);
  const inputMap=new Map<string,{received:number;quarantine:number}>();
  if(!Array.isArray(payload.items)||!payload.items.length)throw new HttpError(400,"缺少到仓明细");
  for(const row of payload.items){const idValue=cleanText(row.id||row.legItemId,120),received=Number(row.receivedQty),quarantine=Number(row.quarantineQty??0);if(!idValue||!Number.isSafeInteger(received)||received<=0||!Number.isSafeInteger(quarantine)||quarantine<0||quarantine>received||inputMap.has(idValue)||!sourceItems.some(item=>item.id===idValue))throw new HttpError(400,"到仓明细存在未知或重复SKU、非整数数量或无效隔离数量");inputMap.set(idValue,{received,quarantine});}
  const selected=sourceItems.filter((row)=>inputMap.has(row.id));
  if(!selected.length) throw new HttpError(400,"本次至少登记一个SKU的实收数量");
  for(const item of selected) if(inputMap.get(item.id)!.received>Number(item.qty)-Number(item.received_qty||0)) throw new HttpError(409,`${item.sku}实收超过剩余可收数量`);
  const receiptId=makeId("transport_receipt"),timestamp=nowIso(),totalReceived=selected.reduce((sum,row)=>sum+inputMap.get(row.id)!.received,0),totalQuarantine=selected.reduce((sum,row)=>sum+inputMap.get(row.id)!.quarantine,0),statements:ReturnType<ReturnType<typeof database>["prepare"]>[]=[];
  statements.push(db.prepare("INSERT INTO transport_receipts (id,receipt_no,leg_id,proof_ref,note,total_received_qty,total_quarantine_qty,actor_id,received_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(receiptId,receiptNo,legId,proofRef,note,totalReceived,totalQuarantine,actor.id,timestamp));
  for(const item of selected){
    const value=inputMap.get(item.id)!,pending=value.received-value.quarantine;
    statements.push(
      db.prepare("INSERT INTO transport_receipt_items (id,receipt_id,leg_item_id,received_qty,quarantine_qty,created_at) VALUES (?,?,?,?,?,?)").bind(makeId("transport_receipt_item"),receiptId,item.id,value.received,value.quarantine,timestamp),
      db.prepare("UPDATE transport_leg_items SET received_qty=received_qty+?,pending_shelf_qty=pending_shelf_qty+?,quarantine_qty=quarantine_qty+?,updated_at=? WHERE id=?").bind(value.received,pending,value.quarantine,timestamp,item.id),
      db.prepare("INSERT INTO inventory_balances (site,channel,sku,name,qty,pending_shelf_qty,quarantine_qty,updated_at) VALUES (?,?,?,?,0,?,?,?) ON CONFLICT(site,channel,sku) DO UPDATE SET pending_shelf_qty=inventory_balances.pending_shelf_qty+excluded.pending_shelf_qty,quarantine_qty=inventory_balances.quarantine_qty+excluded.quarantine_qty,name=CASE WHEN excluded.name<>'' THEN excluded.name ELSE inventory_balances.name END,updated_at=excluded.updated_at").bind(leg.site,leg.channel,item.sku,item.name,pending,value.quarantine,timestamp),
      db.prepare("INSERT INTO inventory_movements (id,site,channel,sku,name,movement_type,qty_delta,balance_after,reference_type,reference_id,note,actor_id,created_at) SELECT ?,site,channel,sku,name,'到仓待上架',0,qty,'目的地到仓单',?,?,?,? FROM inventory_balances WHERE site=? AND channel=? AND sku=?").bind(makeId("move"),receiptNo,`待上架${pending}，隔离${value.quarantine}；${proofRef}`,actor.id,timestamp,leg.site,leg.channel,item.sku),
    );
  }
  const willBeComplete=sourceItems.every((item)=>Number(item.received_qty||0)+(inputMap.get(item.id)?.received??0)>=Number(item.qty));
  statements.push(db.prepare("UPDATE transport_legs SET stage=?,stage_owner=?,version=version+1,updated_at=? WHERE id=?").bind(willBeComplete?"shelf_pending":"awaiting_receipt",willBeComplete?"运营":"供应链",timestamp,legId),audit(actor,"登记目的地到仓","transport_leg",legId,{receiptNo,totalReceived,totalQuarantine,complete:willBeComplete,proofRef,note}));
  await db.batch(statements);
  return Response.json({ok:true,receiptId,totalReceived,totalQuarantine,stage:willBeComplete?"shelf_pending":"awaiting_receipt"});
}

async function confirmTransportShelf(actor:Actor,payload:AnyRow){
  requireBusinessPermission(actor,"transport.shelf");
  const legItemId=cleanText(payload.legItemId||payload.id,120),shelvedQty=int(payload.shelvedQty),listingRef=cleanText(payload.listingRef,240),note=cleanText(payload.note,500);
  if(!legItemId||!Number.isInteger(shelvedQty)||shelvedQty<=0||!listingRef) throw new HttpError(400,"请填写上架数量和平台上架凭证");
  const db=database(),item=await db.prepare("SELECT li.*,l.site,l.channel,l.id leg_id,l.batch_id,l.stage,bi.name FROM transport_leg_items li JOIN transport_legs l ON l.id=li.leg_id JOIN transport_batch_items bi ON bi.id=li.batch_item_id WHERE li.id=?").bind(legItemId).first<AnyRow>();
  if(!item||item.stage!=="shelf_pending") throw new HttpError(409,"该SKU当前不在待上架节点");
  requireScope(actor,item.site,item.channel);
  if(shelvedQty>Number(item.pending_shelf_qty||0)) throw new HttpError(409,"上架数量超过待上架数量");
  const inventory=await db.prepare("SELECT * FROM inventory_balances WHERE site=? AND channel=? AND sku=?").bind(item.site,item.channel,item.sku).first<AnyRow>();
  if(!inventory||Number(inventory.pending_shelf_qty)<shelvedQty) throw new HttpError(409,"待上架库存不足，系统已阻止重复确认");
  const timestamp=nowIso(),confirmationId=makeId("transport_shelf");
  await db.batch([
    db.prepare("INSERT INTO transport_shelf_confirmations (id,leg_item_id,shelved_qty,listing_ref,note,actor_id,confirmed_at) VALUES (?,?,?,?,?,?,?)").bind(confirmationId,legItemId,shelvedQty,listingRef,note,actor.id,timestamp),
    db.prepare("UPDATE transport_leg_items SET pending_shelf_qty=pending_shelf_qty-?,sellable_qty=sellable_qty+?,updated_at=? WHERE id=? AND pending_shelf_qty>=?").bind(shelvedQty,shelvedQty,timestamp,legItemId,shelvedQty),
    db.prepare("UPDATE inventory_balances SET pending_shelf_qty=pending_shelf_qty-?,qty=qty+?,updated_at=? WHERE site=? AND channel=? AND sku=? AND pending_shelf_qty>=?").bind(shelvedQty,shelvedQty,timestamp,item.site,item.channel,item.sku,shelvedQty),
    db.prepare("INSERT INTO inventory_movements (id,site,channel,sku,name,movement_type,qty_delta,balance_after,reference_type,reference_id,note,actor_id,created_at) SELECT ?,site,channel,sku,name,'确认上架',?,qty,'上架确认',?,?,?,? FROM inventory_balances WHERE site=? AND channel=? AND sku=?").bind(makeId("move"),shelvedQty,listingRef,note,actor.id,timestamp,item.site,item.channel,item.sku),
    audit(actor,"确认目的地SKU上架","transport_leg_item",legItemId,{shelvedQty,listingRef,note}),
  ]);
  const pending=await db.prepare("SELECT SUM(pending_shelf_qty+quarantine_qty+qty-received_qty) total FROM transport_leg_items WHERE leg_id=?").bind(item.leg_id).first<AnyRow>();
  if(Number(pending?.total||0)===0){
    await db.prepare("UPDATE transport_legs SET stage='on_shelf',stage_owner='完成',version=version+1,updated_at=? WHERE id=?").bind(timestamp,item.leg_id).run();
    const unfinished=await db.prepare("SELECT COUNT(*) total FROM transport_legs WHERE batch_id=? AND stage<>'on_shelf'").bind(item.batch_id).first<AnyRow>();
    if(Number(unfinished?.total||0)===0) await db.prepare("UPDATE transport_batches SET status='completed',updated_at=? WHERE id=?").bind(timestamp,item.batch_id).run();
  }
  return Response.json({ok:true,shelvedQty});
}

async function createShipmentBatch(actor:Actor,payload:AnyRow){
  requireBusinessPermission(actor,"shipment.create");
  const productionOrderId=cleanText(payload.productionOrderId,120),batchNo=cleanText(payload.batchNo,100).toUpperCase(),note=cleanText(payload.note,500);
  if(!batchNo||batchNo.length<3) throw new HttpError(400,"请填写有效的海运批次号");
  const db=database(),order=await db.prepare("SELECT * FROM series_production_orders WHERE id=?").bind(productionOrderId).first<AnyRow>();
  if(!order||!["completed","completed_with_variance"].includes(order.status)) throw new HttpError(409,"只有已经登记完工的系列生产单才能创建海运批次");
  if(order.qc_status!=="passed") throw new HttpError(409,"生产单尚未质检通过，不能创建海运批次");
  if(await db.prepare("SELECT id FROM shipment_batches WHERE batch_no=?").bind(batchNo).first()) throw new HttpError(409,"该海运批次号已经存在");
  const sourceItems=await all("SELECT m.*,p.allocations_json FROM series_production_order_items m JOIN series_purchase_order_items p ON p.id=m.purchase_order_item_id WHERE m.production_order_id=?",[productionOrderId]);
  const legacyShippedRows=await all("SELECT production_order_item_id,SUM(shipped_qty) shipped_qty FROM shipment_batch_items WHERE production_order_item_id IN (SELECT id FROM series_production_order_items WHERE production_order_id=?) GROUP BY production_order_item_id",[productionOrderId]);
  const transportShippedRows=await all("SELECT production_order_item_id,SUM(shipped_qty) shipped_qty FROM transport_batch_items WHERE production_order_item_id IN (SELECT id FROM series_production_order_items WHERE production_order_id=?) GROUP BY production_order_item_id",[productionOrderId]);
  const shippedMap=new Map<string,number>();
  for(const row of [...legacyShippedRows,...transportShippedRows]) shippedMap.set(row.production_order_item_id,(shippedMap.get(row.production_order_item_id)??0)+Number(row.shipped_qty||0));
  const inputMap=new Map<string,number>();
  for(const row of Array.isArray(payload.items)?payload.items:[]){const idValue=cleanText(row.id,120),qty=int(row.shippedQty);if(idValue&&Number.isInteger(qty)&&qty>0)inputMap.set(idValue,qty);}
  const selected=sourceItems.filter((item)=>inputMap.has(item.id));
  if(!selected.length) throw new HttpError(400,"本批次至少需要选择一个SKU并填写发货数量");
  for(const item of selected){
    const available=Math.max(0,Math.min(Number(item.produced_qty||0),Number(item.planned_qty||0))-(shippedMap.get(item.id)??0));
    const qty=Number(inputMap.get(item.id));
    if(qty>available) throw new HttpError(409,`${item.sku}最多还可发${available}件`);
  }
  const batchId=makeId("shipment"),timestamp=nowIso(),totalQty=selected.reduce((sum,item)=>sum+Number(inputMap.get(item.id)),0);
  const statements=[
    db.prepare("INSERT INTO shipment_batches (id,batch_no,month,production_order_id,series_name,total_shipped_qty,sku_count,stage,stage_owner,estimated_arrival_date,evidence_json,creator_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'channel_allocation','供应链',NULL,?,?,?,?)")
      .bind(batchId,batchNo,order.month,productionOrderId,order.series_name,totalQty,selected.length,JSON.stringify(note?[{stage:"batch_created",reference:batchNo,note,at:timestamp,by:actor.name,role:actor.role}]:[]),actor.id,timestamp,timestamp),
  ];
  for(const item of selected){
    const shippedQty=Number(inputMap.get(item.id)),allocations=prorateAllocations(parseJson(item.allocations_json,[]),shippedQty);
    if(!allocationMatchesTotal(shippedQty,allocations)) throw new HttpError(409,`${item.sku}无法生成对应站点分配，请检查原始需求数量`);
    statements.push(db.prepare("INSERT INTO shipment_batch_items (id,batch_id,production_order_item_id,sku,name,shipped_qty,received_qty,shelved_qty,allocations_json,created_at,updated_at) VALUES (?,?,?,?,?,?,0,0,?,?,?)")
      .bind(makeId("shipment_item"),batchId,item.id,item.sku,item.name,shippedQty,JSON.stringify(allocations),timestamp,timestamp));
  }
  statements.push(
    db.prepare("UPDATE series_purchase_orders SET status='shipping',updated_at=? WHERE id=?").bind(timestamp,order.purchase_order_id),
    audit(actor,"创建多SKU海运批次","shipment_batch",batchId,{batchNo,seriesName:order.series_name,skuCount:selected.length,totalQty,productionOrderId}),
  );
  await db.batch(statements);
  return Response.json({ok:true,batchId,batchNo,skuCount:selected.length,totalQty});
}

async function advanceShipmentBatch(actor:Actor,payload:AnyRow){
  const batchId=cleanText(payload.batchId,120),evidenceRef=cleanText(payload.evidenceRef,240),note=cleanText(payload.note,500),estimatedArrivalDate=cleanText(payload.estimatedArrivalDate,10);
  if(!evidenceRef) throw new HttpError(400,"推进海运节点必须填写业务单据或凭证编号");
  const db=database(),batch=await db.prepare("SELECT * FROM shipment_batches WHERE id=?").bind(batchId).first<AnyRow>();
  if(!batch) throw new HttpError(404,"海运批次不存在");
  const transition=SHIPMENT_FLOW[batch.stage];
  if(!transition) throw new HttpError(409,batch.stage==="awaiting_receipt"?"该批次需通过多SKU到仓登记推进":"该批次已进入上架或完成状态");
  if(!canAdvanceBatch(actor.role,batch.stage_owner,note)) throw new HttpError(403,actor.role==="管理员"?"管理员越级推进必须填写至少4个字的原因":`当前节点只能由${batch.stage_owner}推进`);
  if(transition.next==="sea_freight"&&(!/^\d{4}-\d{2}-\d{2}$/.test(estimatedArrivalDate)||estimatedArrivalDate<chinaDate())) throw new HttpError(400,"转入海运时必须填写不早于今天的预计到仓日期");
  const timestamp=nowIso(),evidence=parseJson<AnyRow[]>(batch.evidence_json,[]);
  evidence.push({stage:batch.stage,reference:evidenceRef,note,estimatedArrivalDate:estimatedArrivalDate||undefined,at:timestamp,by:actor.name,role:actor.role});
  await db.batch([
    db.prepare("UPDATE shipment_batches SET stage=?,stage_owner=?,estimated_arrival_date=CASE WHEN ?<>'' THEN ? ELSE estimated_arrival_date END,evidence_json=?,updated_at=? WHERE id=?").bind(transition.next,transition.nextOwner,estimatedArrivalDate,estimatedArrivalDate,JSON.stringify(evidence),timestamp,batchId),
    audit(actor,"推进海运批次节点","shipment_batch",batchId,{from:batch.stage,to:transition.next,evidenceRef,estimatedArrivalDate:estimatedArrivalDate||null,note}),
  ]);
  return Response.json({ok:true,stage:transition.next,stageOwner:transition.nextOwner});
}

async function updateShipmentEta(actor:Actor,payload:AnyRow){
  requireBusinessPermission(actor,"shipment.eta");
  const batchId=cleanText(payload.batchId,120),estimatedArrivalDate=cleanText(payload.estimatedArrivalDate,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(estimatedArrivalDate)||estimatedArrivalDate<chinaDate()) throw new HttpError(400,"预计到仓日期必须为今天或未来日期");
  const db=database(),batch=await db.prepare("SELECT stage,estimated_arrival_date FROM shipment_batches WHERE id=?").bind(batchId).first<AnyRow>();
  if(!batch||!["sea_freight","port_arrived","last_mile_delivery"].includes(batch.stage)) throw new HttpError(409,"只有海运、到港或派送中的批次可以更新ETA");
  const timestamp=nowIso();
  await db.batch([db.prepare("UPDATE shipment_batches SET estimated_arrival_date=?,updated_at=? WHERE id=?").bind(estimatedArrivalDate,timestamp,batchId),audit(actor,"更新海运批次ETA","shipment_batch",batchId,{from:batch.estimated_arrival_date||null,to:estimatedArrivalDate})]);
  return Response.json({ok:true,estimatedArrivalDate});
}

async function receiveShipmentBatch(actor:Actor,payload:AnyRow){
  requireBusinessPermission(actor,"inbound.receive");
  const batchId=cleanText(payload.batchId,120),receiptNo=cleanText(payload.receiptNo,100),proofRef=cleanText(payload.proofRef,240);
  if(!receiptNo||!proofRef) throw new HttpError(400,"到仓单号和到仓凭证均为必填");
  const db=database(),batch=await db.prepare("SELECT * FROM shipment_batches WHERE id=?").bind(batchId).first<AnyRow>();
  if(!batch||batch.stage!=="awaiting_receipt") throw new HttpError(409,"该海运批次当前不在等待到仓节点");
  if(await db.prepare("SELECT id FROM shipment_receipts WHERE receipt_no=?").bind(receiptNo).first()) throw new HttpError(409,"该到仓单号已经登记");
  const sourceItems=await all("SELECT * FROM shipment_batch_items WHERE batch_id=?",[batchId]);
  const previousReceiptItems=await all("SELECT i.* FROM shipment_receipt_items i JOIN shipment_receipts r ON r.id=i.receipt_id WHERE r.batch_id=?",[batchId]);
  const inputMap=new Map<string,number>();
  if(!Array.isArray(payload.items)||!payload.items.length)throw new HttpError(400,"缺少到仓明细");
  for(const row of payload.items){const idValue=cleanText(row.id,120),qty=Number(row.receivedQty);if(!idValue||!Number.isSafeInteger(qty)||qty<=0||inputMap.has(idValue)||!sourceItems.some(item=>item.id===idValue))throw new HttpError(400,"到仓明细存在未知或重复SKU、非整数数量");inputMap.set(idValue,qty);}
  const selected=sourceItems.filter((item)=>inputMap.has(item.id));
  if(!selected.length) throw new HttpError(400,"本次至少登记一个SKU的实收数量");
  for(const item of selected){const remaining=Math.max(0,Number(item.shipped_qty)-Number(item.received_qty||0));if(Number(inputMap.get(item.id))>remaining)throw new HttpError(409,`${item.sku}本次最多可收${remaining}件`);}
  const receiptId=makeId("shipment_receipt"),timestamp=nowIso(),totalQty=selected.reduce((sum,item)=>sum+Number(inputMap.get(item.id)),0);
  const statements=[db.prepare("INSERT INTO shipment_receipts (id,receipt_no,batch_id,proof_ref,total_received_qty,actor_id,received_at) VALUES (?,?,?,?,?,?,?)").bind(receiptId,receiptNo,batchId,proofRef,totalQty,actor.id,timestamp)];
  for(const item of selected){
    const planned=parseJson<Array<{site:string;channel:string;qty:number}>>(item.allocations_json,[]),used=new Map<string,number>();
    for(const previous of previousReceiptItems.filter((row)=>row.batch_item_id===item.id)) for(const allocation of parseJson<Array<{site:string;channel:string;qty:number}>>(previous.allocations_json,[])){const key=`${allocation.site}|${allocation.channel}`;used.set(key,(used.get(key)??0)+Number(allocation.qty||0));}
    const remainingAllocations=planned.map((row)=>({...row,qty:Math.max(0,Number(row.qty||0)-(used.get(`${row.site}|${row.channel}`)??0))})).filter((row)=>row.qty>0);
    const receivedQty=Number(inputMap.get(item.id)),allocations=prorateAllocations(remainingAllocations,receivedQty);
    if(!allocationMatchesTotal(receivedQty,allocations)) throw new HttpError(409,`${item.sku}实收数量无法匹配剩余站点分配`);
    statements.push(
      db.prepare("INSERT INTO shipment_receipt_items (id,receipt_id,batch_item_id,sku,received_qty,allocations_json,created_at) VALUES (?,?,?,?,?,?,?)").bind(makeId("shipment_receipt_item"),receiptId,item.id,item.sku,receivedQty,JSON.stringify(allocations),timestamp),
      db.prepare("UPDATE shipment_batch_items SET received_qty=received_qty+?,updated_at=? WHERE id=?").bind(receivedQty,timestamp,item.id),
    );
    for(const allocation of allocations) statements.push(
      db.prepare("INSERT INTO inventory_balances (site,channel,sku,name,qty,pending_shelf_qty,updated_at) VALUES (?,?,?,?,0,?,?) ON CONFLICT(site,channel,sku) DO UPDATE SET pending_shelf_qty=inventory_balances.pending_shelf_qty+excluded.pending_shelf_qty,name=CASE WHEN excluded.name<>'' THEN excluded.name ELSE inventory_balances.name END,updated_at=excluded.updated_at").bind(allocation.site,allocation.channel,item.sku,item.name,allocation.qty,timestamp),
      db.prepare("INSERT INTO inventory_movements (id,site,channel,sku,name,movement_type,qty_delta,balance_after,reference_type,reference_id,note,actor_id,created_at) SELECT ?,site,channel,sku,name,'到仓待上架',0,qty,'海运批次到仓',?,?,?,? FROM inventory_balances WHERE site=? AND channel=? AND sku=?").bind(makeId("move"),receiptNo,proofRef,actor.id,timestamp,allocation.site,allocation.channel,item.sku),
    );
  }
  const completed=sourceItems.every((item)=>Number(item.received_qty||0)+(inputMap.get(item.id)??0)>=Number(item.shipped_qty||0));
  statements.push(
    db.prepare("UPDATE shipment_batches SET stage=?,stage_owner=?,updated_at=? WHERE id=?").bind(completed?"shelf_pending":"awaiting_receipt",completed?"运营":"供应链",timestamp,batchId),
    audit(actor,"多SKU海运批次到仓","shipment_batch",batchId,{receiptNo,skuCount:selected.length,totalQty,completed,proofRef}),
  );
  await db.batch(statements);
  return Response.json({ok:true,receiptId,totalQty,completed,nextStage:completed?"shelf_pending":"awaiting_receipt"});
}

async function confirmShipmentShelf(actor:Actor,payload:AnyRow){
  requireBusinessPermission(actor,"shelf.confirm");
  const batchItemId=cleanText(payload.batchItemId,120),site=cleanText(payload.site,20),channel=cleanText(payload.channel,20),listingRef=cleanText(payload.listingRef,240),note=cleanText(payload.note,500);
  validSiteChannel(site,channel);requireScope(actor,site,channel);
  if(!listingRef||note.length<2) throw new HttpError(400,"确认上架必须填写平台凭证和说明");
  const db=database(),item=await db.prepare("SELECT i.*,b.stage,b.id batch_id FROM shipment_batch_items i JOIN shipment_batches b ON b.id=i.batch_id WHERE i.id=?").bind(batchItemId).first<AnyRow>();
  if(!item||item.stage!=="shelf_pending") throw new HttpError(409,"该SKU当前不在待上架节点");
  const allocation=parseJson<Array<{site:string;channel:string;qty:number}>>(item.allocations_json,[]).find((row)=>row.site===site&&row.channel===channel);
  if(!allocation) throw new HttpError(403,"该SKU没有分配到所选站点渠道");
  if(await db.prepare("SELECT id FROM shipment_shelf_confirmations WHERE batch_item_id=? AND site=? AND channel=?").bind(batchItemId,site,channel).first()) throw new HttpError(409,"该SKU在此站点渠道已经确认上架");
  const batchItems=await all("SELECT id,allocations_json FROM shipment_batch_items WHERE batch_id=?",[item.batch_id]);
  const confirmations=await all("SELECT c.batch_item_id,c.site,c.channel FROM shipment_shelf_confirmations c JOIN shipment_batch_items i ON i.id=c.batch_item_id WHERE i.batch_id=?",[item.batch_id]);
  const completedKeys=new Set(confirmations.map((row)=>`${row.batch_item_id}|${row.site}|${row.channel}`));completedKeys.add(`${batchItemId}|${site}|${channel}`);
  const requiredKeys=batchItems.flatMap((row)=>parseJson<Array<{site:string;channel:string;qty:number}>>(row.allocations_json,[]).map((allocation)=>`${row.id}|${allocation.site}|${allocation.channel}`));
  const completed=requiredKeys.length>0&&requiredKeys.every((key)=>completedKeys.has(key));
  const timestamp=nowIso();
  const inventory=await db.prepare("SELECT pending_shelf_qty FROM inventory_balances WHERE site=? AND channel=? AND sku=?").bind(site,channel,item.sku).first<AnyRow>();
  if(!inventory||Number(inventory.pending_shelf_qty)<Number(allocation.qty)) throw new HttpError(409,"待上架库存不足，系统已阻止重复确认");
  const statements=[
    db.prepare("INSERT INTO shipment_shelf_confirmations (id,batch_item_id,site,channel,planned_qty,shelved_qty,listing_ref,note,actor_id,confirmed_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(makeId("shipment_shelf"),batchItemId,site,channel,allocation.qty,allocation.qty,listingRef,note,actor.id,timestamp),
    db.prepare("UPDATE shipment_batch_items SET shelved_qty=shelved_qty+?,updated_at=? WHERE id=?").bind(allocation.qty,timestamp,batchItemId),
    db.prepare("UPDATE inventory_balances SET pending_shelf_qty=pending_shelf_qty-?,qty=qty+?,updated_at=? WHERE site=? AND channel=? AND sku=? AND pending_shelf_qty>=?").bind(allocation.qty,allocation.qty,timestamp,site,channel,item.sku,allocation.qty),
    db.prepare("INSERT INTO inventory_movements (id,site,channel,sku,name,movement_type,qty_delta,balance_after,reference_type,reference_id,note,actor_id,created_at) SELECT ?,site,channel,sku,name,'确认上架',?,qty,'上架确认',?,?,?,? FROM inventory_balances WHERE site=? AND channel=? AND sku=?").bind(makeId("move"),allocation.qty,listingRef,note,actor.id,timestamp,site,channel,item.sku),
    db.prepare("UPDATE shipment_batches SET stage=?,stage_owner='运营',updated_at=? WHERE id=?").bind(completed?"on_shelf":"shelf_pending",timestamp,item.batch_id),
    audit(actor,"确认批次SKU上架","shipment_batch",item.batch_id,{sku:item.sku,site,channel,qty:allocation.qty,listingRef,completed}),
  ];
  if(completed) statements.push(db.prepare("UPDATE new_product_projects SET status='completed',updated_at=? WHERE production_batch_id=(SELECT production_order_id FROM shipment_batches WHERE id=?)").bind(timestamp,item.batch_id));
  await db.batch(statements);
  return Response.json({ok:true,completed,stage:completed?"on_shelf":"shelf_pending"});
}

async function advanceBatch(actor:Actor,payload:AnyRow) {
  const batchId=cleanText(payload.batchId,100), evidenceRef=cleanText(payload.evidenceRef,240), note=cleanText(payload.note,300);
  if(!evidenceRef) throw new HttpError(400,"推进生产/运输节点必须填写凭证或单据编号");
  const db=database(), batch=await db.prepare("SELECT * FROM production_batches WHERE id=?").bind(batchId).first<AnyRow>();
  if(!batch) throw new HttpError(404,"生产批次不存在");
  const transition=BATCH_FLOW[batch.stage];
  if(!transition) throw new HttpError(409,batch.stage==="awaiting_receipt"?"该批次必须通过到仓单入库，不能直接推进":batch.stage==="shelf_pending"?"该批次需由各站点运营分别确认上架":"该批次已经完成当前流程");
  if(!canAdvanceBatch(actor.role,batch.stage_owner,note)) throw new HttpError(403,actor.role==="管理员"?"管理员越级推进必须填写至少4个字的原因":`当前节点只能由${batch.stage_owner}推进`);
  const estimatedArrivalDate=cleanText(payload.estimatedArrivalDate,10);
  if(transition.next==="sea_freight") {
    if(!/^\d{4}-\d{2}-\d{2}$/.test(estimatedArrivalDate)||estimatedArrivalDate<chinaDate()) throw new HttpError(400,"转入海运在途时，必须填写不早于今天的预计到仓日期");
  }
  const timestamp=nowIso(), evidence=parseJson<AnyRow[]>(batch.evidence_json,[]);
  evidence.push({stage:batch.stage,reference:evidenceRef,note,estimatedArrivalDate:estimatedArrivalDate||undefined,at:timestamp,by:actor.name,role:actor.role});
  await db.batch([
    db.prepare("UPDATE production_batches SET stage=?,stage_owner=?,evidence_json=?,estimated_arrival_date=CASE WHEN ?<>'' THEN ? ELSE estimated_arrival_date END,updated_at=? WHERE id=?").bind(transition.next,transition.nextOwner,JSON.stringify(evidence),estimatedArrivalDate,estimatedArrivalDate,timestamp,batchId),
    audit(actor,"推进生产运输节点","production_batch",batchId,{from:batch.stage,to:transition.next,evidenceRef,note,estimatedArrivalDate:estimatedArrivalDate||null}),
  ]);
  return Response.json({ok:true,stage:transition.next,stageOwner:transition.nextOwner});
}

async function updateBatchEta(actor:Actor,payload:AnyRow) {
  requireBusinessPermission(actor,"shipment.eta");
  const batchId=cleanText(payload.batchId,100),estimatedArrivalDate=cleanText(payload.estimatedArrivalDate,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(estimatedArrivalDate)||estimatedArrivalDate<chinaDate()) throw new HttpError(400,"预计到仓日期必须为今天或未来日期");
  const db=database(),batch=await db.prepare("SELECT stage,estimated_arrival_date FROM production_batches WHERE id=?").bind(batchId).first<AnyRow>();
  if(!batch) throw new HttpError(404,"生产批次不存在");
  if(!["sea_freight","port_arrived","last_mile_delivery"].includes(batch.stage)) throw new HttpError(409,"只有海运、到港或派送中的批次可以更新预计到仓日期");
  const timestamp=nowIso();
  await db.batch([
    db.prepare("UPDATE production_batches SET estimated_arrival_date=?,updated_at=? WHERE id=?").bind(estimatedArrivalDate,timestamp,batchId),
    audit(actor,"更新海运预计到仓日期","production_batch",batchId,{from:batch.estimated_arrival_date||null,to:estimatedArrivalDate}),
  ]);
  return Response.json({ok:true,estimatedArrivalDate});
}

async function confirmBatchShelf(actor:Actor,payload:AnyRow) {
  requireBusinessPermission(actor,"shelf.confirm");
  const batchId=cleanText(payload.batchId,100),site=cleanText(payload.site,20),channel=cleanText(payload.channel,20);
  const listingRef=cleanText(payload.listingRef,240),note=cleanText(payload.note,300);
  validSiteChannel(site,channel);requireScope(actor,site,channel);
  if(!listingRef||note.length<2) throw new HttpError(400,"确认上架必须填写平台上架凭证和说明");
  const db=database(),batch=await db.prepare("SELECT * FROM production_batches WHERE id=?").bind(batchId).first<AnyRow>();
  if(!batch) throw new HttpError(404,"生产批次不存在");
  if(batch.stage!=="shelf_pending") throw new HttpError(409,"该批次当前不在待上架节点");
  const allocations=parseJson<Array<{site:string;channel:string;qty:number}>>(batch.allocations_json,[]);
  if(!allocations.some((row)=>row.site===site&&row.channel===channel)) throw new HttpError(403,"该批次没有分配到所选站点渠道");
  const evidence=parseJson<AnyRow[]>(batch.evidence_json,[]);
  if(evidence.some((row)=>row.stage==="on_shelf"&&row.site===site&&row.channel===channel)) throw new HttpError(409,"该站点渠道已经确认上架");
  const timestamp=nowIso();
  const scopeAllocation=allocations.find((row)=>row.site===site&&row.channel===channel)!;
  const inventory=await db.prepare("SELECT pending_shelf_qty FROM inventory_balances WHERE site=? AND channel=? AND sku=?").bind(site,channel,batch.sku).first<AnyRow>();
  if(!inventory||Number(inventory.pending_shelf_qty)<Number(scopeAllocation.qty)) throw new HttpError(409,"待上架库存不足，系统已阻止重复确认");
  evidence.push({stage:"on_shelf",site,channel,reference:listingRef,note,at:timestamp,by:actor.name,role:actor.role});
  const completed=shelfScopesComplete(allocations,evidence);
  const statements=[
    db.prepare("UPDATE production_batches SET stage=?,stage_owner='运营',evidence_json=?,updated_at=? WHERE id=?").bind(completed?"on_shelf":"shelf_pending",JSON.stringify(evidence),timestamp,batchId),
    db.prepare("UPDATE inventory_balances SET pending_shelf_qty=pending_shelf_qty-?,qty=qty+?,updated_at=? WHERE site=? AND channel=? AND sku=? AND pending_shelf_qty>=?").bind(scopeAllocation.qty,scopeAllocation.qty,timestamp,site,channel,batch.sku,scopeAllocation.qty),
    db.prepare("INSERT INTO inventory_movements (id,site,channel,sku,name,movement_type,qty_delta,balance_after,reference_type,reference_id,note,actor_id,created_at) SELECT ?,site,channel,sku,name,'确认上架',?,qty,'上架确认',?,?,?,? FROM inventory_balances WHERE site=? AND channel=? AND sku=?").bind(makeId("move"),scopeAllocation.qty,listingRef,note,actor.id,timestamp,site,channel,batch.sku),
    audit(actor,"确认站点渠道上架","production_batch",batchId,{site,channel,listingRef,note,completed}),
  ];
  if(completed) statements.push(db.prepare("UPDATE new_product_projects SET status='completed',updated_at=? WHERE production_batch_id=?").bind(timestamp,batchId));
  await db.batch(statements);
  return Response.json({ok:true,completed,stage:completed?"on_shelf":"shelf_pending"});
}

async function startNewProductTest(actor:Actor,payload:AnyRow) {
  requireBusinessPermission(actor,"new_product.start");
  const cycleMonth=cleanText(payload.cycleMonth,7),sku=cleanSku(payload.sku),name=cleanText(payload.name,120);
  const firstBatchQty=int(payload.firstBatchQty);
  if(cycleMonth!==monthKey()) throw new HttpError(400,"只能发起当前月份的新品测试");
  if(Number(chinaDate().slice(8,10))<7) throw new HttpError(409,"新品测试固定从每月7号开始，当前尚未到发起日期");
  if(!sku||!name||!Number.isInteger(firstBatchQty)||firstBatchQty<1||firstBatchQty>100000) throw new HttpError(400,"请填写有效的新品SKU、名称和首批计划数量");
  const idValue=`NPI-${cycleMonth}-${sku}`,timestamp=nowIso();
  const history=[{action:"管理员发起",stage:"selection",at:timestamp,by:actor.name,note:"进入选款立项"}];
  try{
    await database().batch([
      database().prepare("INSERT INTO new_product_projects (id,cycle_month,sku,name,first_batch_qty,stage,status,stage_started_at,current_due_at,production_batch_id,abandon_reason,decision_history_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,'selection','active',?,?,NULL,'',?,?,?,?)")
        .bind(idValue,cycleMonth,sku,name,firstBatchQty,timestamp,dueAfter(3),JSON.stringify(history),actor.id,timestamp,timestamp),
      database().prepare("INSERT INTO sku_settings (sku,name,product_type,unit_price,lead_time_days,safety_pct,updated_at) VALUES (?,?,'新品',0,63,.25,?) ON CONFLICT(sku) DO UPDATE SET name=excluded.name,product_type='新品',updated_at=excluded.updated_at").bind(sku,name,timestamp),
      audit(actor,"发起每月新品测试","new_product_project",idValue,{cycleMonth,sku,name,firstBatchQty,dueAt:dueAfter(3)}),
    ]);
  }catch(error){
    if(String(error).includes("UNIQUE")) throw new HttpError(409,"该SKU本月已经发起过新品测试");
    throw error;
  }
  return Response.json({ok:true,projectId:idValue});
}

async function submitNewProductStage(actor:Actor,payload:AnyRow) {
  const projectId=cleanText(payload.projectId,120),stageKey=cleanText(payload.stageKey,30),conclusion=cleanText(payload.conclusion,160);
  const db=database(),project=await db.prepare("SELECT * FROM new_product_projects WHERE id=?").bind(projectId).first<AnyRow>();
  if(!project||project.status!=="active") throw new HttpError(404,"新品项目不存在或已经结束");
  let scopeKey="global",site:string|null=null,channel:string|null=null,data:AnyRow={};
  if(stageKey==="candidate"){
    requireBusinessPermission(actor,"new_product.candidate");
    if(project.stage!=="selection") throw new HttpError(409,"当前项目不在选款立项阶段");
    const developerReason=cleanText(payload.developerReason,800),evidenceRef=cleanText(payload.evidenceRef,240);
    if(developerReason.length<5) throw new HttpError(400,"请填写市场趋势、竞品对标或客户反馈等开发理由");
    data={developerReason,evidenceRef};
  }else if(stageKey==="research"){
    requireBusinessPermission(actor,"new_product.research");
    if(project.stage!=="parallel_test") throw new HttpError(409,"当前项目不在运营调研阶段");
    site=cleanText(payload.site,20);channel=cleanText(payload.channel,20);validSiteChannel(site,channel);requireScope(actor,site,channel);
    if(!REQUIRED_MONTHLY_SCOPES.some((row)=>row.site===site&&row.channel===channel)) throw new HttpError(400,"新品调研仅统计五站TikTok和Shopee");
    scopeKey=`${site}|${channel}`;
    const sellingStatus=cleanText(payload.sellingStatus,20),competitorCount=int(payload.competitorCount),priceMin=Number(payload.priceMin),priceMax=Number(payload.priceMax),estimatedMonthlySales=int(payload.estimatedMonthlySales);
    const competitorLinks=cleanText(payload.competitorLinks,1600);
    if(!["已有人销售","暂未发现","不确定"].includes(sellingStatus)||competitorCount<0||priceMin<0||priceMax<priceMin||estimatedMonthlySales<0||conclusion.length<2) throw new HttpError(400,"请完整填写平台竞争、价格带、预估销量和调研结论");
    data={sellingStatus,competitorCount,priceMin,priceMax,estimatedMonthlySales,competitorLinks};
  }else if(stageKey==="seeding"){
    requireBusinessPermission(actor,"new_product.seeding");
    if(project.stage!=="parallel_test") throw new HttpError(409,"当前项目不在内容种草测试阶段");
    site=cleanText(payload.site,20);channel=cleanText(payload.channel,20);validSiteChannel(site,channel);requireScope(actor,site,channel);
    if(!REQUIRED_MONTHLY_SCOPES.some((row)=>row.site===site&&row.channel===channel)) throw new HttpError(400,"新品种草仅统计五站TikTok和Shopee");
    scopeKey=`${site}|${channel}`;
    const contentCount=int(payload.contentCount),views=int(payload.views),likes=int(payload.likes),comments=int(payload.comments),addToCart=int(payload.addToCart),inquiries=int(payload.inquiries);
    if(contentCount<1||[views,likes,comments,addToCart,inquiries].some((value)=>value<0)||conclusion.length<2) throw new HttpError(400,"请完整填写内容数量、互动数据和测试结论");
    data={contentCount,views,likes,comments,addToCart,inquiries,engagementRate:views>0?(likes+comments)/views:0,cartRate:views>0?addToCart/views:0};
  }else if(stageKey==="finance"){
    requireBusinessPermission(actor,"new_product.finance");
    if(project.stage!=="finance") throw new HttpError(409,"当前项目不在财务测算阶段");
    const currency=cleanText(payload.currency,10)||"CNY",exchangeRateToCny=Number(payload.exchangeRateToCny??1),materialCost=Number(payload.materialCost),unitCost=Number(payload.unitCost),plannedPrice=Number(payload.plannedPrice),platformFeeRate=Number(payload.platformFeeRate),paymentFeeRate=Number(payload.paymentFeeRate??0),refundRate=Number(payload.refundRate??0),taxRate=Number(payload.taxRate??0),importDutyRate=Number(payload.importDutyRate??0),logisticsCost=Number(payload.logisticsCost),adCost=Number(payload.adCost),fixedCost=Number(payload.fixedCost),targetGrossMarginRate=Number(payload.targetGrossMarginRate);
    const rates=[platformFeeRate,paymentFeeRate,refundRate,taxRate,importDutyRate];
    if(!currency||!Number.isFinite(exchangeRateToCny)||exchangeRateToCny<=0||[materialCost,unitCost,logisticsCost,adCost,fixedCost].some((value)=>!Number.isFinite(value)||value<0)||!Number.isFinite(plannedPrice)||plannedPrice<=0||rates.some(value=>!Number.isFinite(value)||value<0||value>=1)||!Number.isFinite(targetGrossMarginRate)||targetGrossMarginRate<=0||targetGrossMarginRate>=1) throw new HttpError(400,"财务测算参数不完整或不合法");
    const priceCny=plannedPrice*exchangeRateToCny,landedUnitCost=unitCost+logisticsCost+unitCost*importDutyRate,netRevenue=priceCny*(1-refundRate-taxRate),contribution=netRevenue-priceCny*(platformFeeRate+paymentFeeRate)-landedUnitCost-adCost;
    data={currency,exchangeRateToCny,materialCost,unitCost,plannedPrice,priceCny,platformFeeRate,paymentFeeRate,refundRate,taxRate,importDutyRate,logisticsCost,landedUnitCost,adCost,fixedCost,targetGrossMarginRate,netRevenue,grossMarginRate:contribution/priceCny,contribution,breakEvenQty:contribution>0?Math.ceil(fixedCost/contribution):null};
  }else if(stageKey==="sample"){
    requireBusinessPermission(actor,"new_product.sample");
    if(project.stage!=="sample") throw new HttpError(409,"当前项目不在打板确认阶段");
    const sampleRef=cleanText(payload.sampleRef,240),appearanceResult=cleanText(payload.appearanceResult,20),qualityResult=cleanText(payload.qualityResult,20),note=cleanText(payload.note,500);
    if(!sampleRef||!["通过","不通过"].includes(appearanceResult)||!["通过","不通过"].includes(qualityResult)||note.length<2) throw new HttpError(400,"请填写样品编号、外观结果、质量结果和确认说明");
    data={sampleRef,appearanceResult,qualityResult,note};
  }else if(stageKey==="sample_development"||stageKey==="sample_operations"){
    requireBusinessPermission(actor,stageKey==="sample_development"?"new_product.sample_development":"new_product.sample_operations");
    if(project.stage!=="sample") throw new HttpError(409,"当前项目不在打板确认阶段");
    const confirmationNote=cleanText(payload.confirmationNote,500);
    if(confirmationNote.length<2) throw new HttpError(400,"请填写确认意见");
    const sample=await db.prepare("SELECT version,data_json FROM new_product_stage_records WHERE project_id=? AND stage_key='sample' AND scope_key='global'").bind(projectId).first<AnyRow>();
    if(!sample)throw new HttpError(409,"请先提交当前样品后再确认");
    const sampleData=parseJson<AnyRow>(sample.data_json,{});
    if(sampleData.appearanceResult!=="通过"||sampleData.qualityResult!=="通过")throw new HttpError(409,"当前样品外观和质量必须通过");
    data={confirmed:true,confirmationNote,sourceVersion:Number(sample.version)};
  }else throw new HttpError(400,"未知新品阶段");
  const timestamp=nowIso(),recordId=makeId("npi_stage");
  const previous=await db.prepare("SELECT version,source_version,data_json FROM new_product_stage_records WHERE project_id=? AND stage_key=? AND scope_key=?").bind(projectId,stageKey,scopeKey).first<AnyRow>();
  const statements=[
    guardStatement(db,actor,"submitNewProductStage","EXISTS (SELECT 1 FROM new_product_projects WHERE id=? AND stage=? AND version=? AND status='active')",[projectId,project.stage,project.version]),
    db.prepare("UPDATE new_product_projects SET version=version+1,updated_at=? WHERE id=?").bind(timestamp,projectId),
    db.prepare("INSERT INTO new_product_stage_records (id,project_id,stage_key,scope_key,site,channel,status,data_json,conclusion,actor_id,actor_name,submitted_at,updated_at,source_version) VALUES (?,?,?,?,?,?,'submitted',?,?,?,?,?,?,?) ON CONFLICT(project_id,stage_key,scope_key) DO UPDATE SET version=new_product_stage_records.version+1,source_version=excluded.source_version,data_json=excluded.data_json,conclusion=excluded.conclusion,actor_id=excluded.actor_id,actor_name=excluded.actor_name,submitted_at=excluded.submitted_at,updated_at=excluded.updated_at")
      .bind(recordId,projectId,stageKey,scopeKey,site,channel,JSON.stringify(data),conclusion,actor.id,actor.name,timestamp,timestamp,stageKey==="finance"?project.finance_revision:(data.sourceVersion??null)),
    audit(actor,"提交新品阶段数据","new_product_project",projectId,{stageKey,scopeKey,conclusion,version:Number(previous?.version||0)+1,previous:previous?{...previous,data:parseJson(previous.data_json,{})}:null,data}),
  ];
  if(stageKey==="finance"){
    const researchRows=await all("SELECT data_json FROM new_product_stage_records WHERE project_id=? AND stage_key='research'",[projectId]);
    const demand=researchRows.length?researchRows.reduce((sum,row)=>sum+Number(parseJson<AnyRow>(row.data_json,{}).estimatedMonthlySales||0),0)/researchRows.length:0;
    const setting=await db.prepare("SELECT min_order_qty,order_multiple FROM sku_settings WHERE sku=?").bind(project.sku).first<AnyRow>();
    const recommendation=roundSupplyQuantity(Math.max(1,Math.ceil(demand*.45)),Number(setting?.min_order_qty||1),Number(setting?.order_multiple||1));
    statements.push(db.prepare("UPDATE new_product_projects SET recommended_first_batch_qty=?,updated_at=? WHERE id=?").bind(recommendation,timestamp,projectId));
  }
  await atomicBatch(db,statements);
  return Response.json({ok:true,stageKey,scopeKey,data});
}

async function decideNewProduct(actor:Actor,payload:AnyRow) {
  const projectId=cleanText(payload.projectId,120),decision=cleanText(payload.decision,20),note=cleanText(payload.note,500);
  if(!["continue","abandon","reprice"].includes(decision)||note.length<3) throw new HttpError(400,"请选择继续、放弃或重新定价，并填写决策理由");
  const db=database(),project=await db.prepare("SELECT * FROM new_product_projects WHERE id=?").bind(projectId).first<AnyRow>();
  if(!project||project.status!=="active") throw new HttpError(404,"新品项目不存在或已经结束");
  const history=parseJson<AnyRow[]>(project.decision_history_json,[]),timestamp=nowIso();
  const statements:Array<ReturnType<D1Database["prepare"]>>=[guardStatement(db,actor,"decideNewProduct","EXISTS (SELECT 1 FROM new_product_projects WHERE id=? AND stage=? AND version=? AND status='active')",[projectId,project.stage,project.version])];
  let nextStage=project.stage,nextStatus="active",dueAt=project.current_due_at,productionBatchId=project.production_batch_id||null;
  if(project.stage==="selection"){
    requireBusinessPermission(actor,"new_product.decide_admin");
    const candidate=await db.prepare("SELECT id FROM new_product_stage_records WHERE project_id=? AND stage_key='candidate' AND scope_key='global'").bind(projectId).first();
    if(decision==="continue"&&!candidate) throw new HttpError(409,"新品开发尚未提交候选款开发理由");
    if(decision==="continue"){nextStage="parallel_test";dueAt=dueAfter(7);} else if(decision==="abandon"){nextStage="abandoned";nextStatus="abandoned";} else throw new HttpError(400,"选款阶段不支持重新定价");
  }else if(project.stage==="parallel_test"){
    requireBusinessPermission(actor,"new_product.decide_test");
    if(decision==="continue"){
      const counts=await all("SELECT stage_key,COUNT(DISTINCT scope_key) total FROM new_product_stage_records WHERE project_id=? AND stage_key IN ('research','seeding') GROUP BY stage_key",[projectId]);
      const research=Number(counts.find((row)=>row.stage_key==="research")?.total??0),seeding=Number(counts.find((row)=>row.stage_key==="seeding")?.total??0);
      if(!newProductScopeGate({researchCount:research,seedingCount:seeding,requiredCount:REQUIRED_MONTHLY_SCOPES.length})) throw new HttpError(409,`五站双渠道数据未齐：调研${research}/10，种草${seeding}/10`);
      nextStage="finance";dueAt=dueAfter(2);
    }else if(decision==="abandon"){nextStage="abandoned";nextStatus="abandoned";} else throw new HttpError(400,"测试阶段不支持重新定价");
  }else if(project.stage==="finance"){
    requireBusinessPermission(actor,"new_product.decide_admin");
    const finance=await db.prepare("SELECT data_json,source_version FROM new_product_stage_records WHERE project_id=? AND stage_key='finance' AND scope_key='global'").bind(projectId).first<AnyRow>();
    if(!finance) throw new HttpError(409,"财务尚未提交测算结果");
    if(decision==="continue"){
      if(Number(finance.source_version)!==Number(project.finance_revision))throw new HttpError(409,"重新定价后需财务重新提交本轮测算");
      const numbers=parseJson<AnyRow>(finance.data_json,{});
      if(!financeGatePasses(numbers)) throw new HttpError(409,"测算毛利率低于本项目目标，请选择重新定价或放弃");
      nextStage="sample";dueAt=dueAfter(10);
    }else if(decision==="reprice"){nextStage="finance";dueAt=dueAfter(2);statements.push(db.prepare("UPDATE new_product_projects SET finance_revision=finance_revision+1 WHERE id=?").bind(projectId));} else {nextStage="abandoned";nextStatus="abandoned";}
  }else if(project.stage==="sample"){
    requireBusinessPermission(actor,"new_product.decide_admin");
    if(decision==="continue"){
      const sample=await db.prepare("SELECT data_json,version FROM new_product_stage_records WHERE project_id=? AND stage_key='sample' AND scope_key='global'").bind(projectId).first<AnyRow>();
      if(!sample) throw new HttpError(409,"工厂尚未提交打板结果");
      const sampleData=parseJson<AnyRow>(sample.data_json,{});
      const confirmations=await all("SELECT stage_key FROM new_product_stage_records WHERE project_id=? AND source_version=? AND stage_key IN ('sample_development','sample_operations')",[projectId,Number(sample.version)]);
      if(!sampleGateReady(sampleData,confirmations.map((row)=>String(row.stage_key)))) throw new HttpError(409,"外观、质量、新品开发和运营主管必须分别确认通过");
      const finalFirstBatchQty=int(payload.finalFirstBatchQty??project.first_batch_qty);
      if(!Number.isInteger(finalFirstBatchQty)||finalFirstBatchQty<1||finalFirstBatchQty>100000) throw new HttpError(400,"最终首批数量无效");
      const allocations=Array.isArray(payload.allocations)?payload.allocations.map((row:AnyRow)=>({site:cleanText(row.site,20),channel:cleanText(row.channel,20),qty:int(row.qty)})):[];
      const scopes=new Set<string>();
      for(const row of allocations){validSiteChannel(row.site,row.channel);if(!REQUIRED_MONTHLY_SCOPES.some((scope)=>scope.site===row.site&&scope.channel===row.channel)||row.qty<=0) throw new HttpError(400,"首批分配只允许五站TikTok和Shopee，且数量必须大于0");const key=`${row.site}|${row.channel}`;if(scopes.has(key)) throw new HttpError(400,"首批分配存在重复站点渠道");scopes.add(key);}
      if(!allocations.length||!allocationMatchesTotal(finalFirstBatchQty,allocations)) throw new HttpError(409,`首批渠道分配合计必须等于${finalFirstBatchQty}件`);
      const setting=await db.prepare("SELECT product_series,supplier_name,factory_name FROM sku_settings WHERE sku=?").bind(project.sku).first<AnyRow>();
      const seriesName=setting&&cleanText(setting.product_series,120)&&setting.product_series!=="待归类"?cleanText(setting.product_series,120):project.name;
      const supplierName=cleanText(setting?.supplier_name,120),factoryName=cleanText(setting?.factory_name,120);
      const supplier=await db.prepare("SELECT id FROM business_partners WHERE type='supplier' AND name=? AND active=1").bind(supplierName).first();
      const factory=await db.prepare("SELECT assigned_user_id FROM business_partners WHERE type='factory' AND name=? AND active=1").bind(factoryName).first<AnyRow>();
      if(!supplier||!factory?.assigned_user_id) throw new HttpError(409,"新品SKU需先维护启用中的供应商、工厂并绑定工厂账号");
      const supplyId=await resolveSupplyUser(payload.supplyUserId,null);
      const purchaseOrderId=makeId("npi_po"),purchaseItemId=makeId("npi_po_item"),productionOrderId=makeId("npi_mo"),productionItemId=makeId("npi_mo_item");
      productionBatchId=productionOrderId;
      statements.push(
        db.prepare("UPDATE new_product_projects SET first_batch_qty=? WHERE id=?").bind(finalFirstBatchQty,projectId),
        db.prepare("INSERT INTO series_purchase_orders (id,month,series_name,supplier_name,factory_name,status,total_qty,sku_count,approval_id,creator_id,assigned_supply_user_id,created_at,updated_at) VALUES (?,?,?,?,?,'draft',?,1,?,?,?,?,?)").bind(purchaseOrderId,project.cycle_month,seriesName,supplierName,factoryName,finalFirstBatchQty,project.id,project.created_by,supplyId,timestamp,timestamp),
        db.prepare("INSERT INTO series_purchase_order_items (id,purchase_order_id,sku,name,ordered_qty,allocations_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").bind(purchaseItemId,purchaseOrderId,project.sku,project.name,finalFirstBatchQty,JSON.stringify(allocations),timestamp,timestamp),
        db.prepare("INSERT INTO series_production_orders (id,purchase_order_id,month,series_name,factory_name,status,total_planned_qty,total_produced_qty,evidence_json,creator_id,assigned_user_id,progress_pct,qc_status,started_at,completed_at,created_at,updated_at) VALUES (?,?,?,?,?,'awaiting_order',?,0,?,?,?,0,'pending',NULL,NULL,?,?)").bind(productionOrderId,purchaseOrderId,project.cycle_month,seriesName,factoryName,finalFirstBatchQty,JSON.stringify([{stage:"sample",reference:sampleData.sampleRef,note,at:timestamp,by:actor.name,role:actor.role}]),project.created_by,factory.assigned_user_id,timestamp,timestamp),
        db.prepare("INSERT INTO series_production_order_items (id,production_order_id,purchase_order_item_id,sku,name,planned_qty,produced_qty,created_at,updated_at) VALUES (?,?,?,?,?,?,0,?,?)").bind(productionItemId,productionOrderId,purchaseItemId,project.sku,project.name,finalFirstBatchQty,timestamp,timestamp),
      );
      nextStage="production";dueAt=dueAfter(33);
    }else if(decision==="abandon"){nextStage="abandoned";nextStatus="abandoned";} else throw new HttpError(400,"打板阶段不支持重新定价");
  }else throw new HttpError(409,"当前新品项目无需再做阶段决策");
  history.push({action:decision==="continue"?"继续":decision==="reprice"?"重新定价":"放弃",stage:project.stage,at:timestamp,by:actor.name,note});
  statements.push(db.prepare("UPDATE new_product_projects SET version=version+1,stage=?,status=?,stage_started_at=?,current_due_at=?,production_batch_id=?,abandon_reason=?,decision_history_json=?,updated_at=? WHERE id=?")
    .bind(nextStage,nextStatus,timestamp,dueAt,productionBatchId,nextStatus==="abandoned"?note:"",JSON.stringify(history),timestamp,projectId));
  statements.push(audit(actor,"新品阶段决策","new_product_project",projectId,{from:project.stage,to:nextStage,decision,note,productionBatchId}));
  await atomicBatch(db,statements);
  return Response.json({ok:true,stage:nextStage,status:nextStatus,productionBatchId});
}

async function assignUser(actor:Actor,payload:AnyRow) {
  requireBusinessPermission(actor,"user.manage");
  const userId=cleanText(payload.userId,160), role=cleanText(payload.role,20), site=cleanText(payload.site,20)||null, channel=cleanText(payload.channel,20)||null;
  const responsibilityUnit=cleanText(payload.responsibilityUnit,120)||null;
  if(!ROLES.includes(role as Role)) throw new HttpError(400,"角色无效");
  if(role==="运营"){
    if(!site||!channel) throw new HttpError(400,"运营角色必须绑定站点和渠道");
    validSiteChannel(site,channel);
  }
  const active=payload.active===false?0:1;
  const db=database(),target=await db.prepare("SELECT role,active FROM users WHERE id=?").bind(userId).first<AnyRow>();
  if(!target) throw new HttpError(404,"账号不存在；请让该成员先登录一次系统");
  if(userId===actor.id&&(role!=="管理员"||!active)) throw new HttpError(400,"不能降低或停用当前登录的管理员账号");
  if(target.role==="管理员"&&(role!=="管理员"||!active)){
    const admins=await db.prepare("SELECT COUNT(*) total FROM users WHERE role='管理员' AND active=1").first<AnyRow>();
    if(Number(admins?.total||0)<=1) throw new HttpError(400,"系统必须至少保留一个启用中的管理员账号");
  }
  const result=await db.prepare("UPDATE users SET role=?,site=?,channel=?,responsibility_unit=?,active=?,updated_at=? WHERE id=?").bind(role,role==="销售"?"印尼":role==="运营"?site:null,role==="销售"?"线下分销":role==="运营"?channel:null,responsibilityUnit,active,nowIso(),userId).run();
  if(!result.meta.changes) throw new HttpError(404,"账号不存在；请让该成员先登录一次系统");
  await audit(actor,"调整账号权限","user",userId,{role,site,channel,responsibilityUnit,active}).run();
  return Response.json({ok:true});
}

async function saveSkuSetting(actor:Actor,payload:AnyRow) {
  requireBusinessPermission(actor,"sku.manage");
  const sku=cleanSku(payload.sku),name=cleanText(payload.name,120),productType=cleanText(payload.productType,20)||"老款";
  const productSeries=cleanText(payload.productSeries,120),supplierName=cleanText(payload.supplierName,120),factoryName=cleanText(payload.factoryName,120);
  const unitPrice=Number(payload.unitPrice),productionLeadDays=int(payload.productionLeadDays),seaLeadDays=int(payload.seaLeadDays),reviewCycleDays=int(payload.reviewCycleDays),serviceLevel=Number(payload.serviceLevel);
  const minOrderQty=int(payload.minOrderQty??1),orderMultiple=int(payload.orderMultiple??1),cartonQty=int(payload.cartonQty??1),unitVolumeCbm=Number(payload.unitVolumeCbm??0);
  const allowedServiceLevels=[.9,.95,.98,.99];
  if(!sku||!productSeries||productSeries==="待归类"||!supplierName||!factoryName||!Number.isFinite(unitPrice)||unitPrice<0||!Number.isInteger(productionLeadDays)||productionLeadDays<1||productionLeadDays>180||!Number.isInteger(seaLeadDays)||seaLeadDays<1||seaLeadDays>180||!Number.isInteger(reviewCycleDays)||reviewCycleDays<1||reviewCycleDays>30||!allowedServiceLevels.includes(serviceLevel)||!Number.isInteger(minOrderQty)||minOrderQty<1||!Number.isInteger(orderMultiple)||orderMultiple<1||!Number.isInteger(cartonQty)||cartonQty<1||!Number.isFinite(unitVolumeCbm)||unitVolumeCbm<0) throw new HttpError(400,"请完整填写系列、供应商、工厂、MOQ、下单倍数和供应参数");
  const db=database();
  const supplier=await db.prepare("SELECT id FROM business_partners WHERE type='supplier' AND name=? AND active=1").bind(supplierName).first();
  const factory=await db.prepare("SELECT id FROM business_partners WHERE type='factory' AND name=? AND active=1").bind(factoryName).first();
  if(!supplier||!factory) throw new HttpError(409,"供应商或工厂不在启用中的主数据，请先维护主数据");
  const leadTimeDays=productionLeadDays+seaLeadDays;
  const timestamp=nowIso();
  await db.batch([
    db.prepare("INSERT INTO sku_settings (sku,name,product_series,supplier_name,factory_name,product_type,unit_price,lead_time_days,safety_pct,production_lead_days,sea_lead_days,review_cycle_days,service_level,min_order_qty,order_multiple,carton_qty,unit_volume_cbm,updated_at) VALUES (?,?,?,?,?,?,?,?,.25,?,?,?,?,?,?,?,?,?) ON CONFLICT(sku) DO UPDATE SET name=excluded.name,product_series=excluded.product_series,supplier_name=excluded.supplier_name,factory_name=excluded.factory_name,product_type=excluded.product_type,unit_price=excluded.unit_price,lead_time_days=excluded.lead_time_days,production_lead_days=excluded.production_lead_days,sea_lead_days=excluded.sea_lead_days,review_cycle_days=excluded.review_cycle_days,service_level=excluded.service_level,min_order_qty=excluded.min_order_qty,order_multiple=excluded.order_multiple,carton_qty=excluded.carton_qty,unit_volume_cbm=excluded.unit_volume_cbm,updated_at=excluded.updated_at").bind(sku,name,productSeries,supplierName,factoryName,productType,unitPrice,leadTimeDays,productionLeadDays,seaLeadDays,reviewCycleDays,serviceLevel,minOrderQty,orderMultiple,cartonQty,unitVolumeCbm,timestamp),
    audit(actor,"维护SKU系列与供应参数","sku",sku,{name,productSeries,supplierName,factoryName,productType,unitPrice,productionLeadDays,seaLeadDays,reviewCycleDays,serviceLevel}),
  ]);
  return Response.json({ok:true});
}

async function saveBusinessPartner(actor:Actor,payload:AnyRow){
  requireBusinessPermission(actor,"master.manage");
  const idValue=cleanText(payload.id,120),type=cleanText(payload.type,20),code=cleanText(payload.code,50).toUpperCase(),name=cleanText(payload.name,120),contact=cleanText(payload.contact,240),assignedUserId=cleanText(payload.assignedUserId,160)||null,defaultLeadDays=int(payload.defaultLeadDays??0),active=payload.active===false?0:1;
  if(!["supplier","factory","carrier"].includes(type)||!code||!name||!Number.isInteger(defaultLeadDays)||defaultLeadDays<0||defaultLeadDays>365) throw new HttpError(400,"请完整填写合作方类型、编码、名称和默认交期");
  const db=database();
  if(["factory","carrier"].includes(type)&&!assignedUserId) throw new HttpError(400,"工厂和承运商必须绑定具体系统账号");
  if(assignedUserId){
    const user=await db.prepare("SELECT role,active FROM users WHERE id=?").bind(assignedUserId).first<AnyRow>(),requiredRole=type==="factory"?"工厂":type==="carrier"?"海运":"供应链";
    if(!user||!Number(user.active)||user.role!==requiredRole) throw new HttpError(409,`${name}需要绑定一个启用中的${requiredRole}账号`);
  }
  const timestamp=nowIso(),targetId=idValue||makeId("partner");
  if(idValue){
    const result=await db.prepare("UPDATE business_partners SET type=?,code=?,name=?,contact=?,default_lead_days=?,assigned_user_id=?,active=?,updated_at=? WHERE id=?").bind(type,code,name,contact,defaultLeadDays,assignedUserId,active,timestamp,idValue).run();
    if(!result.meta.changes) throw new HttpError(404,"合作方不存在");
  }else await db.prepare("INSERT INTO business_partners (id,type,code,name,contact,default_lead_days,assigned_user_id,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(targetId,type,code,name,contact,defaultLeadDays,assignedUserId,active,timestamp,timestamp).run();
  await audit(actor,"维护合作方主数据","business_partner",targetId,{type,code,name,assignedUserId,active}).run();
  return Response.json({ok:true,id:targetId});
}

async function saveWarehouse(actor:Actor,payload:AnyRow){
  requireBusinessPermission(actor,"master.manage");
  const idValue=cleanText(payload.id,120),site=cleanText(payload.site,20),channel=cleanText(payload.channel,20),code=cleanText(payload.code,50).toUpperCase(),name=cleanText(payload.name,120),capacityQty=int(payload.capacityQty),active=payload.active===false?0:1;
  validSiteChannel(site,channel);
  if(!code||!name||!Number.isInteger(capacityQty)||capacityQty<0) throw new HttpError(400,"请完整填写仓库编码、名称和容量");
  const db=database(),timestamp=nowIso(),targetId=idValue||makeId("warehouse");
  if(active&&await db.prepare("SELECT id FROM warehouses WHERE site=? AND channel=? AND active=1 AND id<>?").bind(site,channel,targetId).first()) throw new HttpError(409,"当前库存按站点＋渠道核算，每个站点渠道只能启用一个主目的仓；请先停用原仓库");
  if(idValue){const result=await db.prepare("UPDATE warehouses SET site=?,channel=?,code=?,name=?,capacity_qty=?,active=?,updated_at=? WHERE id=?").bind(site,channel,code,name,capacityQty,active,timestamp,idValue).run();if(!result.meta.changes)throw new HttpError(404,"仓库不存在");}
  else await db.prepare("INSERT INTO warehouses (id,site,channel,code,name,capacity_qty,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(targetId,site,channel,code,name,capacityQty,active,timestamp,timestamp).run();
  await audit(actor,"维护仓库主数据","warehouse",targetId,{site,channel,code,name,capacityQty,active}).run();
  return Response.json({ok:true,id:targetId});
}

function errorResponse(error:unknown) {
  if(/inventory_movements.balance_after|guard_|CHECK constraint|maintenance|closed finance/.test(String(error))) return Response.json({error:"库存或凭证已被更新，本次未覆盖；请刷新后重新核对"},{status:409});
  if(error instanceof HttpError || error instanceof ConflictError) return Response.json({error:error.message},{status:error.status});
  console.error(error);
  return Response.json({error:"系统暂时无法完成该操作，请稍后重试；本次未确认写入"},{status:500});
}

async function resolveSupplyUser(requested:unknown,fallback:unknown){
  const id=cleanText(requested||fallback,160);
  const user=id?await database().prepare("SELECT id FROM users WHERE id=? AND role='供应链' AND active=1").bind(id).first<AnyRow>():null;
  if(!user)throw new HttpError(409,"请指定已启用的供应链负责人");
  return String(user.id);
}
