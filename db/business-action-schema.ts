import {sqliteTable,text,integer,index,uniqueIndex} from 'drizzle-orm/sqlite-core';
export const businessActions=sqliteTable('business_actions',{
 id:text('id').primaryKey(),site:text('site').notNull(),channel:text('channel').notNull(),sku:text('sku').notNull(),kind:text('kind').notNull(),status:text('status').notNull().default('open'),
 ownerId:text('owner_id'),collaboratorsJson:text('collaborators_json').notNull().default('[]'),diagnosisJson:text('diagnosis_json').notNull().default('{}'),snapshotJson:text('snapshot_json').notNull(),everActive:integer('ever_active').notNull().default(0),
 dueAt:text('due_at').notNull(),reviewAt:text('review_at').notNull(),executedAt:text('executed_at'),executedCutoff:text('executed_cutoff'),resolvedAt:text('resolved_at'),reopenCount:integer('reopen_count').notNull().default(0),openedAt:text('opened_at').notNull(),updatedAt:text('updated_at').notNull(),version:integer('version').notNull().default(1),
},t=>[uniqueIndex('idx_business_actions_scope').on(t.site,t.channel,t.sku,t.kind),index('idx_business_actions_owner').on(t.ownerId,t.status,t.dueAt)]);
export const businessActionFinance=sqliteTable('business_action_finance',{
 id:text('id').primaryKey(),site:text('site').notNull(),channel:text('channel').notNull(),sku:text('sku').notNull(),startDate:text('start_date').notNull(),endDate:text('end_date').notNull(),basisHash:text('basis_hash').notNull(),dataJson:text('data_json').notNull(),source:text('source').notNull(),actorId:text('actor_id').notNull(),createdAt:text('created_at').notNull(),
},t=>[index('idx_business_action_finance_scope').on(t.site,t.channel,t.sku,t.startDate,t.endDate)]);
export const businessActionEvents=sqliteTable('business_action_events',{
 id:text('id').primaryKey(),actionId:text('action_id').notNull().references(()=>businessActions.id),event:text('event').notNull(),actorId:text('actor_id').notNull(),actorName:text('actor_name').notNull(),detailJson:text('detail_json').notNull(),createdAt:text('created_at').notNull(),
},t=>[index('idx_business_action_events').on(t.actionId,t.createdAt)]);
export const businessActionSourceClock=sqliteTable('business_action_source_clock',{id:text('id').primaryKey(),version:integer('version').notNull().default(1)});
