export const REQUIRED_MONTHLY_SCOPES = ["马来西亚","印尼","泰国","越南","菲律宾"]
  .flatMap((site) => ["TikTok","Shopee"].map((channel) => ({ site, channel })));

export function missingMonthlyScopes(submissions) {
  const submitted = new Set(submissions.map((row) => `${row.site}|${row.channel}`));
  return REQUIRED_MONTHLY_SCOPES.filter((row) => !submitted.has(`${row.site}|${row.channel}`));
}

export function allocationMatchesTotal(total, allocations) {
  return Number(total) === allocations.reduce((sum, row) => sum + Number(row.qty || 0), 0);
}

/**
 * Keep destination allocation trace when an SKU is split across shipment batches.
 * Largest remainders receive the final units so the result always equals targetQty.
 * @param {{site?:string,channel?:string,qty?:number}[]} allocations
 * @param {number} targetQty
 */
export function prorateAllocations(allocations = [], targetQty = 0) {
  const rows = allocations
    .map((row, index) => ({ site:String(row.site || ""), channel:String(row.channel || ""), qty:Math.max(0,Math.round(Number(row.qty || 0))), index }))
    .filter((row) => row.site && row.channel && row.qty > 0);
  const target = Math.max(0,Math.round(Number(targetQty || 0)));
  const sourceTotal = rows.reduce((sum,row) => sum + row.qty,0);
  if (!rows.length || target === 0 || sourceTotal === 0) return [];
  if (target >= sourceTotal) return rows.map(({site,channel,qty}) => ({site,channel,qty}));
  const exact = rows.map((row) => ({...row,exact:row.qty/sourceTotal*target}));
  const result = exact.map((row) => ({site:row.site,channel:row.channel,qty:Math.floor(row.exact),fraction:row.exact-Math.floor(row.exact),index:row.index}));
  let remainder = target-result.reduce((sum,row)=>sum+row.qty,0);
  for (const row of [...result].sort((a,b)=>b.fraction-a.fraction||a.index-b.index)) {
    if (remainder <= 0) break;
    row.qty += 1;
    remainder -= 1;
  }
  return result.filter((row)=>row.qty>0).sort((a,b)=>a.index-b.index).map(({site,channel,qty})=>({site,channel,qty}));
}

const safeNumber = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const nonNegative = (value) => Math.max(0, safeNumber(value));
const round = (value, digits = 2) => Number(value.toFixed(digits));

export function roundSupplyQuantity(value, minOrderQty = 1, orderMultiple = 1) {
  const raw = Math.max(0, Math.ceil(safeNumber(value)));
  if (raw === 0) return 0;
  const minimum = Math.max(1, Math.round(safeNumber(minOrderQty, 1)));
  const multiple = Math.max(1, Math.round(safeNumber(orderMultiple, 1)));
  return Math.ceil(Math.max(raw, minimum) / multiple) * multiple;
}

function serviceFactor(level) {
  const value = safeNumber(level, 0.95);
  if (value >= 0.99) return 2.33;
  if (value >= 0.98) return 2.05;
  if (value >= 0.95) return 1.65;
  return 1.28;
}

/**
 * @param {{dailySales?:number[],dailyCoverage?:boolean[],currentQty?:number,pendingShelf?:number,seaInTransit?:number,productionInProgress?:number,productionLeadDays?:number,seaLeadDays?:number,reviewCycleDays?:number,serviceLevel?:number,daysToNextSea?:number|null,dataDays?:number,daysSinceLastImport?:number|null,minOrderQty?:number,orderMultiple?:number}} input
 */
export function calculateSupplyPlan({
  dailySales = [], dailyCoverage, currentQty = 0, pendingShelf = 0, seaInTransit = 0, productionInProgress = 0,
  productionLeadDays = 21, seaLeadDays = 35, reviewCycleDays = 7,
  serviceLevel = 0.95, daysToNextSea = null, dataDays = 0, daysSinceLastImport = null,
  minOrderQty = 1, orderMultiple = 1,
}) {
  const padded = Array(28).fill(0);
  const source = Array.isArray(dailySales) ? dailySales.slice(-28) : [];
  source.forEach((value, index) => { padded[28 - source.length + index] = nonNegative(value); });

  const observedCoverage = Array(28).fill(Array.isArray(dailyCoverage) ? false : true);
  if (Array.isArray(dailyCoverage)) {
    const coverageSource = dailyCoverage.slice(-28);
    coverageSource.forEach((value, index) => { observedCoverage[28 - coverageSource.length + index] = Boolean(value); });
  }
  const observedAverage = (start, end) => {
    const values = padded.slice(start, end).filter((_, index) => observedCoverage[start + index]);
    return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
  };
  const avg7 = observedAverage(21, 28);
  const previous7 = observedAverage(14, 21);
  const avg28 = observedAverage(0, 28);
  const weightedDaily = avg7 * 0.7 + avg28 * 0.3;
  const forecastDaily = Math.max(avg7, weightedDaily);
  const trendRate = previous7 > 0 ? (avg7 - previous7) / previous7 : avg7 > 0 ? 1 : 0;
  const observedValues = padded.filter((_, index) => observedCoverage[index]);
  const variance = observedValues.length ? observedValues.reduce((total, value) => total + (value - avg28) ** 2, 0) / observedValues.length : 0;
  const salesStdDev = Math.sqrt(variance);

  const productionDays = Math.max(1, Math.round(safeNumber(productionLeadDays, 21)));
  const seaDays = Math.max(1, Math.round(safeNumber(seaLeadDays, 35)));
  const reviewDays = Math.max(1, Math.round(safeNumber(reviewCycleDays, 7)));
  const leadDays = productionDays + seaDays;
  const safetyStock = Math.ceil(serviceFactor(serviceLevel) * salesStdDev * Math.sqrt(leadDays + reviewDays));
  const targetQty = Math.ceil(forecastDaily * (leadDays + reviewDays) + safetyStock);

  const inventory = safeNumber(currentQty);
  const pending = nonNegative(pendingShelf);
  const sea = nonNegative(seaInTransit);
  const production = nonNegative(productionInProgress);
  const inventoryPosition = inventory + pending + sea + production;
  const rawSuggestedProduction = Math.max(0, Math.ceil(targetQty - inventoryPosition));
  const suggestedProduction = roundSupplyQuantity(rawSuggestedProduction, minOrderQty, orderMultiple);
  const replenishmentTarget = Math.ceil(forecastDaily * (seaDays + reviewDays) + safetyStock);
  const rawSuggestedReplenishment = Math.max(0, Math.ceil(replenishmentTarget - inventory - pending - sea));
  const suggestedReplenishment = roundSupplyQuantity(rawSuggestedReplenishment, minOrderQty, orderMultiple);
  const coverDays = (qty) => forecastDaily > 0 ? Math.max(0, qty) / forecastDaily : null;
  const stockCoverDays = coverDays(inventory);
  const landedCoverDays = coverDays(inventory + pending + sea);
  const pipelineCoverDays = coverDays(inventoryPosition);
  const etaDays = daysToNextSea !== null && Number.isFinite(Number(daysToNextSea)) ? Number(daysToNextSea) : null;
  const validEtaDays = etaDays !== null && etaDays >= 0 ? etaDays : null;
  const etaOverdue = sea > 0 && etaDays !== null && etaDays < 0;
  const arrivalWaitDays = sea > 0 ? Math.max(0,etaDays ?? seaDays) : seaDays;
  const staleDays = daysSinceLastImport !== null && Number.isFinite(Number(daysSinceLastImport)) ? Math.max(0,Number(daysSinceLastImport)) : null;
  const projectedAtNextArrival = forecastDaily > 0
    ? Math.floor(inventory - forecastDaily * arrivalWaitDays + (sea > 0 ? sea : 0))
    : inventory + sea;
  const productionStartInDays = forecastDaily > 0
    ? Math.floor(Math.max(0, pipelineCoverDays - leadDays))
    : null;

  let alertLevel = "healthy", alertLabel = "供应健康", alertReason = "库存与供应链覆盖充足";
  if (inventory < 0) {
    alertLevel = "critical"; alertLabel = "负库存"; alertReason = "账面库存已小于0，需先核销差异并立即补货";
  } else if (forecastDaily > 0 && stockCoverDays < arrivalWaitDays) {
    alertLevel = "critical"; alertLabel = "断货风险"; alertReason = sea > 0 ? "现有库存预计撑不到下一批海运到仓" : "现有库存不足以覆盖标准海运周期";
  } else if (etaOverdue) {
    alertLevel = "eta"; alertLabel = "在途逾期"; alertReason = `海运预计到仓日已逾期${Math.abs(Math.round(etaDays))}天，请更新ETA或确认到仓`;
  } else if (staleDays !== null && staleDays > 1) {
    alertLevel = "data"; alertLabel = "销量未更新"; alertReason = `最近一次销售导入距今${Math.round(staleDays)}天，动态建议可能失真`;
  } else if (dataDays < 7) {
    alertLevel = "data"; alertLabel = "数据不足"; alertReason = `近28天仅${dataDays}天完成销售导入，建议量可信度较低`;
  } else if (sea > 0 && validEtaDays === null) {
    alertLevel = "eta"; alertLabel = "在途缺ETA"; alertReason = "已有海运在途，但未维护预计到仓日期";
  } else if (suggestedProduction > 0) {
    alertLevel = "warning"; alertLabel = "需启动生产"; alertReason = "库存＋海运在途＋生产中仍低于目标库存位";
  } else if (trendRate >= 0.2) {
    alertLevel = "watch"; alertLabel = "销量加速"; alertReason = "近7天日均较前7天增长20%以上";
  }

  return {
    dailySales:padded,
    avg7:round(avg7), previous7:round(previous7), avg28:round(avg28),
    forecastDaily:round(forecastDaily), trendRate:round(trendRate, 4), salesStdDev:round(salesStdDev),
    productionLeadDays:productionDays, seaLeadDays:seaDays, reviewCycleDays:reviewDays,
    safetyStock, targetQty, inventoryPosition, pendingShelf:pending, suggestedProduction, suggestedReplenishment,
    rawSuggestedProduction, rawSuggestedReplenishment,
    minOrderQty:Math.max(1,Math.round(safeNumber(minOrderQty,1))), orderMultiple:Math.max(1,Math.round(safeNumber(orderMultiple,1))),
    stockCoverDays:stockCoverDays === null ? null : round(stockCoverDays, 1),
    landedCoverDays:landedCoverDays === null ? null : round(landedCoverDays, 1),
    pipelineCoverDays:pipelineCoverDays === null ? null : round(pipelineCoverDays, 1),
    projectedAtNextArrival, productionStartInDays,
    dataDays, daysSinceLastImport:staleDays,
    confidence:staleDays !== null && staleDays > 1 ? "低" : dataDays >= 21 ? "高" : dataDays >= 14 ? "中" : dataDays >= 7 ? "基础" : "低",
    alertLevel, alertLabel, alertReason,
  };
}

export function canAdvanceBatch(actorRole, stageOwner, adminReason = "") {
  if (actorRole === stageOwner) return true;
  if (actorRole === "管理员" && String(adminReason).trim().length >= 4) return true;
  return false;
}

/** @param {{researchCount?:number,seedingCount?:number,requiredCount?:number}} input */
export function newProductScopeGate({ researchCount = 0, seedingCount = 0, requiredCount = 10 }) {
  return Number(researchCount) >= Number(requiredCount) && Number(seedingCount) >= Number(requiredCount);
}

/** @param {{grossMarginRate?:number,targetGrossMarginRate?:number}} input */
export function financeGatePasses({ grossMarginRate = 0, targetGrossMarginRate = 0 }) {
  return Number.isFinite(Number(grossMarginRate)) && Number(grossMarginRate) >= Number(targetGrossMarginRate);
}

/** @param {{appearanceResult?:string,qualityResult?:string}} sampleData @param {string[]} confirmationStages */
export function sampleGateReady(sampleData = {}, confirmationStages = []) {
  const confirmations = new Set(confirmationStages);
  return sampleData.appearanceResult === "通过" && sampleData.qualityResult === "通过"
    && confirmations.has("sample_development") && confirmations.has("sample_operations");
}

/** @param {{site?:string,channel?:string}[]} allocations @param {{stage?:string,site?:string,channel?:string}[]} evidence */
export function shelfScopesComplete(allocations = [], evidence = []) {
  const required = new Set(allocations.map((row) => `${row.site}|${row.channel}`));
  const confirmed = new Set(evidence.filter((row) => row.stage === "on_shelf").map((row) => `${row.site}|${row.channel}`));
  return required.size > 0 && [...required].every((key) => confirmed.has(key));
}
