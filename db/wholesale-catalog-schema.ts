import {integer,sqliteTable,text,uniqueIndex,index} from 'drizzle-orm/sqlite-core';
export const wholesalePrices=sqliteTable('wholesale_prices',{
 id:text('id').primaryKey(),sku:text('sku').notNull(),version:integer('version').notNull(),status:text('status').notNull(),
 purchaseMinor:integer('purchase_minor').notNull(),freightMinor:integer('freight_minor').notNull(),taxMinor:integer('tax_minor').notNull(),inboundMinor:integer('inbound_minor').notNull(),
 standardMarkupBp:integer('standard_markup_bp').notNull(),minimumMarkupBp:integer('minimum_markup_bp').notNull(),rounding:integer('rounding').notNull(),standardPrice:integer('standard_price').notNull(),minimumPrice:integer('minimum_price').notNull(),
 validUntil:text('valid_until').notNull(),costReference:text('cost_reference').notNull(),reason:text('reason').notNull(),actorId:text('actor_id').notNull(),actorName:text('actor_name').notNull(),createdAt:text('created_at').notNull(),
},t=>[uniqueIndex('idx_wh_price_version').on(t.sku,t.version)]);
export const wholesalePriceSnapshots=sqliteTable('wholesale_price_snapshots',{
 id:text('id').primaryKey(),orderId:text('order_id').notNull(),itemId:text('item_id').notNull(),phase:text('phase').notNull(),sku:text('sku').notNull(),priceVersion:integer('price_version').notNull(),standardPrice:integer('standard_price'),minimumPrice:integer('minimum_price'),unitPrice:integer('unit_price').notNull(),status:text('status').notNull(),reason:text('reason').notNull().default(''),actorId:text('actor_id').notNull(),createdAt:text('created_at').notNull(),
},t=>[uniqueIndex('idx_wh_price_snapshot_phase').on(t.itemId,t.phase)]);
export const wholesalePriceRequests=sqliteTable('wholesale_price_requests',{
 id:text('id').primaryKey(),customerId:text('customer_id').notNull(),salesUserId:text('sales_user_id').notNull(),sku:text('sku').notNull(),qty:integer('qty').notNull(),requestedPrice:integer('requested_price').notNull(),requestedReason:text('requested_reason').notNull(),sourceVersion:integer('source_version').notNull(),status:text('status').notNull().default('pending'),approvedPrice:integer('approved_price'),validUntil:text('valid_until'),decisionReason:text('decision_reason'),decidedBy:text('decided_by'),decidedAt:text('decided_at'),usedOrderId:text('used_order_id'),version:integer('version').notNull().default(1),createdAt:text('created_at').notNull(),
},t=>[index('idx_wholesale_price_requests_owner').on(t.salesUserId,t.status)]);
