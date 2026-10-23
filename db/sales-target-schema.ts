import {sqliteTable,text,integer,real,index,uniqueIndex} from 'drizzle-orm/sqlite-core';
import {users} from './schema';
export const salesMonthlyTargets=sqliteTable('sales_monthly_targets',{
 id:text('id').primaryKey(),month:text('month').notNull(),site:text('site').notNull(),channel:text('channel').notNull(),
 ownerId:text('owner_id').notNull().references(()=>users.id),ownerName:text('owner_name').notNull(),
 revenueCny:real('revenue_cny').notNull(),quantity:integer('quantity').notNull(),budgetCny:real('budget_cny').notNull(),
 note:text('note').notNull(),version:integer('version').notNull().default(1),createdBy:text('created_by').notNull(),createdAt:text('created_at').notNull(),updatedBy:text('updated_by').notNull(),updatedAt:text('updated_at').notNull(),
},t=>[uniqueIndex('idx_sales_target_scope').on(t.month,t.site,t.channel)]);
export const salesTargetEvents=sqliteTable('sales_target_events',{
 id:text('id').primaryKey(),targetId:text('target_id').notNull().references(()=>salesMonthlyTargets.id),actorId:text('actor_id').notNull(),actorName:text('actor_name').notNull(),beforeJson:text('before_json'),afterJson:text('after_json').notNull(),reason:text('reason').notNull(),createdAt:text('created_at').notNull(),
},t=>[index('idx_sales_target_events').on(t.targetId,t.createdAt)]);
