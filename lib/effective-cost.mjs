// Shared effective-date selection. Backfilled history must not replace a newer business date.
export const compareEffectiveCosts=(a,b)=>String(b.effective_date).localeCompare(String(a.effective_date))||Number(b.version)-Number(a.version);
export function effectiveCost(rows,site,sku,date){return rows.filter(r=>r.site===site&&r.sku===sku&&r.effective_date<=date).sort(compareEffectiveCosts)[0]||null;}
