import {sqliteTable,text,integer,primaryKey,index,uniqueIndex} from 'drizzle-orm/sqlite-core';
export const promotionAvailability=sqliteTable('promotion_availability',{
 site:text('site').notNull(),channel:text('channel').notNull(),sku:text('sku').notNull(),listedSince:text('listed_since').notNull(),availableSince:text('available_since').notNull(),verifiedThrough:text('verified_through').notNull(),reference:text('reference').notNull(),note:text('note').notNull(),actorId:text('actor_id').notNull(),updatedAt:text('updated_at').notNull(),
},t=>[primaryKey({columns:[t.site,t.channel,t.sku]})]);
export const promotionStockDays=sqliteTable('promotion_stock_days',{
 site:text('site').notNull(),channel:text('channel').notNull(),sku:text('sku').notNull(),day:text('day').notNull(),minAvailable:integer('min_available').notNull(),firstAt:text('first_at').notNull(),lastAt:text('last_at').notNull(),
},t=>[primaryKey({columns:[t.site,t.channel,t.sku,t.day]})]);
export const zeroSalesAlerts=sqliteTable('zero_sales_alerts',{
 id:text('id').primaryKey(),site:text('site').notNull(),channel:text('channel').notNull(),sku:text('sku').notNull(),status:text('status').notNull(),dataJson:text('data_json').notNull(),openedAt:text('opened_at').notNull(),updatedAt:text('updated_at').notNull(),
},t=>[uniqueIndex('idx_zero_sales_scope').on(t.site,t.channel,t.sku)]);
export const promotions=sqliteTable('promotions',{
 id:text('id').primaryKey(),site:text('site').notNull(),channel:text('channel').notNull(),sku:text('sku').notNull(),ownerId:text('owner_id').notNull(),ownerName:text('owner_name').notNull(),status:text('status').notNull().default('draft'),version:integer('version').notNull().default(1),revision:integer('revision').notNull().default(1),dataJson:text('data_json').notNull(),createdAt:text('created_at').notNull(),updatedAt:text('updated_at').notNull(),
},t=>[index('idx_promotions_scope').on(t.site,t.channel,t.sku,t.status)]);
export const promotionFiles=sqliteTable('promotion_files',{
 id:text('id').primaryKey(),recordId:text('record_id').notNull().references(()=>promotions.id),revision:integer('revision').notNull(),purpose:text('purpose').notNull(),objectKey:text('object_key').notNull(),name:text('name').notNull(),contentType:text('content_type').notNull(),size:integer('size').notNull(),sha256:text('sha256').notNull(),actorId:text('actor_id').notNull(),createdAt:text('created_at').notNull(),
},t=>[uniqueIndex('idx_promotion_file_hash').on(t.recordId,t.revision,t.purpose,t.sha256)]);
