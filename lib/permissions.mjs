export const PERMISSION_LABELS = Object.freeze({
  "wholesale.read":"查看印尼线下批发", "wholesale.create":"提交线下出库申请", "wholesale.customer":"维护本人批发客户",
  "wholesale.approve":"审批线下出库申请", "wholesale.ship":"登记线下打包与发货", "wholesale.finance":"核销线下回款与开票", "wholesale.return":"登记线下退货入库",
  "backup.export":"导出全量备份",
  "sales.import":"导入每日销售",
  "sales.reverse":"冲销错误销售导入",
  "inventory.adjust":"管理员直接修正库存",
  "inventory.count.submit":"提交库存盘点差异",
  "inventory.count.approve":"复核库存盘点差异",
  "inventory.hold.resolve":"处理隔离/破损库存",
  "monthly.submit":"提交本站月度需求",
  "plan.submit":"按系列汇总并送审",
  "approval.decide":"审批备货计划",
  "sku.manage":"维护SKU系列与供应参数",
  "master.manage":"维护供应商、工厂、承运商与仓库",
  "purchase.confirm":"确认供应商接单",
  "production.accept":"工厂接单并承诺交期",
  "production.progress":"更新生产进度",
  "production.complete":"登记工厂完工",
  "production.qc":"确认生产质检",
  "shipment.create":"创建多SKU海运批次",
  "shipment.advance.supply":"推进供应链节点",
  "shipment.advance.factory":"推进工厂节点",
  "shipment.advance.sea":"推进海运、到港与派送节点",
  "shipment.eta":"维护海运ETA",
  "inbound.receive":"登记到仓并入库",
  "shelf.confirm":"确认本站渠道上架",
  "transport.create":"创建跨系列发运主批次",
  "transport.advance.supply":"推进订舱与目的地交付节点",
  "transport.advance.sea":"推进海运、到港、清关与派送节点",
  "transport.eta":"维护目的地运输计划",
  "transport.receive":"按目的地分批登记到仓",
  "transport.shelf":"确认待上架库存转为可售",
  "new_product.start":"发起新品测试",
  "new_product.candidate":"提交候选款",
  "new_product.research":"提交运营调研",
  "new_product.seeding":"提交内容种草数据",
  "new_product.finance":"提交财务测算",
  "new_product.sample":"提交工厂打板结果",
  "new_product.sample_development":"新品开发确认样品",
  "new_product.sample_operations":"运营主管确认样品",
  "new_product.decide_test":"决定测试阶段是否继续",
  "new_product.decide_admin":"决定新品关键阶段",
  "audit.view":"查看全量审计日志",
  "user.manage":"管理账号与岗位权限",
});

const ADMIN_PERMISSIONS = Object.keys(PERMISSION_LABELS).filter((key) => key !== "sales.import");

export const ROLE_PERMISSIONS = Object.freeze({
  "管理员":Object.freeze(ADMIN_PERMISSIONS),
  "销售":Object.freeze(["wholesale.read","wholesale.create","wholesale.customer"]),
  "运营":Object.freeze(["wholesale.read","wholesale.create","wholesale.customer","sales.import","inventory.count.submit","monthly.submit","new_product.research","new_product.seeding","shelf.confirm","transport.shelf"]),
  "运营主管":Object.freeze(["new_product.research","new_product.seeding","new_product.sample_operations","new_product.decide_test"]),
  "新品开发":Object.freeze(["new_product.candidate","new_product.sample_development"]),
  "财务":Object.freeze(["new_product.finance","wholesale.read","wholesale.finance"]),
  "供应链":Object.freeze(["wholesale.read","wholesale.ship","wholesale.return","plan.submit","sku.manage","master.manage","purchase.confirm","production.qc","inventory.count.approve","inventory.hold.resolve","shipment.create","shipment.advance.supply","inbound.receive","transport.create","transport.advance.supply","transport.receive"]),
  "工厂":Object.freeze(["production.accept","production.progress","production.complete","shipment.advance.factory","new_product.sample"]),
  "海运":Object.freeze(["shipment.advance.sea","shipment.eta","transport.advance.sea","transport.eta"]),
});

export const DATA_DOMAIN_LABELS = Object.freeze({
  overview:"经营总览", wholesale:"印尼线下批发", sales:"销售汇总", inventory:"库存与盘点", planning:"月度计划与审批",
  fulfillment:"采购与生产", transport:"发运与目的地运输", new_product:"新品孵化",
  finance_detail:"新品财务明细", master:"主数据", audit:"全量审计", users:"账号权限",
});

const ALL_DATA_DOMAINS = Object.keys(DATA_DOMAIN_LABELS);
export const ROLE_DATA_DOMAINS = Object.freeze({
  "销售":Object.freeze(["wholesale"]),
  "管理员":Object.freeze(ALL_DATA_DOMAINS),
  "运营":Object.freeze(["overview","wholesale","sales","inventory","planning","fulfillment","transport","new_product"]),
  "运营主管":Object.freeze(["overview","sales","inventory","planning","fulfillment","transport","new_product"]),
  "新品开发":Object.freeze(["overview","new_product"]),
  "财务":Object.freeze(["overview","wholesale","new_product","finance_detail"]),
  "供应链":Object.freeze(["overview","wholesale","sales","inventory","planning","fulfillment","transport","master"]),
  "工厂":Object.freeze(["overview","sales","fulfillment","new_product"]),
  "海运":Object.freeze(["overview","transport"]),
});

export const NAVIGATION_BY_ROLE = Object.freeze({
  "销售":Object.freeze(["wholesale"]),
  "管理员":Object.freeze(["overview","wholesale","suggestions","new-products","sales","inventory","receipt","monthly","approval","fulfillment","batches","master","audit","users","permissions"]),
  "运营":Object.freeze(["overview","wholesale","suggestions","new-products","sales","inventory","monthly","fulfillment","batches"]),
  "运营主管":Object.freeze(["overview","suggestions","new-products","sales","inventory","monthly","fulfillment","batches"]),
  "新品开发":Object.freeze(["overview","new-products"]),
  "财务":Object.freeze(["overview","wholesale","new-products"]),
  "供应链":Object.freeze(["overview","wholesale","suggestions","sales","inventory","receipt","monthly","approval","fulfillment","batches","master"]),
  "工厂":Object.freeze(["overview","sales","new-products","fulfillment","batches"]),
  "海运":Object.freeze(["overview","batches"]),
});

export function hasPermission(role, permission) {
  return (ROLE_PERMISSIONS[role] || []).includes(permission);
}

export function canReadDomain(role, domain) {
  return (ROLE_DATA_DOMAINS[role] || []).includes(domain);
}

export function dataDomainsForRole(role) {
  return [...(ROLE_DATA_DOMAINS[role] || ["overview"])];
}

export function permissionsForRole(role) {
  return [...(ROLE_PERMISSIONS[role] || [])];
}

export function navigationForRole(role) {
  return [...(NAVIGATION_BY_ROLE[role] || ["overview"])];
}
