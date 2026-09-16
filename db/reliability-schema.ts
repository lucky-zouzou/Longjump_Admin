import {sqliteTable,text,integer,real,uniqueIndex,index,check} from 'drizzle-orm/sqlite-core';
import {sql} from 'drizzle-orm';

export const systemOperations=sqliteTable('system_operations',{
  id:text('id').primaryKey(),actorId:text('actor_id').notNull(),action:text('action').notNull(),requestJson:text('request_json').notNull(),guard:integer('guard').notNull(),createdAt:text('created_at').notNull(),
},t=>[check('system_atomic_guard',sql`${t.guard}=1`)]);
export const returnResolutions=sqliteTable('wholesale_return_resolutions',{
  id:text('id').primaryKey(),returnId:text('return_id').notNull(),channel:text('channel').notNull(),qty:integer('qty').notNull(),resolution:text('resolution').notNull(),reason:text('reason').notNull(),actorId:text('actor_id').notNull(),createdAt:text('created_at').notNull(),
},t=>[index('idx_return_resolution_source').on(t.returnId,t.channel),check('return_resolution_qty',sql`${t.qty}>0 AND ${t.resolution} IN ('release','writeoff')`)]);
export const bankReceipts=sqliteTable('wholesale_bank_receipts',{
  id:text('id').primaryKey(),customerId:text('customer_id').notNull(),reference:text('reference').notNull(),bankAccount:text('bank_account').notNull().default(''),businessDate:text('business_date').notNull(),amount:integer('amount').notNull(),allocatedAmount:integer('allocated_amount').notNull().default(0),refundedAmount:integer('refunded_amount').notNull().default(0),voidedAmount:integer('voided_amount').notNull().default(0),version:integer('version').notNull().default(1),note:text('note').notNull(),actorId:text('actor_id').notNull(),createdAt:text('created_at').notNull(),
},t=>[uniqueIndex('idx_bank_receipt_reference').on(t.reference),index('idx_bank_receipt_customer').on(t.customerId),check('bank_receipt_balance',sql`${t.amount}>0 AND ${t.allocatedAmount}>=0 AND ${t.refundedAmount}>=0 AND ${t.voidedAmount}>=0 AND ${t.allocatedAmount}+${t.refundedAmount}+${t.voidedAmount}<=${t.amount}`)]);
export const bankEvents=sqliteTable('wholesale_bank_events',{
  id:text('id').primaryKey(),receiptId:text('receipt_id').notNull(),kind:text('kind').notNull(),amount:integer('amount').notNull(),businessDate:text('business_date').notNull(),reference:text('reference').notNull(),note:text('note').notNull(),actorId:text('actor_id').notNull(),createdAt:text('created_at').notNull(),
},t=>[uniqueIndex('idx_bank_event_reference').on(t.kind,t.reference),index('idx_bank_event_receipt').on(t.receiptId),check('bank_event_amount',sql`${t.amount}>0`)]);
export const financePeriods=sqliteTable('wholesale_finance_periods',{
  month:text('month').primaryKey(),status:text('status').notNull(),version:integer('version').notNull().default(1),snapshotJson:text('snapshot_json').notNull(),note:text('note').notNull(),actorId:text('actor_id').notNull(),updatedAt:text('updated_at').notNull(),
});
export const financeClock=sqliteTable('wholesale_finance_clock',{id:text('id').primaryKey(),version:integer('version').notNull().default(0)});
export const planChanges=sqliteTable('plan_changes',{
  id:text('id').primaryKey(),approvalId:text('approval_id').notNull(),baseVersion:integer('base_version').notNull(),version:integer('version').notNull().default(1),month:text('month').notNull(),status:text('status').notNull().default('pending'),oldJson:text('old_json').notNull(),newJson:text('new_json').notNull(),reason:text('reason').notNull(),creatorId:text('creator_id').notNull(),decidedBy:text('decided_by'),decisionNote:text('decision_note').notNull().default(''),createdAt:text('created_at').notNull(),updatedAt:text('updated_at').notNull(),
},t=>[index('idx_plan_changes_approval').on(t.approvalId),uniqueIndex('idx_plan_change_pending').on(t.approvalId).where(sql`${t.status}='pending'`)]);
export const supplyPolicies=sqliteTable('supply_policies',{
  id:text('id').primaryKey(),sku:text('sku').notNull(),site:text('site').notNull(),channel:text('channel').notNull(),supplier:text('supplier').notNull(),transportMode:text('transport_mode').notNull().default('sea'),productionDays:integer('production_days').notNull().default(21),transportDays:integer('transport_days').notNull().default(35),safetyDays:integer('safety_days').notNull().default(0),reviewDays:integer('review_days').notNull().default(7),serviceLevel:real('service_level').notNull().default(.95),seasonFactor:real('season_factor').notNull().default(1),lifecycle:text('lifecycle').notNull().default('normal'),campaignFactor:real('campaign_factor').notNull().default(1),campaignStart:text('campaign_start').notNull().default(''),campaignEnd:text('campaign_end').notNull().default(''),outlierMultiple:real('outlier_multiple').notNull().default(4),minOrderQty:integer('min_order_qty').notNull().default(1),orderMultiple:integer('order_multiple').notNull().default(1),capacityQty:integer('capacity_qty'),warehouseQty:integer('warehouse_qty'),budgetAmount:real('budget_amount'),unitCost:real('unit_cost').notNull().default(0),currency:text('currency').notNull().default('CNY'),maxCoverDays:integer('max_cover_days').notNull().default(120),note:text('note').notNull().default(''),version:integer('version').notNull().default(1),updatedAt:text('updated_at').notNull(),
},t=>[uniqueIndex('idx_supply_policy_scope').on(t.sku,t.site,t.channel)]);
export const salesCorrections=sqliteTable('sales_demand_corrections',{
  id:text('id').primaryKey(),sku:text('sku').notNull(),site:text('site').notNull(),channel:text('channel').notNull(),businessDate:text('business_date').notNull(),stockout:integer('stockout').notNull().default(0),returnQty:integer('return_qty').notNull().default(0),excludeSpike:integer('exclude_spike').notNull().default(0),reason:text('reason').notNull(),actorId:text('actor_id').notNull(),updatedAt:text('updated_at').notNull(),
},t=>[uniqueIndex('idx_demand_correction_scope').on(t.sku,t.site,t.channel,t.businessDate)]);
export const forecastSnapshots=sqliteTable('forecast_snapshots',{
  id:text('id').primaryKey(),month:text('month').notNull(),sku:text('sku').notNull(),site:text('site').notNull(),channel:text('channel').notNull(),systemQty:integer('system_qty').notNull(),forecastSales:real('forecast_sales').notNull(),operatorQty:integer('operator_qty').notNull(),approvedQty:integer('approved_qty'),modelJson:text('model_json').notNull(),approvalId:text('approval_id'),createdAt:text('created_at').notNull(),
},t=>[uniqueIndex('idx_forecast_month_scope').on(t.month,t.sku,t.site,t.channel)]);
export const maintenance=sqliteTable('system_maintenance',{
  id:text('id').primaryKey(),mode:text('mode').notNull().default('normal'),tokenHash:text('token_hash').notNull().default(''),actorId:text('actor_id').notNull().default(''),expiresAt:text('expires_at').notNull().default(''),updatedAt:text('updated_at').notNull(),
});
