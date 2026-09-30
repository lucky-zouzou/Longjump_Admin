import {sqliteTable,text,integer,uniqueIndex,index} from 'drizzle-orm/sqlite-core';
export const afterSales = sqliteTable('after_sales', {
 id:text('id').primaryKey(), ownerId:text('owner_id').notNull(), ownerName:text('owner_name').notNull(), site:text('site').notNull(), channel:text('channel').notNull(), businessDate:text('business_date').notNull(), caseNo:text('case_no').notNull(), sku:text('sku').notNull(), status:text('status').notNull().default('draft'), version:integer('version').notNull().default(1), dataJson:text('data_json').notNull().default('{}'), createdAt:text('created_at').notNull(), updatedAt:text('updated_at').notNull(),
},t=>[uniqueIndex('idx_after_sales_case').on(t.site,t.channel,t.caseNo,t.sku),index('idx_after_sales_month').on(t.businessDate,t.status)]);
export const afterSalesFiles=sqliteTable('after_sales_files',{
 id:text('id').primaryKey(),recordId:text('record_id').notNull().references(()=>afterSales.id),objectKey:text('object_key').notNull(),name:text('name').notNull(),contentType:text('content_type').notNull(),size:integer('size').notNull(),sha256:text('sha256').notNull(),actorId:text('actor_id').notNull(),createdAt:text('created_at').notNull(),
},t=>[uniqueIndex('idx_after_sales_file_hash').on(t.recordId,t.sha256)]);
