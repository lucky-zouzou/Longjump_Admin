ALTER TABLE series_purchase_orders ADD document_json text NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE series_purchase_orders ADD workflow_version integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE UNIQUE INDEX idx_purchase_document_no ON series_purchase_orders(order_ref) WHERE workflow_version=1;
--> statement-breakpoint
CREATE TABLE purchase_plan_drafts (
 month text PRIMARY KEY NOT NULL,
 source_key text NOT NULL,
 documents_json text NOT NULL,
 version integer NOT NULL DEFAULT 1,
 actor_id text NOT NULL,
 updated_at text NOT NULL
);
--> statement-breakpoint
CREATE TABLE factory_dispatch_notices (
 id text PRIMARY KEY NOT NULL,
 notice_no text NOT NULL UNIQUE,
 production_order_id text NOT NULL REFERENCES series_production_orders(id),
 purchase_order_id text NOT NULL REFERENCES series_purchase_orders(id),
 factory_user_id text NOT NULL,
 supply_user_id text NOT NULL,
 site text NOT NULL,
 channel text NOT NULL,
 warehouse_id text NOT NULL REFERENCES warehouses(id),
 warehouse_name text NOT NULL,
 shipping_date text NOT NULL,
 receiver text NOT NULL,
 receiver_phone text NOT NULL,
 receiver_address text NOT NULL,
 instructions text NOT NULL DEFAULT '',
 items_json text NOT NULL,
 status text NOT NULL DEFAULT 'issued' CHECK(status IN ('issued','packing_submitted','confirmed','linked','cancelled')),
 packing_json text NOT NULL DEFAULT '{}',
 packing_no text,
 transport_batch_id text REFERENCES transport_batches(id),
 version integer NOT NULL DEFAULT 1,
 created_by text NOT NULL,
 created_at text NOT NULL,
 updated_at text NOT NULL,
 CHECK ((status='linked')=(transport_batch_id IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_factory_packing_no ON factory_dispatch_notices(packing_no) WHERE packing_no IS NOT NULL;
--> statement-breakpoint
CREATE INDEX idx_dispatch_production ON factory_dispatch_notices(production_order_id,status);
--> statement-breakpoint
CREATE TRIGGER immutable_approved_purchase_document BEFORE UPDATE ON series_purchase_orders
WHEN OLD.workflow_version=1 AND (NEW.document_json<>OLD.document_json OR NEW.workflow_version<>OLD.workflow_version OR NEW.order_ref<>OLD.order_ref)
BEGIN SELECT RAISE(ABORT,'immutable_approved_purchase_document'); END;
--> statement-breakpoint
CREATE TRIGGER immutable_dispatch_contents BEFORE UPDATE ON factory_dispatch_notices
WHEN NEW.items_json<>OLD.items_json OR NEW.production_order_id<>OLD.production_order_id OR NEW.purchase_order_id<>OLD.purchase_order_id OR NEW.factory_user_id<>OLD.factory_user_id OR NEW.warehouse_id<>OLD.warehouse_id OR NEW.site<>OLD.site OR NEW.channel<>OLD.channel OR NEW.notice_no<>OLD.notice_no
 OR (OLD.status IN ('confirmed','linked','cancelled') AND NEW.packing_json<>OLD.packing_json)
 OR (OLD.status='linked' AND (NEW.status<>OLD.status OR NEW.transport_batch_id<>OLD.transport_batch_id))
BEGIN SELECT RAISE(ABORT,'immutable_factory_document'); END;
--> statement-breakpoint
CREATE TABLE factory_document_files (
 id text PRIMARY KEY NOT NULL,
 notice_id text NOT NULL REFERENCES factory_dispatch_notices(id),
 object_key text NOT NULL UNIQUE,
 name text NOT NULL,
 content_type text NOT NULL,
 size integer NOT NULL,
 actor_id text NOT NULL,
 actor_name text NOT NULL,
 created_at text NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER guard_dispatch_capacity BEFORE INSERT ON factory_dispatch_notices
WHEN EXISTS (SELECT 1 FROM json_each(NEW.items_json) j
 WHERE CAST(json_extract(j.value,'$.qty') AS integer)<=0 OR
 CAST(json_extract(j.value,'$.qty') AS integer)
 + COALESCE((SELECT SUM(json_extract(k.value,'$.qty')) FROM factory_dispatch_notices n,json_each(n.items_json) k WHERE n.status IN ('issued','packing_submitted','confirmed') AND json_extract(k.value,'$.itemId')=json_extract(j.value,'$.itemId')),0)
 + COALESCE((SELECT SUM(shipped_qty) FROM transport_batch_items WHERE production_order_item_id=json_extract(j.value,'$.itemId')),0)
 + COALESCE((SELECT SUM(shipped_qty) FROM shipment_batch_items WHERE production_order_item_id=json_extract(j.value,'$.itemId')),0)
 > COALESCE((SELECT MIN(i.produced_qty,i.planned_qty) FROM series_production_order_items i JOIN series_production_orders o ON o.id=i.production_order_id WHERE i.id=json_extract(j.value,'$.itemId') AND o.id=NEW.production_order_id AND o.qc_status='passed'),0))
BEGIN SELECT RAISE(ABORT,'guard_dispatch_capacity'); END;
--> statement-breakpoint
CREATE TRIGGER guard_transport_dispatch_reservation BEFORE INSERT ON transport_batch_items
WHEN NEW.shipped_qty
 + COALESCE((SELECT SUM(shipped_qty) FROM transport_batch_items WHERE production_order_item_id=NEW.production_order_item_id),0)
 + COALESCE((SELECT SUM(shipped_qty) FROM shipment_batch_items WHERE production_order_item_id=NEW.production_order_item_id),0)
 + COALESCE((SELECT SUM(json_extract(j.value,'$.qty')) FROM factory_dispatch_notices n,json_each(n.items_json) j WHERE n.status IN ('issued','packing_submitted','confirmed') AND json_extract(j.value,'$.itemId')=NEW.production_order_item_id),0)
 > COALESCE((SELECT MIN(planned_qty,produced_qty) FROM series_production_order_items WHERE id=NEW.production_order_item_id),0)
BEGIN SELECT RAISE(ABORT,'guard_dispatch_reserved_for_notice'); END;
--> statement-breakpoint
CREATE TRIGGER guard_shipment_dispatch_reservation BEFORE INSERT ON shipment_batch_items
WHEN NEW.shipped_qty
 + COALESCE((SELECT SUM(shipped_qty) FROM transport_batch_items WHERE production_order_item_id=NEW.production_order_item_id),0)
 + COALESCE((SELECT SUM(shipped_qty) FROM shipment_batch_items WHERE production_order_item_id=NEW.production_order_item_id),0)
 + COALESCE((SELECT SUM(json_extract(j.value,'$.qty')) FROM factory_dispatch_notices n,json_each(n.items_json) j WHERE n.status IN ('issued','packing_submitted','confirmed') AND json_extract(j.value,'$.itemId')=NEW.production_order_item_id),0)
 > COALESCE((SELECT MIN(planned_qty,produced_qty) FROM series_production_order_items WHERE id=NEW.production_order_item_id),0)
BEGIN SELECT RAISE(ABORT,'guard_dispatch_reserved_for_notice'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_purchase_plan_drafts_insert BEFORE INSERT ON purchase_plan_drafts
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_purchase_plan_drafts_update BEFORE UPDATE ON purchase_plan_drafts
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_purchase_plan_drafts_delete BEFORE DELETE ON purchase_plan_drafts
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_factory_dispatch_notices_insert BEFORE INSERT ON factory_dispatch_notices
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_factory_dispatch_notices_update BEFORE UPDATE ON factory_dispatch_notices
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_factory_dispatch_notices_delete BEFORE DELETE ON factory_dispatch_notices
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_factory_document_files_insert BEFORE INSERT ON factory_document_files
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_factory_document_files_update BEFORE UPDATE ON factory_document_files
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_factory_document_files_delete BEFORE DELETE ON factory_document_files
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
--> statement-breakpoint
CREATE TRIGGER guard_dispatch_scope BEFORE INSERT ON factory_dispatch_notices
WHEN EXISTS(SELECT 1 FROM json_each(NEW.items_json) j WHERE json_extract(j.value,'$.qty')
 + COALESCE((SELECT SUM(json_extract(k.value,'$.qty')) FROM factory_dispatch_notices n,json_each(n.items_json) k WHERE n.status IN ('issued','packing_submitted','confirmed') AND n.site=NEW.site AND n.channel=NEW.channel AND json_extract(k.value,'$.itemId')=json_extract(j.value,'$.itemId')),0)
 + COALESCE((SELECT SUM(li.qty) FROM transport_leg_items li JOIN transport_legs l ON l.id=li.leg_id JOIN transport_batch_items bi ON bi.id=li.batch_item_id WHERE bi.production_order_item_id=json_extract(j.value,'$.itemId') AND l.site=NEW.site AND l.channel=NEW.channel),0)
 + COALESCE((SELECT SUM(json_extract(a.value,'$.qty')) FROM shipment_batch_items si,json_each(si.allocations_json) a WHERE si.production_order_item_id=json_extract(j.value,'$.itemId') AND json_extract(a.value,'$.site')=NEW.site AND json_extract(a.value,'$.channel')=NEW.channel),0)
 > COALESCE((SELECT SUM(json_extract(a.value,'$.qty')) FROM series_production_order_items i JOIN series_purchase_order_items p ON p.id=i.purchase_order_item_id,json_each(p.allocations_json) a WHERE i.id=json_extract(j.value,'$.itemId') AND json_extract(a.value,'$.site')=NEW.site AND json_extract(a.value,'$.channel')=NEW.channel),0))
BEGIN SELECT RAISE(ABORT,'guard_dispatch_scope_exceeds'); END;
--> statement-breakpoint
CREATE TRIGGER guard_transport_notice_scope BEFORE INSERT ON transport_leg_items
WHEN EXISTS(SELECT 1 FROM transport_batch_items bi JOIN transport_legs l ON l.id=NEW.leg_id JOIN series_production_order_items i ON i.id=bi.production_order_item_id JOIN series_purchase_order_items p ON p.id=i.purchase_order_item_id WHERE bi.id=NEW.batch_item_id AND NEW.qty
 + COALESCE((SELECT SUM(li.qty) FROM transport_leg_items li JOIN transport_legs ol ON ol.id=li.leg_id JOIN transport_batch_items ob ON ob.id=li.batch_item_id WHERE ob.production_order_item_id=i.id AND ol.site=l.site AND ol.channel=l.channel),0)
 + COALESCE((SELECT SUM(json_extract(a.value,'$.qty')) FROM shipment_batch_items si,json_each(si.allocations_json) a WHERE si.production_order_item_id=i.id AND json_extract(a.value,'$.site')=l.site AND json_extract(a.value,'$.channel')=l.channel),0)
 + COALESCE((SELECT SUM(json_extract(a.value,'$.qty')) FROM factory_dispatch_notices n,json_each(n.items_json) a WHERE n.status IN ('issued','packing_submitted','confirmed') AND n.site=l.site AND n.channel=l.channel AND json_extract(a.value,'$.itemId')=i.id),0)
 > COALESCE((SELECT SUM(json_extract(a.value,'$.qty')) FROM json_each(p.allocations_json) a WHERE json_extract(a.value,'$.site')=l.site AND json_extract(a.value,'$.channel')=l.channel),0))
BEGIN SELECT RAISE(ABORT,'guard_transport_notice_scope_exceeds'); END;
--> statement-breakpoint
CREATE TRIGGER guard_legacy_notice_scope BEFORE INSERT ON shipment_batch_items
WHEN EXISTS(SELECT 1 FROM json_each(NEW.allocations_json) a WHERE json_extract(a.value,'$.qty')
 + COALESCE((SELECT SUM(json_extract(k.value,'$.qty')) FROM factory_dispatch_notices n,json_each(n.items_json) k WHERE n.status IN ('issued','packing_submitted','confirmed') AND n.site=json_extract(a.value,'$.site') AND n.channel=json_extract(a.value,'$.channel') AND json_extract(k.value,'$.itemId')=NEW.production_order_item_id),0)
 + COALESCE((SELECT SUM(li.qty) FROM transport_leg_items li JOIN transport_legs l ON l.id=li.leg_id JOIN transport_batch_items bi ON bi.id=li.batch_item_id WHERE bi.production_order_item_id=NEW.production_order_item_id AND l.site=json_extract(a.value,'$.site') AND l.channel=json_extract(a.value,'$.channel')),0)
 + COALESCE((SELECT SUM(json_extract(k.value,'$.qty')) FROM shipment_batch_items si,json_each(si.allocations_json) k WHERE si.production_order_item_id=NEW.production_order_item_id AND json_extract(k.value,'$.site')=json_extract(a.value,'$.site') AND json_extract(k.value,'$.channel')=json_extract(a.value,'$.channel')),0)
 > COALESCE((SELECT SUM(json_extract(k.value,'$.qty')) FROM series_production_order_items i JOIN series_purchase_order_items p ON p.id=i.purchase_order_item_id,json_each(p.allocations_json) k WHERE i.id=NEW.production_order_item_id AND json_extract(k.value,'$.site')=json_extract(a.value,'$.site') AND json_extract(k.value,'$.channel')=json_extract(a.value,'$.channel')),0))
BEGIN SELECT RAISE(ABORT,'guard_legacy_notice_scope_exceeds'); END;
