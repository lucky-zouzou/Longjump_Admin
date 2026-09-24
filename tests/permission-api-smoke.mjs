import assert from "node:assert/strict";

const baseUrl=process.env.PERMISSION_TEST_URL||"http://localhost:3000";
const roleUsers={
  "运营":"rbac-operator",
  "运营主管":"rbac-operations-lead",
  "新品开发":"rbac-product-developer",
  "财务":"rbac-finance",
  "供应链":"rbac-supply",
  "工厂":"rbac-factory",
  "海运":"rbac-sea",
};

async function request(userId,method="GET",payload){
  return fetch(`${baseUrl}/api/system`,{
    method,
    headers:{"x-local-test-user":userId,...(payload?{"content-type":"application/json"}:{})},
    body:payload?JSON.stringify(payload):undefined,
  });
}

const adminSnapshot=await (await request("local-admin")).json();
assert.equal(adminSnapshot.actor.role,"管理员","本地测试入口必须由管理员执行");

for(const [role,userId] of Object.entries(roleUsers)){
  await request(userId);
  const response=await request("local-admin","POST",{action:"assignUser",userId,role,site:role==="运营"?"马来西亚":"",channel:role==="运营"?"TikTok":"",active:true});
  assert.equal(response.status,200,`${role}测试账号配置失败：${await response.text()}`);
}

const cases=[
  ["salesImport",["运营"]],
  ["inventoryAdjust",["管理员"]],
  ["submitInventoryCount",["管理员","运营"]],
  ["decideInventoryCount",["管理员","供应链"]],
  ["receiveInbound",["管理员","供应链"]],
  ["monthlySubmit",["管理员","运营"]],
  ["submitPlan",["供应链"]],
  ["withdrawPlan",["管理员","供应链"]],
  ["decideApproval",["管理员"]],
  ["completeProductionOrder",["管理员","工厂"]],
  ["acceptProductionOrder",["管理员","工厂"]],
  ["updateProductionProgress",["管理员","工厂"]],
  ["confirmProductionQc",["管理员","供应链"]],
  ["createShipmentBatch",["管理员","供应链"]],
  ["updateShipmentEta",["管理员","海运"]],
  ["receiveShipmentBatch",["管理员","供应链"]],
  ["confirmShipmentShelf",["管理员","运营"]],
  ["createTransportBatch",["管理员","供应链"]],
  ["advanceTransportLeg",["管理员","供应链","海运"]],
  ["updateTransportLegPlan",["管理员","海运"]],
  ["receiveTransportLeg",["管理员","供应链"]],
  ["confirmTransportShelf",["管理员","运营"]],
  ["startNewProductTest",["管理员"]],
  ["assignUser",["管理员"]],
  ["saveSkuSetting",["管理员","供应链"]],
  ["saveBusinessPartner",["管理员","供应链"]],
  ["saveWarehouse",["管理员","供应链"]],
];

const actors={"管理员":"local-admin",...Object.fromEntries(Object.entries(roleUsers))};
let checked=0;
for(const [action,allowedRoles] of cases){
  for(const [role,userId] of Object.entries(actors)){
    const response=await request(userId,"POST",{action});
    const allowed=allowedRoles.includes(role);
    assert.equal(response.status===403,!allowed,`${role} 对 ${action} 的权限结果异常（HTTP ${response.status}）`);
    checked+=1;
  }
}

const operatorCrossScope=await request(roleUsers["运营"],"POST",{action:"submitInventoryCount",site:"印尼",channel:"TikTok",sku:"TEST-SKU",countedQty:1,reason:"权限范围测试"});
assert.equal(operatorCrossScope.status,403,"运营跨站点操作必须被拒绝");

const selfDemotion=await request("local-admin","POST",{action:"assignUser",userId:"local-admin",role:"运营",site:"马来西亚",channel:"TikTok",active:true});
assert.equal(selfDemotion.status,400,"当前管理员不能降低自己的权限");

const factorySnapshot=await (await request(roleUsers["工厂"])).json();
assert.equal(factorySnapshot.approvals.length,0,"工厂不应读取审批明细");
assert.equal(factorySnapshot.audit.every(row=>row.actor_id===roleUsers["工厂"]),true,"工厂只能读取自己的审计记录");

console.log(`权限接口检查通过：${Object.keys(actors).length}个岗位，${checked+4}项授权、范围和数据隔离场景。`);
