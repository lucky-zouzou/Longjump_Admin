-- A rejected or cancelled correction may be resubmitted from that final leaf.
-- Its immutable original-approval snapshot continues the same validated chain.
DROP TRIGGER guard_dispatch_correction_source;
CREATE TRIGGER guard_dispatch_correction_source BEFORE INSERT ON factory_dispatch_notices
WHEN (NEW.correction_of_id IS NULL AND (NEW.correction_approval_at IS NOT NULL OR NEW.correction_reason<>''))
 OR (NEW.correction_of_id IS NOT NULL AND (
  NEW.approval_status<>'pending' OR NEW.status<>'issued' OR NEW.packing_json<>'{}'
  OR length(trim(NEW.correction_reason))<4
  OR NOT EXISTS(SELECT 1 FROM factory_dispatch_notices old WHERE old.id=NEW.correction_of_id
    AND old.status='cancelled'
    AND ((old.correction_of_id IS NULL AND old.approval_status='approved' AND old.approval_at IS NOT NULL)
      OR (old.correction_of_id IS NOT NULL AND old.correction_approval_at IS NOT NULL))
    AND json_extract(old.packing_json,'$.submittedAt') IS NULL AND old.transport_batch_id IS NULL
    AND old.production_order_id=NEW.production_order_id AND old.purchase_order_id=NEW.purchase_order_id
    AND old.factory_user_id=NEW.factory_user_id AND old.supply_user_id=NEW.supply_user_id
    AND old.warehouse_id=NEW.warehouse_id AND old.site=NEW.site AND old.channel=NEW.channel
    AND NEW.correction_approval_at IS COALESCE(old.correction_approval_at,old.approval_at))))
BEGIN SELECT RAISE(ABORT,'guard_dispatch_correction_source'); END;
