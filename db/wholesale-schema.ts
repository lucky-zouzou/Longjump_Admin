import { integer, sqliteTable, text, uniqueIndex, index, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const wholesaleCustomers = sqliteTable("wholesale_customers", {
  version:integer("version").notNull().default(1),
  id:text("id").primaryKey(), code:text("code").notNull(), name:text("name").notNull(),
  contact:text("contact").notNull(), phone:text("phone").notNull(), city:text("city").notNull(),
  address:text("address").notNull(), note:text("note").notNull().default(""), salesUserId:text("sales_user_id").notNull(),
  active:integer("active").notNull().default(1), createdAt:text("created_at").notNull(), updatedAt:text("updated_at").notNull(),
},t=>[uniqueIndex("idx_wh_customer_code").on(t.code),index("idx_wh_customer_owner").on(t.salesUserId)]);

export const wholesaleOrders = sqliteTable("wholesale_orders", {
  id:text("id").primaryKey(), orderNo:text("order_no").notNull(), site:text("site").notNull().default("印尼"),
  currency:text("currency").notNull().default("IDR"), businessDate:text("business_date").notNull(),
  customerId:text("customer_id").notNull().references(()=>wholesaleCustomers.id), customerJson:text("customer_json").notNull(),
  serviceUserId:text("service_user_id"), salesUserId:text("sales_user_id").notNull(), creatorId:text("creator_id").notNull(), supplyUserId:text("supply_user_id"), approvedBy:text("approved_by"),
  status:text("status").notNull().default("pending"), version:integer("version").notNull().default(1),
  totalQty:integer("total_qty").notNull(), totalAmount:integer("total_amount").notNull(),
  cancelledAmount:integer("cancelled_amount").notNull().default(0),
  invoiceRequired:integer("invoice_required").notNull().default(0), paymentTerms:text("payment_terms").notNull().default("prepaid"),
  dueDate:text("due_date"), allocationPolicy:text("allocation_policy").notNull().default("average_v1"),
  note:text("note").notNull().default(""), decisionNote:text("decision_note").notNull().default(""),
  createdAt:text("created_at").notNull(), updatedAt:text("updated_at").notNull(), approvedAt:text("approved_at"), completedAt:text("completed_at"),
},t=>[uniqueIndex("idx_wh_order_no").on(t.orderNo),index("idx_wh_order_customer").on(t.customerId,t.businessDate),index("idx_wh_order_sales").on(t.salesUserId,t.status),index("idx_wh_order_supply").on(t.supplyUserId,t.status),check("wh_indonesia_only",sql`${t.site}='印尼' AND ${t.currency}='IDR'`)]);

export const wholesaleOrderItems = sqliteTable("wholesale_order_items", {
  id:text("id").primaryKey(), orderId:text("order_id").notNull().references(()=>wholesaleOrders.id),
  sku:text("sku").notNull(), name:text("name").notNull(), qty:integer("qty").notNull(),
  unitPrice:integer("unit_price").notNull(), amount:integer("amount").notNull(), shippedQty:integer("shipped_qty").notNull().default(0), returnedQty:integer("returned_qty").notNull().default(0),
},t=>[uniqueIndex("idx_wh_item_sku").on(t.orderId,t.sku),check("wh_item_qty",sql`${t.qty}>0 AND ${t.shippedQty}>=0 AND ${t.shippedQty}<=${t.qty} AND ${t.returnedQty}>=0 AND ${t.returnedQty}<=${t.shippedQty}`)]);

export const wholesaleAllocations = sqliteTable("wholesale_allocations", {
  id:text("id").primaryKey(), orderItemId:text("order_item_id").notNull().references(()=>wholesaleOrderItems.id),
  channel:text("channel").notNull(), qty:integer("qty").notNull(), shippedQty:integer("shipped_qty").notNull().default(0),
  releasedQty:integer("released_qty").notNull().default(0), returnedQty:integer("returned_qty").notNull().default(0),
},t=>[uniqueIndex("idx_wh_allocation_item").on(t.orderItemId,t.channel),check("wh_allocation_qty",sql`${t.qty}>0 AND ${t.shippedQty}>=0 AND ${t.releasedQty}>=0 AND ${t.shippedQty}+${t.releasedQty}<=${t.qty} AND ${t.returnedQty}>=0 AND ${t.returnedQty}<=${t.shippedQty}`)]);

export const wholesaleShipments = sqliteTable("wholesale_shipments", {
  id:text("id").primaryKey(), orderId:text("order_id").notNull().references(()=>wholesaleOrders.id),
  shipmentNo:text("shipment_no").notNull(), businessDate:text("business_date").notNull(), trackingNo:text("tracking_no").notNull().default(""),
  carrier:text("carrier").notNull(), warehouse:text("warehouse").notNull(), proofJson:text("proof_json").notNull().default("[]"),
  note:text("note").notNull().default(""), actorId:text("actor_id").notNull(), createdAt:text("created_at").notNull(),
},t=>[uniqueIndex("idx_wh_shipment_no").on(t.shipmentNo),index("idx_wh_shipment_month").on(t.businessDate,t.orderId)]);

export const wholesaleShipmentItems = sqliteTable("wholesale_shipment_items", {
  id:text("id").primaryKey(), shipmentId:text("shipment_id").notNull().references(()=>wholesaleShipments.id),
  orderItemId:text("order_item_id").notNull().references(()=>wholesaleOrderItems.id), qty:integer("qty").notNull(), amount:integer("amount").notNull(), allocationsJson:text("allocations_json").notNull(),
},t=>[uniqueIndex("idx_wh_shipment_item").on(t.shipmentId,t.orderItemId)]);

export const wholesaleFinanceEntries = sqliteTable("wholesale_finance_entries", {
  bankReceiptId:text("bank_receipt_id"), reversesId:text("reverses_id"),
  id:text("id").primaryKey(), orderId:text("order_id").notNull().references(()=>wholesaleOrders.id), kind:text("kind").notNull(), amount:integer("amount").notNull(), reference:text("reference").notNull(),
  businessDate:text("business_date").notNull(), note:text("note").notNull(), actorId:text("actor_id").notNull(), createdAt:text("created_at").notNull(),
},t=>[uniqueIndex("idx_wh_finance_reference_direct").on(t.kind,t.reference).where(sql`${t.bankReceiptId} IS NULL`),uniqueIndex("idx_wh_finance_reverses").on(t.reversesId).where(sql`${t.reversesId} IS NOT NULL`),index("idx_wh_finance_order").on(t.orderId),check("wh_finance_positive",sql`${t.amount}>0`)]);

export const wholesaleReturns = sqliteTable("wholesale_returns", {
  id:text("id").primaryKey(), orderId:text("order_id").notNull().references(()=>wholesaleOrders.id), orderItemId:text("order_item_id").notNull().references(()=>wholesaleOrderItems.id),
  qty:integer("qty").notNull(), amount:integer("amount").notNull(), resellable:integer("resellable").notNull().default(0), allocationsJson:text("allocations_json").notNull(), businessDate:text("business_date").notNull(),
  proofRef:text("proof_ref").notNull(), reason:text("reason").notNull(), actorId:text("actor_id").notNull(), createdAt:text("created_at").notNull(),
},t=>[index("idx_wh_return_month").on(t.businessDate,t.orderId)]);

export const wholesaleOperations = sqliteTable("wholesale_operations", {
  id:text("id").primaryKey(), orderId:text("order_id").notNull(), action:text("action").notNull(), actorId:text("actor_id").notNull(), requestJson:text("request_json").notNull(), guard:integer("guard").notNull(), createdAt:text("created_at").notNull(),
},t=>[check("wh_operation_atomic_guard",sql`${t.guard}=1`)]);

export const wholesaleFiles = sqliteTable("wholesale_files", {
  id:text("id").primaryKey(), orderId:text("order_id").notNull().references(()=>wholesaleOrders.id), objectKey:text("object_key").notNull(), name:text("name").notNull(), contentType:text("content_type").notNull(), size:integer("size").notNull(), actorId:text("actor_id").notNull(), createdAt:text("created_at").notNull(),
},t=>[index("idx_wh_files_order").on(t.orderId)]);
