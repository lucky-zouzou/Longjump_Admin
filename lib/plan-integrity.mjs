import {guardStatement,ConflictError} from './atomic.mjs';
const key=r=>JSON.stringify([r.sku,r.site,r.channel]);
export function inspectPlanInventory(items,balances){
 const scopes=new Map();for(const item of items||[])for(const a of item.allocations||[])scopes.set(key({...a,sku:item.sku}),{sku:item.sku,site:a.site,channel:a.channel});
 const indexed=new Map(balances.map(r=>[key(r),r]));
 const snapshot=[...scopes].sort(([a],[b])=>a.localeCompare(b)).map(([k,s])=>{const r=indexed.get(k);return {...s,exists:Boolean(r),qty:Number(r?.qty||0),reserved_qty:Number(r?.reserved_qty||0),pending_shelf_qty:Number(r?.pending_shelf_qty||0),quarantine_qty:Number(r?.quarantine_qty||0)};});
 const issues=snapshot.flatMap(r=>{const reasons=[];if(r.reserved_qty<0)reasons.push('预留数量为负');if(r.pending_shelf_qty<0)reasons.push('待上架数量为负');if(r.quarantine_qty<0)reasons.push('隔离数量为负');if(r.reserved_qty>0&&r.qty<r.reserved_qty)reasons.push('账面库存不足以覆盖预留');const blocking=reasons.length>0;if(r.qty<0)reasons.push('账面负库存：需核对销售扣库与入库记录');return reasons.length?[{...r,level:blocking?'blocking':'warning',reason:reasons.join('；')}]:[];});
 return {snapshot,issues,blocking:issues.filter(r=>r.level==='blocking').length,warnings:issues.filter(r=>r.level==='warning').length};
}
export async function checkPlanInventory(db,items){return inspectPlanInventory(items,(await db.prepare('SELECT sku,site,channel,qty,reserved_qty,pending_shelf_qty,quarantine_qty FROM inventory_balances').all()).results||[]);}
export function confirmPlanInventory(check,payload){
 if(check.blocking)throw new ConflictError(`库存结构异常共${check.blocking}项，请先处理：${check.issues.filter(r=>r.level==='blocking').map(r=>`${r.sku} / ${r.site} / ${r.channel}：${r.reason}`).join('；')}`);
 if(payload.inventorySnapshot&&JSON.stringify(payload.inventorySnapshot)!==JSON.stringify(check.snapshot))throw new ConflictError("库存已变化，请重新检查异常清单；本次操作未生效");
 if(check.warnings&&(payload.inventoryAcknowledged!==true||JSON.stringify(payload.inventorySnapshot)!==JSON.stringify(check.snapshot)))throw new ConflictError('负库存预警尚未确认或库存已变化，请重新检查异常清单并确认；本次操作未生效');
}
// Snapshot guards keep the administrator's reviewed quantities unchanged until commit.
export function reviewedInventoryGuards(db,actor,check){return check.snapshot.map(r=>guardStatement(db,actor,'planInventoryReview',r.exists?'EXISTS (SELECT 1 FROM inventory_balances WHERE sku=? AND site=? AND channel=? AND qty=? AND reserved_qty=? AND pending_shelf_qty=? AND quarantine_qty=?)':'NOT EXISTS (SELECT 1 FROM inventory_balances WHERE sku=? AND site=? AND channel=?)',r.exists?[r.sku,r.site,r.channel,r.qty,r.reserved_qty,r.pending_shelf_qty,r.quarantine_qty]:[r.sku,r.site,r.channel]));}
// Legacy change approvals retain strict protection until a reviewed snapshot is supplied.
export function planIntegrityGuards(db,actor,items){const statements=[];for(const item of items||[])for(const a of item.allocations||[]){statements.push(guardStatement(db,actor,'planDataGate',"NOT EXISTS (SELECT 1 FROM inventory_balances WHERE sku=? AND site=? AND channel=? AND (qty<0 OR qty<reserved_qty OR reserved_qty<0 OR pending_shelf_qty<0 OR quarantine_qty<0))",[item.sku,a.site,a.channel]));}return statements;}
