import {canReadDomain} from './permissions.mjs';

export const HISTORY_SITES=['马来西亚','印尼','泰国','越南','菲律宾'];
export const HISTORY_CHANNELS=['TikTok','Shopee'];
export class ReplenishmentHistoryError extends Error {
  constructor(status,message){super(message);this.status=status;}
}
const validMonth=value=>/^\d{4}-(0[1-9]|1[0-2])$/.test(value);
export function previousPlanMonth(month){
  const [year,number]=month.split('-').map(Number);
  return `${number===1?year-1:year}-${String(number===1?12:number-1).padStart(2,'0')}`;
}
const text=value=>String(value??'');
function savedJson(raw){
  try{return JSON.parse(raw);}catch{throw new ReplenishmentHistoryError(409,'该月保存的计划明细不完整，请联系管理员核对');}
}
function quantity(value){
  if(value==null||value===''||!Number.isSafeInteger(Number(value))||Number(value)<0)
    throw new ReplenishmentHistoryError(409,'历史计划数量异常，请联系管理员核对');
  return Number(value);
}

// Read the saved monthly submission and approval allocations, never a live forecast.
// Payloads are explicitly projected so operators cannot receive other scopes or procurement prices.
export async function readReplenishmentHistory(db,actor,input={},now=new Date()){
  if(!canReadDomain(actor?.role,'planning'))throw new ReplenishmentHistoryError(403,'当前账号无权查看补货计划');
  let site=text(input.site),channel=text(input.channel);
  if(actor.role==='运营'){
    if(!HISTORY_SITES.includes(actor.site)||!HISTORY_CHANNELS.includes(actor.channel)||site&&site!==actor.site||channel&&channel!==actor.channel)
      throw new ReplenishmentHistoryError(403,'只能查看本人站点和渠道的补货计划');
    site=actor.site;channel=actor.channel;
  }
  if(site&&!HISTORY_SITES.includes(site)||channel&&!HISTORY_CHANNELS.includes(channel))throw new ReplenishmentHistoryError(400,'站点或渠道无效');
  const currentMonth=new Date(now.valueOf()+8*3600000).toISOString().slice(0,7);
  const month=text(input.month)||previousPlanMonth(currentMonth);
  if(!validMonth(month))throw new ReplenishmentHistoryError(400,'请选择有效月份');
  const scopeClauses=[],args=[];
  for(const [key,value]of [['site',site],['channel',channel]])if(value){scopeClauses.push(`${key}=?`);args.push(value);}
  const where=scopeClauses.length?' AND '+scopeClauses.join(' AND '):'';
  const allocationScope=[site&&"json_extract(a.value,'$.site')=?",channel&&"json_extract(a.value,'$.channel')=?"].filter(Boolean);
  const planScope=allocationScope.length?` AND EXISTS (
    SELECT 1 FROM json_each(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END,'$.items') i,
    json_each(i.value,'$.allocations') a WHERE ${allocationScope.join(' AND ')})`:'';
  const months=(await db.prepare(`SELECT DISTINCT month FROM (
    SELECT month FROM monthly_submissions WHERE 1=1${where}
    UNION SELECT month FROM approval_requests WHERE type='monthly_plan'${planScope}
  ) ORDER BY month DESC`).bind(...args,...args).all()).results.map(row=>row.month).filter(validMonth);
  const submissions=(await db.prepare(`SELECT s.*,u.name actor_name FROM monthly_submissions s
    LEFT JOIN users u ON u.id=s.actor_id WHERE month=?${where.replaceAll('site=','s.site=').replaceAll('channel=','s.channel=')}
    ORDER BY s.site,s.channel`).bind(month,...args).all()).results;
  const savedPlan=await db.prepare("SELECT id,month,status,version,payload_json,updated_at FROM approval_requests WHERE type='monthly_plan' AND month=?").bind(month).first();
  const matches=(s,c)=>(!site||site===s)&&(!channel||channel===c);
  const rows=new Map(),scopes=new Map();
  const key=(s,c,sku)=>JSON.stringify([s,c,sku]);
  const rowFor=(s,c,sku,name)=>{
    const id=key(s,c,sku);
    if(!rows.has(id))rows.set(id,{id,site:s,channel:c,sku,name:text(name),submittedQty:null,planQty:null,reason:''});
    return rows.get(id);
  };
  const submissionViews=submissions.map(s=>{
    const items=savedJson(s.items_json);
    if(!Array.isArray(items)||s.zero_demand&&items.length)throw new ReplenishmentHistoryError(409,'该月提交记录与明细不一致，请联系管理员核对');
    let totalQty=0;
    const seen=new Set();
    for(const item of items){
      if(!item.sku||seen.has(item.sku))throw new ReplenishmentHistoryError(409,'历史提交存在重复或缺失 SKU，请联系管理员核对');
      seen.add(item.sku);
      const row=rowFor(s.site,s.channel,text(item.sku),item.name);
      row.submittedQty=quantity(item.qty);row.reason=text(item.reason);totalQty+=row.submittedQty;
    }
    if(totalQty!==quantity(s.total_qty))throw new ReplenishmentHistoryError(409,'历史提交总量与 SKU 明细不一致，请联系管理员核对');
    scopes.set(key(s.site,s.channel,''),true);
    return {id:s.id,site:s.site,channel:s.channel,version:s.version,submittedAt:s.submitted_at,actorName:s.actor_name||'历史账号',
      zeroDemand:Boolean(s.zero_demand),zeroReason:text(s.zero_reason),skuCount:items.length,totalQty};
  });
  let plan=null;
  if(savedPlan){
    const payload=savedJson(savedPlan.payload_json);
    if(!Array.isArray(payload?.items))throw new ReplenishmentHistoryError(409,'该月审批计划缺少 SKU 明细，请联系管理员核对');
    const seen=new Set();let matchingAllocations=0;
    for(const item of payload.items){
      if(!Array.isArray(item.allocations))throw new ReplenishmentHistoryError(409,'该月审批计划缺少站点分配，请联系管理员核对');
      for(const allocation of item.allocations){
        if(!matches(allocation.site,allocation.channel))continue;
        const id=key(allocation.site,allocation.channel,text(item.sku));
        if(!item.sku||seen.has(id))throw new ReplenishmentHistoryError(409,'审批计划存在重复或缺失 SKU，请联系管理员核对');
        seen.add(id);matchingAllocations++;
        rowFor(allocation.site,allocation.channel,text(item.sku),item.name).planQty=quantity(allocation.qty);
      }
    }
    // A global approval with no allocation/submission in an operator's scope is not disclosed.
    if(matchingAllocations||submissions.length||!site&&!channel)
      plan={id:savedPlan.id,status:savedPlan.status,version:savedPlan.version,updatedAt:savedPlan.updated_at};
  }
  for(const row of rows.values()){
    if(plan&&row.planQty===null)row.planQty=0;
    if(row.submittedQty===null&&scopes.has(key(row.site,row.channel,'')))row.submittedQty=0;
  }
  const details=[...rows.values()].sort((a,b)=>a.site.localeCompare(b.site,'zh-CN')||a.channel.localeCompare(b.channel)||a.sku.localeCompare(b.sku));
  return {month,currentMonth,months,scope:{site,channel,restricted:actor.role==='运营'},plan,submissions:submissionViews,rows:details,
    summary:{skuCount:new Set(details.map(row=>row.sku)).size,submissionCount:submissions.length,
      submittedQty:submissions.length?submissionViews.reduce((sum,s)=>sum+s.totalQty,0):null,
      planQty:plan?details.reduce((sum,row)=>sum+row.planQty,0):null},generatedAt:now.toISOString()};
}
