-- Existing notices remain issued/valid. New submissions explicitly enter pending.
ALTER TABLE factory_dispatch_notices ADD approval_status TEXT NOT NULL DEFAULT 'approved' CHECK(approval_status IN ('pending','approved','rejected'));
ALTER TABLE factory_dispatch_notices ADD approval_by TEXT;
ALTER TABLE factory_dispatch_notices ADD approval_at TEXT;
ALTER TABLE factory_dispatch_notices ADD approval_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE factory_dispatch_notices ADD demand_json TEXT NOT NULL DEFAULT '{}';
CREATE INDEX idx_dispatch_approval ON factory_dispatch_notices(approval_status,status);
CREATE TRIGGER immutable_dispatch_review BEFORE UPDATE ON factory_dispatch_notices
WHEN NEW.demand_json<>OLD.demand_json
 OR (OLD.approval_status<>'pending' AND (NEW.approval_status<>OLD.approval_status OR NEW.approval_by IS NOT OLD.approval_by OR NEW.approval_at IS NOT OLD.approval_at OR NEW.approval_reason<>OLD.approval_reason))
 OR (NEW.approval_status='pending' AND NEW.status NOT IN ('issued','cancelled'))
 OR (NEW.approval_status='rejected' AND NEW.status<>'cancelled')
 OR (OLD.approval_status='pending' AND NEW.approval_status<>'pending' AND (NEW.approval_by IS NULL OR NEW.approval_by=OLD.created_by OR NEW.approval_at IS NULL))
BEGIN SELECT RAISE(ABORT,'guard_dispatch_review'); END;
CREATE TRIGGER guard_unapproved_packing_file BEFORE INSERT ON factory_document_files
WHEN EXISTS(SELECT 1 FROM factory_dispatch_notices WHERE id=NEW.notice_id AND (approval_status<>'approved' OR status<>'issued'))
BEGIN SELECT RAISE(ABORT,'guard_unapproved_dispatch'); END;
-- Approved shipping allocations are separate from the immutable purchase demand.
ALTER TABLE series_production_order_items ADD dispatch_allocations_json TEXT;
ALTER TABLE factory_dispatch_notices ADD allocation_review_json TEXT NOT NULL DEFAULT '[]';
CREATE VIEW dispatch_scope_reservations AS
 SELECT json_extract(j.value,'$.itemId') item_id,n.id notice_id,n.site,n.channel,
 json_extract(j.value,'$.qty')-CASE WHEN n.approval_status='pending' THEN COALESCE((SELECT SUM(json_extract(t.value,'$.qty')) FROM json_each(j.value,'$.reallocation') t),0) ELSE 0 END qty
 FROM factory_dispatch_notices n,json_each(n.items_json) j WHERE n.status IN ('issued','packing_submitted','confirmed')
 UNION ALL
 SELECT json_extract(j.value,'$.itemId'),n.id,json_extract(t.value,'$.site'),json_extract(t.value,'$.channel'),json_extract(t.value,'$.qty')
 FROM factory_dispatch_notices n,json_each(n.items_json) j,json_each(j.value,'$.reallocation') t
 WHERE n.approval_status='pending' AND n.status IN ('issued','packing_submitted','confirmed');
CREATE VIEW production_scope_commitments AS
 SELECT item_id,site,channel,qty FROM dispatch_scope_reservations
 UNION ALL
 SELECT bi.production_order_item_id,l.site,l.channel,li.qty FROM transport_leg_items li JOIN transport_legs l ON l.id=li.leg_id JOIN transport_batch_items bi ON bi.id=li.batch_item_id
 UNION ALL
 SELECT si.production_order_item_id,json_extract(a.value,'$.site'),json_extract(a.value,'$.channel'),json_extract(a.value,'$.qty') FROM shipment_batch_items si,json_each(si.allocations_json) a;
DROP TRIGGER guard_dispatch_scope;
CREATE TRIGGER guard_dispatch_scope AFTER INSERT ON factory_dispatch_notices
WHEN EXISTS(SELECT 1 FROM production_scope_commitments c JOIN series_production_order_items i ON i.id=c.item_id JOIN series_purchase_order_items p ON p.id=i.purchase_order_item_id WHERE i.production_order_id=NEW.production_order_id GROUP BY c.item_id,c.site,c.channel
 HAVING SUM(c.qty)>COALESCE((SELECT SUM(json_extract(a.value,'$.qty')) FROM json_each(COALESCE(i.dispatch_allocations_json,p.allocations_json)) a WHERE json_extract(a.value,'$.site')=c.site AND json_extract(a.value,'$.channel')=c.channel),0))
BEGIN SELECT RAISE(ABORT,'guard_dispatch_scope_exceeds'); END;
CREATE TRIGGER guard_dispatch_scope_review AFTER UPDATE ON factory_dispatch_notices
WHEN EXISTS(SELECT 1 FROM production_scope_commitments c JOIN series_production_order_items i ON i.id=c.item_id JOIN series_purchase_order_items p ON p.id=i.purchase_order_item_id WHERE i.production_order_id=NEW.production_order_id GROUP BY c.item_id,c.site,c.channel
 HAVING SUM(c.qty)>COALESCE((SELECT SUM(json_extract(a.value,'$.qty')) FROM json_each(COALESCE(i.dispatch_allocations_json,p.allocations_json)) a WHERE json_extract(a.value,'$.site')=c.site AND json_extract(a.value,'$.channel')=c.channel),0))
BEGIN SELECT RAISE(ABORT,'guard_dispatch_scope_exceeds'); END;
DROP TRIGGER guard_transport_notice_scope;
CREATE TRIGGER guard_transport_notice_scope AFTER INSERT ON transport_leg_items
WHEN EXISTS(SELECT 1 FROM production_scope_commitments c JOIN series_production_order_items i ON i.id=c.item_id JOIN series_purchase_order_items p ON p.id=i.purchase_order_item_id WHERE i.id=(SELECT production_order_item_id FROM transport_batch_items WHERE id=NEW.batch_item_id) GROUP BY c.item_id,c.site,c.channel
 HAVING SUM(c.qty)>COALESCE((SELECT SUM(json_extract(a.value,'$.qty')) FROM json_each(COALESCE(i.dispatch_allocations_json,p.allocations_json)) a WHERE json_extract(a.value,'$.site')=c.site AND json_extract(a.value,'$.channel')=c.channel),0))
BEGIN SELECT RAISE(ABORT,'guard_transport_notice_scope_exceeds'); END;
DROP TRIGGER guard_legacy_notice_scope;
CREATE TRIGGER guard_legacy_notice_scope AFTER INSERT ON shipment_batch_items
WHEN EXISTS(SELECT 1 FROM production_scope_commitments c JOIN series_production_order_items i ON i.id=c.item_id JOIN series_purchase_order_items p ON p.id=i.purchase_order_item_id WHERE i.id=NEW.production_order_item_id GROUP BY c.item_id,c.site,c.channel
 HAVING SUM(c.qty)>COALESCE((SELECT SUM(json_extract(a.value,'$.qty')) FROM json_each(COALESCE(i.dispatch_allocations_json,p.allocations_json)) a WHERE json_extract(a.value,'$.site')=c.site AND json_extract(a.value,'$.channel')=c.channel),0))
BEGIN SELECT RAISE(ABORT,'guard_legacy_notice_scope_exceeds'); END;
CREATE TRIGGER guard_dispatch_allocation_total BEFORE UPDATE OF dispatch_allocations_json ON series_production_order_items
WHEN NEW.dispatch_allocations_json IS NULL OR json_valid(NEW.dispatch_allocations_json)=0
 OR COALESCE((SELECT SUM(json_extract(a.value,'$.qty')) FROM json_each(NEW.dispatch_allocations_json) a),0)<>NEW.planned_qty
 OR EXISTS(SELECT 1 FROM json_each(NEW.dispatch_allocations_json) a WHERE json_extract(a.value,'$.qty')<0 OR typeof(json_extract(a.value,'$.qty'))<>'integer')
BEGIN SELECT RAISE(ABORT,'guard_dispatch_allocation_total'); END;
CREATE TRIGGER immutable_dispatch_allocation_review BEFORE UPDATE ON factory_dispatch_notices
WHEN OLD.approval_status<>'pending' AND NEW.allocation_review_json<>OLD.allocation_review_json
BEGIN SELECT RAISE(ABORT,'immutable_factory_document'); END;
