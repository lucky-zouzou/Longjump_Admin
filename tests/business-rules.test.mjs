import test from "node:test";
import assert from "node:assert/strict";
import { allocationMatchesTotal, calculateSupplyPlan, canAdvanceBatch, financeGatePasses, missingMonthlyScopes, newProductScopeGate, prorateAllocations, roundSupplyQuantity, sampleGateReady, shelfScopesComplete } from "../lib/rules.mjs";

test("月度计划缺少任一站点渠道时不能视为完整", () => {
  const nine = ["马来西亚","印尼","泰国","越南"].flatMap(site=>["TikTok","Shopee"].map(channel=>({site,channel})));
  nine.push({site:"菲律宾",channel:"TikTok"});
  const missing = missingMonthlyScopes(nine);
  assert.deepEqual(missing,[{site:"菲律宾",channel:"Shopee"}]);
});

test("五站双渠道全部提交后通过完整度门槛", () => {
  const all = ["马来西亚","印尼","泰国","越南","菲律宾"].flatMap(site=>["TikTok","Shopee"].map(channel=>({site,channel})));
  assert.equal(missingMonthlyScopes(all).length,0);
});

test("渠道分配合计必须等于到仓总数", () => {
  assert.equal(allocationMatchesTotal(100,[{qty:60},{qty:40}]),true);
  assert.equal(allocationMatchesTotal(100,[{qty:50},{qty:40}]),false);
});

test("SKU拆分到多个海运批次后仍保留站点分配且数量守恒",()=>{
  const result=prorateAllocations([{site:"印尼",channel:"TikTok",qty:60},{site:"泰国",channel:"Shopee",qty:40}],33);
  assert.equal(result.reduce((sum,row)=>sum+row.qty,0),33);
  assert.deepEqual(result,[{site:"印尼",channel:"TikTok",qty:20},{site:"泰国",channel:"Shopee",qty:13}]);
});

test("小批量分配使用最大余数法并且不会产生零数量行",()=>{
  const result=prorateAllocations([{site:"马来西亚",channel:"TikTok",qty:1},{site:"印尼",channel:"TikTok",qty:1},{site:"泰国",channel:"TikTok",qty:1}],2);
  assert.equal(result.length,2);
  assert.equal(result.reduce((sum,row)=>sum+row.qty,0),2);
});

test("近7天销量作为动态速度并与前7天比较", () => {
  const result=calculateSupplyPlan({dailySales:[...Array(21).fill(10),...Array(7).fill(20)],currentQty:2000,seaInTransit:0,productionInProgress:0,productionLeadDays:21,seaLeadDays:35,reviewCycleDays:7,serviceLevel:.95,daysToNextSea:null,dataDays:28});
  assert.equal(result.avg7,20);
  assert.equal(result.previous7,10);
  assert.equal(result.forecastDaily,20);
  assert.equal(result.trendRate,1);
  assert.equal(result.alertLabel,"销量加速");
});

test("负库存不会被归零，并计入补货缺口", () => {
  const result=calculateSupplyPlan({dailySales:Array(28).fill(0),currentQty:-25,seaInTransit:0,productionInProgress:0,productionLeadDays:21,seaLeadDays:35,reviewCycleDays:7,serviceLevel:.95,daysToNextSea:null,dataDays:28});
  assert.equal(result.suggestedProduction,25);
  assert.equal(result.alertLabel,"负库存");
});

test("海运在途与生产中分开计入供应链库存位", () => {
  const result=calculateSupplyPlan({dailySales:Array(28).fill(10),currentQty:100,seaInTransit:50,productionInProgress:75,productionLeadDays:21,seaLeadDays:35,reviewCycleDays:7,serviceLevel:.95,daysToNextSea:10,dataDays:28});
  assert.equal(result.targetQty,630);
  assert.equal(result.inventoryPosition,225);
  assert.equal(result.suggestedProduction,405);
  assert.equal(result.suggestedReplenishment,270);
});

test("库存撑不到下一批海运到仓时触发红色断货预警", () => {
  const result=calculateSupplyPlan({dailySales:Array(28).fill(10),currentQty:100,seaInTransit:200,productionInProgress:500,productionLeadDays:21,seaLeadDays:35,reviewCycleDays:7,serviceLevel:.95,daysToNextSea:15,dataDays:28});
  assert.equal(result.stockCoverDays,10);
  assert.equal(result.alertLevel,"critical");
  assert.equal(result.alertLabel,"断货风险");
});

test("不足7天的销售导入会被标记为低可信数据", () => {
  const result=calculateSupplyPlan({dailySales:Array(28).fill(10),currentQty:1000,seaInTransit:0,productionInProgress:0,productionLeadDays:21,seaLeadDays:35,reviewCycleDays:7,serviceLevel:.95,daysToNextSea:null,dataDays:3});
  assert.equal(result.confidence,"低");
  assert.equal(result.alertLevel,"data");
});

test("销售超过一天未更新时动态建议降为低可信", () => {
  const result=calculateSupplyPlan({dailySales:Array(28).fill(10),currentQty:1000,seaInTransit:0,productionInProgress:0,productionLeadDays:21,seaLeadDays:35,reviewCycleDays:7,serviceLevel:.95,daysToNextSea:null,dataDays:28,daysSinceLastImport:3});
  assert.equal(result.confidence,"低");
  assert.equal(result.alertLabel,"销量未更新");
});

test("海运ETA已过但未到仓时触发逾期预警", () => {
  const result=calculateSupplyPlan({dailySales:Array(28).fill(10),currentQty:1000,seaInTransit:200,productionInProgress:0,productionLeadDays:21,seaLeadDays:35,reviewCycleDays:7,serviceLevel:.95,daysToNextSea:-2,dataDays:28,daysSinceLastImport:0});
  assert.equal(result.alertLevel,"eta");
  assert.equal(result.alertLabel,"在途逾期");
});

test("只有当前节点负责人可推进，管理员越级必须留原因", () => {
  assert.equal(canAdvanceBatch("工厂","工厂"),true);
  assert.equal(canAdvanceBatch("供应链","工厂"),false);
  assert.equal(canAdvanceBatch("管理员","工厂",""),false);
  assert.equal(canAdvanceBatch("管理员","工厂","紧急纠错推进"),true);
});

test("新品调研与种草必须五站双渠道各10份全部完成", () => {
  assert.equal(newProductScopeGate({researchCount:10,seedingCount:10}),true);
  assert.equal(newProductScopeGate({researchCount:10,seedingCount:9}),false);
});

test("新品财务毛利必须达到项目自行设定的目标", () => {
  assert.equal(financeGatePasses({grossMarginRate:.42,targetGrossMarginRate:.4}),true);
  assert.equal(financeGatePasses({grossMarginRate:.39,targetGrossMarginRate:.4}),false);
});

test("打板需质量通过且新品开发与运营主管分别确认", () => {
  const sample={appearanceResult:"通过",qualityResult:"通过"};
  assert.equal(sampleGateReady(sample,["sample_development","sample_operations"]),true);
  assert.equal(sampleGateReady(sample,["sample_development"]),false);
});

test("批次必须由所有站点渠道分别确认上架后才闭环", () => {
  const allocations=[{site:"印尼",channel:"TikTok"},{site:"印尼",channel:"Shopee"}];
  assert.equal(shelfScopesComplete(allocations,[{stage:"on_shelf",site:"印尼",channel:"TikTok"}]),false);
  assert.equal(shelfScopesComplete(allocations,[{stage:"on_shelf",site:"印尼",channel:"TikTok"},{stage:"on_shelf",site:"印尼",channel:"Shopee"}]),true);
});

test("未导入的日期不会被当作零销量拉低需求速度",()=>{
  const daily=[...Array(21).fill(0),10,0,20,0,30,0,40];
  const coverage=[...Array(21).fill(false),true,false,true,false,true,false,true];
  const result=calculateSupplyPlan({dailySales:daily,dailyCoverage:coverage,currentQty:500,dataDays:4,daysSinceLastImport:0});
  assert.equal(result.avg7,25);
});

test("补货数量按MOQ和下单倍数向上取整",()=>{
  assert.equal(roundSupplyQuantity(61,100,24),120);
  assert.equal(roundSupplyQuantity(0,100,24),0);
});
