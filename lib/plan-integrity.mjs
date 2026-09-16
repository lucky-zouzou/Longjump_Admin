import {guardStatement} from './atomic.mjs';
// Run inside the approval transaction so data cannot change between validation and commitment.
export function planIntegrityGuards(db,actor,items){const statements=[];for(const item of items||[])for(const a of item.allocations||[]){statements.push(guardStatement(db,actor,'planDataGate',"NOT EXISTS (SELECT 1 FROM inventory_balances WHERE sku=? AND site=? AND channel=? AND (qty<0 OR qty<reserved_qty OR reserved_qty<0 OR pending_shelf_qty<0 OR quarantine_qty<0))",[item.sku,a.site,a.channel]));}return statements;}
