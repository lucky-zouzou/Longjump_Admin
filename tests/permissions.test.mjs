import test from "node:test";
import assert from "node:assert/strict";
import { canReadDomain, hasPermission, navigationForRole, PERMISSION_LABELS, ROLE_PERMISSIONS } from "../lib/permissions.mjs";

test("管理员拥有最高管理权限，但销售导入保持运营专属", () => {
  for (const permission of Object.keys(PERMISSION_LABELS)) {
    assert.equal(hasPermission("管理员",permission),permission!=="sales.import",permission);
  }
  assert.equal(navigationForRole("管理员").includes("permissions"),true);
});

test("运营只能处理自己的销售、库存、月度需求与上架动作", () => {
  assert.equal(hasPermission("运营","sales.import"),true);
  assert.equal(hasPermission("运营","monthly.submit"),true);
  assert.equal(hasPermission("运营","inventory.count.submit"),true);
  assert.equal(hasPermission("运营","inventory.adjust"),false);
  assert.equal(hasPermission("运营","shelf.confirm"),true);
  assert.equal(hasPermission("运营","shipment.create"),false);
  assert.equal(hasPermission("运营","production.complete"),false);
  assert.equal(hasPermission("运营","shipment.eta"),false);
});

test("供应链、工厂和海运写入权限互相隔离", () => {
  assert.equal(hasPermission("供应链","shipment.create"),true);
  assert.equal(hasPermission("供应链","transport.create"),true);
  assert.equal(hasPermission("供应链","production.qc"),true);
  assert.equal(hasPermission("供应链","inbound.receive"),true);
  assert.equal(hasPermission("供应链","production.complete"),false);
  assert.equal(hasPermission("供应链","shipment.eta"),false);

  assert.equal(hasPermission("工厂","production.complete"),true);
  assert.equal(hasPermission("工厂","production.accept"),true);
  assert.equal(hasPermission("工厂","shipment.create"),false);
  assert.equal(hasPermission("工厂","inbound.receive"),false);

  assert.equal(hasPermission("海运","shipment.eta"),true);
  assert.equal(hasPermission("海运","transport.advance.sea"),true);
  assert.equal(hasPermission("海运","inbound.receive"),false);
  assert.equal(hasPermission("海运","shelf.confirm"),false);
});

test("读取数据域按岗位隔离",()=>{
  assert.equal(canReadDomain("管理员","users"),true);
  assert.equal(canReadDomain("供应链","master"),true);
  assert.equal(canReadDomain("工厂","planning"),false);
  assert.equal(canReadDomain("海运","sales"),false);
  assert.equal(canReadDomain("运营","finance_detail"),false);
});

test("只有管理员能查看全量审计和管理账号", () => {
  for (const role of Object.keys(ROLE_PERMISSIONS)) {
    assert.equal(hasPermission(role,"audit.view"),role==="管理员",role);
    assert.equal(hasPermission(role,"user.manage"),role==="管理员",role);
  }
});

test("海运菜单只保留总览和批次，不出现收货与新品入口", () => {
  assert.deepEqual(navigationForRole("海运"),["overview","batches"]);
  assert.equal(navigationForRole("供应链").includes("audit"),false);
});
