import {integer,sqliteTable,text,index,uniqueIndex} from "drizzle-orm/sqlite-core";
import {wholesaleCustomers} from "./wholesale-schema";
export const fieldRecords=sqliteTable("field_records",{
 id:text("id").primaryKey(),kind:text("kind").notNull(),salesUserId:text("sales_user_id").notNull(),customerId:text("customer_id").references(()=>wholesaleCustomers.id),businessDate:text("business_date").notNull(),endDate:text("end_date").notNull(),status:text("status").notNull().default("draft"),version:integer("version").notNull().default(1),dataJson:text("data_json").notNull(),createdAt:text("created_at").notNull(),updatedAt:text("updated_at").notNull(),submittedAt:text("submitted_at"),
},t=>[index("idx_field_owner_month").on(t.salesUserId,t.businessDate),index("idx_field_customer").on(t.customerId,t.kind)]);
export const fieldFiles=sqliteTable("field_files",{
 id:text("id").primaryKey(),recordId:text("record_id").notNull().references(()=>fieldRecords.id),objectKey:text("object_key").notNull(),name:text("name").notNull(),contentType:text("content_type").notNull(),size:integer("size").notNull(),sha256:text("sha256").notNull(),actorId:text("actor_id").notNull(),createdAt:text("created_at").notNull(),
},t=>[index("idx_field_files_record").on(t.recordId),uniqueIndex("idx_field_file_hash_record").on(t.recordId,t.sha256)]);
