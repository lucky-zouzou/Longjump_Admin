import { integer, primaryKey, real, sqliteTable, text, uniqueIndex, index } from "drizzle-orm/sqlite-core";
export * from "./wholesale-schema";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  role: text("role").notNull(),
  site: text("site"),
  channel: text("channel"),
  responsibilityUnit: text("responsibility_unit"),
  active: integer("active").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [uniqueIndex("idx_users_email").on(t.email)]);

export const businessPartners = sqliteTable("business_partners", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  contact: text("contact").notNull().default(""),
  defaultLeadDays: integer("default_lead_days").notNull().default(0),
  assignedUserId: text("assigned_user_id").references(() => users.id),
  active: integer("active").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  uniqueIndex("idx_partner_type_code").on(t.type, t.code),
  uniqueIndex("idx_partner_type_name").on(t.type, t.name),
  index("idx_partner_assignee").on(t.assignedUserId, t.active),
]);

export const warehouses = sqliteTable("warehouses", {
  id: text("id").primaryKey(),
  site: text("site").notNull(),
  channel: text("channel").notNull(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  capacityQty: integer("capacity_qty").notNull().default(0),
  active: integer("active").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  uniqueIndex("idx_warehouse_code").on(t.code),
  uniqueIndex("idx_warehouse_scope_name").on(t.site, t.channel, t.name),
  index("idx_warehouse_scope").on(t.site, t.channel, t.active),
]);

export const skuSettings = sqliteTable("sku_settings", {
  sku: text("sku").primaryKey(),
  name: text("name").notNull().default(""),
  productSeries: text("product_series").notNull().default("待归类"),
  supplierName: text("supplier_name").notNull().default(""),
  factoryName: text("factory_name").notNull().default(""),
  productType: text("product_type").notNull().default("老款"),
  unitPrice: real("unit_price").notNull().default(0),
  leadTimeDays: integer("lead_time_days").notNull().default(63),
  safetyPct: real("safety_pct").notNull().default(0.25),
  productionLeadDays: integer("production_lead_days").notNull().default(21),
  seaLeadDays: integer("sea_lead_days").notNull().default(35),
  reviewCycleDays: integer("review_cycle_days").notNull().default(7),
  serviceLevel: real("service_level").notNull().default(0.95),
  minOrderQty: integer("min_order_qty").notNull().default(1),
  orderMultiple: integer("order_multiple").notNull().default(1),
  cartonQty: integer("carton_qty").notNull().default(1),
  unitVolumeCbm: real("unit_volume_cbm").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
});

export const inventoryBalances = sqliteTable("inventory_balances", {
  site: text("site").notNull(),
  channel: text("channel").notNull(),
  sku: text("sku").notNull(),
  name: text("name").notNull().default(""),
  qty: integer("qty").notNull().default(0),
  pendingShelfQty: integer("pending_shelf_qty").notNull().default(0),
  reservedQty: integer("reserved_qty").notNull().default(0),
  quarantineQty: integer("quarantine_qty").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.site, t.channel, t.sku] }),
  index("idx_inventory_scope").on(t.site, t.channel),
]);

export const inventoryMovements = sqliteTable("inventory_movements", {
  id: text("id").primaryKey(),
  site: text("site").notNull(),
  channel: text("channel").notNull(),
  sku: text("sku").notNull(),
  name: text("name").notNull().default(""),
  movementType: text("movement_type").notNull(),
  qtyDelta: integer("qty_delta").notNull(),
  balanceAfter: integer("balance_after").notNull(),
  referenceType: text("reference_type").notNull(),
  referenceId: text("reference_id").notNull(),
  note: text("note").notNull().default(""),
  actorId: text("actor_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => [
  index("idx_movements_scope_time").on(t.site, t.channel, t.createdAt),
  index("idx_movements_sku").on(t.sku),
]);

export const salesImports = sqliteTable("sales_imports", {
  reportKind: text("report_kind").notNull().default("partial"),
  id: text("id").primaryKey(),
  importKey: text("import_key").notNull(),
  businessDate: text("business_date").notNull(),
  site: text("site").notNull(),
  channel: text("channel").notNull(),
  fileName: text("file_name").notNull().default(""),
  sourceBatchRef: text("source_batch_ref").notNull().default(""),
  rowCount: integer("row_count").notNull(),
  totalQty: integer("total_qty").notNull(),
  actorId: text("actor_id").notNull(),
  reversedAt: text("reversed_at"),
  reversedBy: text("reversed_by"),
  reversalReason: text("reversal_reason").notNull().default(""),
  createdAt: text("created_at").notNull(),
}, (t) => [
  uniqueIndex("idx_sales_import_key").on(t.importKey),
  index("idx_sales_import_scope_date").on(t.site, t.channel, t.businessDate),
]);

export const salesRecords = sqliteTable("sales_records", {
  id: text("id").primaryKey(),
  importId: text("import_id").notNull(),
  businessDate: text("business_date").notNull(),
  site: text("site").notNull(),
  channel: text("channel").notNull(),
  sku: text("sku").notNull(),
  qty: integer("qty").notNull(),
  unitPrice: real("unit_price").notNull().default(0),
  amount: real("amount").notNull().default(0),
  currency: text("currency"),
  reportedAmount: real("reported_amount"),
  adCost: real("ad_cost"),
  sourceRef: text("source_ref").notNull().default(""),
  actorId: text("actor_id").notNull(),
  reversedAt: text("reversed_at"),
  createdAt: text("created_at").notNull(),
}, (t) => [
  index("idx_sales_scope_date").on(t.site, t.channel, t.businessDate),
  index("idx_sales_sku_date").on(t.sku, t.businessDate),
]);

export const inventoryCountRequests = sqliteTable("inventory_count_requests", {
  id: text("id").primaryKey(),
  site: text("site").notNull(),
  channel: text("channel").notNull(),
  sku: text("sku").notNull(),
  systemQty: integer("system_qty").notNull(),
  countedQty: integer("counted_qty").notNull(),
  reason: text("reason").notNull(),
  status: text("status").notNull().default("pending"),
  decisionComment: text("decision_comment").notNull().default(""),
  creatorId: text("creator_id").notNull(),
  decidedBy: text("decided_by"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  index("idx_count_status").on(t.status, t.createdAt),
  index("idx_count_scope").on(t.site, t.channel, t.sku),
]);

export const inboundReceipts = sqliteTable("inbound_receipts", {
  id: text("id").primaryKey(),
  receiptNo: text("receipt_no").notNull(),
  sku: text("sku").notNull(),
  name: text("name").notNull().default(""),
  sourceBatch: text("source_batch").notNull().default(""),
  proofRef: text("proof_ref").notNull(),
  totalQty: integer("total_qty").notNull(),
  actorId: text("actor_id").notNull(),
  receivedAt: text("received_at").notNull(),
}, (t) => [uniqueIndex("idx_receipt_no").on(t.receiptNo)]);

export const inboundAllocations = sqliteTable("inbound_allocations", {
  receiptId: text("receipt_id").notNull(),
  site: text("site").notNull(),
  channel: text("channel").notNull(),
  qty: integer("qty").notNull(),
}, (t) => [primaryKey({ columns: [t.receiptId, t.site, t.channel] })]);

export const monthlySubmissions = sqliteTable("monthly_submissions", {
  version: integer("version").notNull().default(1),
  zeroDemand: integer("zero_demand").notNull().default(0),
  zeroReason: text("zero_reason").notNull().default(""),
  id: text("id").primaryKey(),
  month: text("month").notNull(),
  site: text("site").notNull(),
  channel: text("channel").notNull(),
  itemsJson: text("items_json").notNull(),
  totalQty: integer("total_qty").notNull(),
  actorId: text("actor_id").notNull(),
  submittedAt: text("submitted_at").notNull(),
}, (t) => [
  uniqueIndex("idx_monthly_submission_unique").on(t.month, t.site, t.channel),
  index("idx_monthly_month").on(t.month),
]);

export const approvalRequests = sqliteTable("approval_requests", {
  version: integer("version").notNull().default(1),
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  month: text("month"),
  status: text("status").notNull(),
  stage: text("stage").notNull(),
  creatorId: text("creator_id").notNull(),
  creatorRole: text("creator_role").notNull(),
  payloadJson: text("payload_json").notNull(),
  decisionComment: text("decision_comment").notNull().default(""),
  approvedBy: text("approved_by"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  index("idx_approval_status").on(t.status, t.createdAt),
  uniqueIndex("idx_approval_month_type").on(t.type, t.month),
]);

export const productionBatches = sqliteTable("production_batches", {
  id: text("id").primaryKey(),
  month: text("month").notNull(),
  sku: text("sku").notNull(),
  name: text("name").notNull().default(""),
  qty: integer("qty").notNull(),
  stage: text("stage").notNull(),
  stageOwner: text("stage_owner").notNull(),
  allocationsJson: text("allocations_json").notNull(),
  evidenceJson: text("evidence_json").notNull().default("[]"),
  estimatedArrivalDate: text("estimated_arrival_date"),
  creatorId: text("creator_id").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  index("idx_batches_stage").on(t.stage, t.updatedAt),
  index("idx_batches_sku").on(t.sku),
]);

export const seriesPurchaseOrders = sqliteTable("series_purchase_orders", {
  id: text("id").primaryKey(),
  month: text("month").notNull(),
  seriesName: text("series_name").notNull(),
  factoryName: text("factory_name").notNull().default(""),
  supplierName: text("supplier_name").notNull().default(""),
  status: text("status").notNull().default("ordered"),
  totalQty: integer("total_qty").notNull(),
  skuCount: integer("sku_count").notNull(),
  approvalId: text("approval_id").notNull(),
  creatorId: text("creator_id").notNull(),
  assignedSupplyUserId: text("assigned_supply_user_id").references(() => users.id),
  orderRef: text("order_ref").notNull().default(""),
  supplierConfirmedAt: text("supplier_confirmed_at"),
  expectedCompletionDate: text("expected_completion_date"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  uniqueIndex("idx_series_po_approval_series").on(t.approvalId, t.seriesName, t.supplierName,t.factoryName),
  index("idx_series_po_month").on(t.month, t.updatedAt),
]);

export const seriesPurchaseOrderItems = sqliteTable("series_purchase_order_items", {
  id: text("id").primaryKey(),
  purchaseOrderId: text("purchase_order_id").notNull(),
  sku: text("sku").notNull(),
  name: text("name").notNull().default(""),
  orderedQty: integer("ordered_qty").notNull(),
  allocationsJson: text("allocations_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  uniqueIndex("idx_series_po_item_unique").on(t.purchaseOrderId, t.sku),
  index("idx_series_po_item_sku").on(t.sku),
]);

export const seriesProductionOrders = sqliteTable("series_production_orders", {
  id: text("id").primaryKey(),
  purchaseOrderId: text("purchase_order_id").notNull(),
  month: text("month").notNull(),
  seriesName: text("series_name").notNull(),
  factoryName: text("factory_name").notNull().default(""),
  status: text("status").notNull().default("pending"),
  totalPlannedQty: integer("total_planned_qty").notNull(),
  totalProducedQty: integer("total_produced_qty").notNull().default(0),
  evidenceJson: text("evidence_json").notNull().default("[]"),
  creatorId: text("creator_id").notNull(),
  assignedUserId: text("assigned_user_id").references(() => users.id),
  promisedCompletionDate: text("promised_completion_date"),
  progressPct: integer("progress_pct").notNull().default(0),
  qcStatus: text("qc_status").notNull().default("pending"),
  qcEvidence: text("qc_evidence").notNull().default(""),
  qcAt: text("qc_at"),
  qcBy: text("qc_by"),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  uniqueIndex("idx_series_production_po").on(t.purchaseOrderId),
  index("idx_series_production_status").on(t.status, t.updatedAt),
]);

export const seriesProductionOrderItems = sqliteTable("series_production_order_items", {
  id: text("id").primaryKey(),
  productionOrderId: text("production_order_id").notNull(),
  purchaseOrderItemId: text("purchase_order_item_id").notNull(),
  sku: text("sku").notNull(),
  name: text("name").notNull().default(""),
  plannedQty: integer("planned_qty").notNull(),
  producedQty: integer("produced_qty").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  uniqueIndex("idx_series_production_item_unique").on(t.productionOrderId, t.sku),
  index("idx_series_production_item_sku").on(t.sku),
]);

export const shipmentBatches = sqliteTable("shipment_batches", {
  id: text("id").primaryKey(),
  batchNo: text("batch_no").notNull(),
  month: text("month").notNull(),
  productionOrderId: text("production_order_id").notNull(),
  seriesName: text("series_name").notNull(),
  totalShippedQty: integer("total_shipped_qty").notNull(),
  skuCount: integer("sku_count").notNull(),
  stage: text("stage").notNull().default("channel_allocation"),
  stageOwner: text("stage_owner").notNull().default("供应链"),
  estimatedArrivalDate: text("estimated_arrival_date"),
  evidenceJson: text("evidence_json").notNull().default("[]"),
  creatorId: text("creator_id").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  uniqueIndex("idx_shipment_batch_no").on(t.batchNo),
  index("idx_shipment_stage").on(t.stage, t.updatedAt),
  index("idx_shipment_production").on(t.productionOrderId),
]);

export const shipmentBatchItems = sqliteTable("shipment_batch_items", {
  id: text("id").primaryKey(),
  batchId: text("batch_id").notNull(),
  productionOrderItemId: text("production_order_item_id").notNull(),
  sku: text("sku").notNull(),
  name: text("name").notNull().default(""),
  shippedQty: integer("shipped_qty").notNull(),
  receivedQty: integer("received_qty").notNull().default(0),
  shelvedQty: integer("shelved_qty").notNull().default(0),
  allocationsJson: text("allocations_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  uniqueIndex("idx_shipment_item_unique").on(t.batchId, t.sku),
  index("idx_shipment_item_sku").on(t.sku),
]);

export const shipmentReceipts = sqliteTable("shipment_receipts", {
  id: text("id").primaryKey(),
  receiptNo: text("receipt_no").notNull(),
  batchId: text("batch_id").notNull(),
  proofRef: text("proof_ref").notNull(),
  totalReceivedQty: integer("total_received_qty").notNull(),
  actorId: text("actor_id").notNull(),
  receivedAt: text("received_at").notNull(),
}, (t) => [
  uniqueIndex("idx_shipment_receipt_no").on(t.receiptNo),
  index("idx_shipment_receipt_batch").on(t.batchId, t.receivedAt),
]);

export const shipmentReceiptItems = sqliteTable("shipment_receipt_items", {
  id: text("id").primaryKey(),
  receiptId: text("receipt_id").notNull(),
  batchItemId: text("batch_item_id").notNull(),
  sku: text("sku").notNull(),
  receivedQty: integer("received_qty").notNull(),
  allocationsJson: text("allocations_json").notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => [
  uniqueIndex("idx_shipment_receipt_item_unique").on(t.receiptId, t.batchItemId),
  index("idx_shipment_receipt_item_batch_item").on(t.batchItemId),
]);

export const shipmentShelfConfirmations = sqliteTable("shipment_shelf_confirmations", {
  id: text("id").primaryKey(),
  batchItemId: text("batch_item_id").notNull(),
  site: text("site").notNull(),
  channel: text("channel").notNull(),
  plannedQty: integer("planned_qty").notNull(),
  shelvedQty: integer("shelved_qty").notNull(),
  listingRef: text("listing_ref").notNull(),
  note: text("note").notNull().default(""),
  actorId: text("actor_id").notNull(),
  confirmedAt: text("confirmed_at").notNull(),
}, (t) => [
  uniqueIndex("idx_shipment_shelf_scope").on(t.batchItemId, t.site, t.channel),
  index("idx_shipment_shelf_item").on(t.batchItemId),
]);

export const transportBatches = sqliteTable("transport_batches", {
  id: text("id").primaryKey(),
  batchNo: text("batch_no").notNull(),
  containerNo: text("container_no").notNull().default(""),
  billNo: text("bill_no").notNull().default(""),
  carrierName: text("carrier_name").notNull(),
  status: text("status").notNull().default("booking"),
  totalShippedQty: integer("total_shipped_qty").notNull(),
  skuCount: integer("sku_count").notNull(),
  seriesCount: integer("series_count").notNull(),
  creatorId: text("creator_id").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  uniqueIndex("idx_transport_batch_no").on(t.batchNo),
  index("idx_transport_batch_status").on(t.status, t.updatedAt),
]);

export const transportBatchItems = sqliteTable("transport_batch_items", {
  id: text("id").primaryKey(),
  batchId: text("batch_id").notNull().references(() => transportBatches.id, { onDelete: "cascade" }),
  productionOrderId: text("production_order_id").notNull(),
  productionOrderItemId: text("production_order_item_id").notNull(),
  seriesName: text("series_name").notNull(),
  sku: text("sku").notNull(),
  name: text("name").notNull().default(""),
  shippedQty: integer("shipped_qty").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  uniqueIndex("idx_transport_item_source").on(t.batchId, t.productionOrderItemId),
  index("idx_transport_item_batch").on(t.batchId),
  index("idx_transport_item_sku").on(t.sku),
]);

export const transportLegs = sqliteTable("transport_legs", {
  id: text("id").primaryKey(),
  batchId: text("batch_id").notNull().references(() => transportBatches.id, { onDelete: "cascade" }),
  legNo: text("leg_no").notNull(),
  site: text("site").notNull(),
  channel: text("channel").notNull(),
  warehouseId: text("warehouse_id").references(() => warehouses.id),
  warehouseName: text("warehouse_name").notNull(),
  portName: text("port_name").notNull().default(""),
  stage: text("stage").notNull().default("booking"),
  stageOwner: text("stage_owner").notNull().default("供应链"),
  assignedUserId: text("assigned_user_id").references(() => users.id),
  totalQty: integer("total_qty").notNull(),
  etd: text("etd"),
  eta: text("eta"),
  ata: text("ata"),
  evidenceJson: text("evidence_json").notNull().default("[]"),
  version: integer("version").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  uniqueIndex("idx_transport_leg_no").on(t.legNo),
  uniqueIndex("idx_transport_leg_destination").on(t.batchId, t.site, t.channel, t.warehouseName),
  index("idx_transport_leg_stage").on(t.stage, t.updatedAt),
  index("idx_transport_leg_assignee").on(t.assignedUserId, t.stage),
]);

export const transportLegItems = sqliteTable("transport_leg_items", {
  id: text("id").primaryKey(),
  legId: text("leg_id").notNull().references(() => transportLegs.id, { onDelete: "cascade" }),
  batchItemId: text("batch_item_id").notNull().references(() => transportBatchItems.id, { onDelete: "cascade" }),
  sku: text("sku").notNull(),
  qty: integer("qty").notNull(),
  receivedQty: integer("received_qty").notNull().default(0),
  pendingShelfQty: integer("pending_shelf_qty").notNull().default(0),
  sellableQty: integer("sellable_qty").notNull().default(0),
  quarantineQty: integer("quarantine_qty").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  uniqueIndex("idx_transport_leg_item_unique").on(t.legId, t.batchItemId),
  index("idx_transport_leg_item_sku").on(t.sku),
]);

export const transportReceipts = sqliteTable("transport_receipts", {
  id: text("id").primaryKey(),
  receiptNo: text("receipt_no").notNull(),
  legId: text("leg_id").notNull().references(() => transportLegs.id),
  proofRef: text("proof_ref").notNull(),
  note: text("note").notNull().default(""),
  totalReceivedQty: integer("total_received_qty").notNull(),
  totalQuarantineQty: integer("total_quarantine_qty").notNull().default(0),
  actorId: text("actor_id").notNull(),
  receivedAt: text("received_at").notNull(),
}, (t) => [
  uniqueIndex("idx_transport_receipt_no").on(t.receiptNo),
  index("idx_transport_receipt_leg").on(t.legId, t.receivedAt),
]);

export const transportReceiptItems = sqliteTable("transport_receipt_items", {
  id: text("id").primaryKey(),
  receiptId: text("receipt_id").notNull().references(() => transportReceipts.id, { onDelete: "cascade" }),
  legItemId: text("leg_item_id").notNull().references(() => transportLegItems.id),
  receivedQty: integer("received_qty").notNull(),
  quarantineQty: integer("quarantine_qty").notNull().default(0),
  createdAt: text("created_at").notNull(),
}, (t) => [
  uniqueIndex("idx_transport_receipt_item_unique").on(t.receiptId, t.legItemId),
  index("idx_transport_receipt_item_leg").on(t.legItemId),
]);

export const transportShelfConfirmations = sqliteTable("transport_shelf_confirmations", {
  id: text("id").primaryKey(),
  legItemId: text("leg_item_id").notNull().references(() => transportLegItems.id),
  shelvedQty: integer("shelved_qty").notNull(),
  listingRef: text("listing_ref").notNull(),
  note: text("note").notNull().default(""),
  actorId: text("actor_id").notNull(),
  confirmedAt: text("confirmed_at").notNull(),
}, (t) => [
  index("idx_transport_shelf_item").on(t.legItemId, t.confirmedAt),
]);

export const newProductProjects = sqliteTable("new_product_projects", {
  version: integer("version").notNull().default(1),
  financeRevision: integer("finance_revision").notNull().default(1),
  id: text("id").primaryKey(),
  cycleMonth: text("cycle_month").notNull(),
  sku: text("sku").notNull(),
  name: text("name").notNull().default(""),
  firstBatchQty: integer("first_batch_qty").notNull().default(3000),
  recommendedFirstBatchQty: integer("recommended_first_batch_qty").notNull().default(0),
  stage: text("stage").notNull().default("selection"),
  status: text("status").notNull().default("active"),
  stageStartedAt: text("stage_started_at").notNull(),
  currentDueAt: text("current_due_at").notNull(),
  productionBatchId: text("production_batch_id"),
  abandonReason: text("abandon_reason").notNull().default(""),
  decisionHistoryJson: text("decision_history_json").notNull().default("[]"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  uniqueIndex("idx_new_product_month_sku").on(t.cycleMonth, t.sku),
  index("idx_new_product_status_due").on(t.status, t.currentDueAt),
]);

export const newProductStageRecords = sqliteTable("new_product_stage_records", {
  version: integer("version").notNull().default(1),
  sourceVersion: integer("source_version"),
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  stageKey: text("stage_key").notNull(),
  scopeKey: text("scope_key").notNull().default("global"),
  site: text("site"),
  channel: text("channel"),
  status: text("status").notNull().default("submitted"),
  dataJson: text("data_json").notNull(),
  conclusion: text("conclusion").notNull().default(""),
  actorId: text("actor_id").notNull(),
  actorName: text("actor_name").notNull(),
  submittedAt: text("submitted_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  uniqueIndex("idx_new_product_record_scope").on(t.projectId, t.stageKey, t.scopeKey),
  index("idx_new_product_record_project").on(t.projectId, t.stageKey),
]);

export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey(),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  detailJson: text("detail_json").notNull(),
  actorId: text("actor_id").notNull(),
  actorName: text("actor_name").notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => [
  index("idx_audit_time").on(t.createdAt),
  index("idx_audit_entity").on(t.entityType, t.entityId),
]);

export * from "./reliability-schema";
