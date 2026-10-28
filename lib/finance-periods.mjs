import {fail,date} from './cost-profit-model.mjs';
export const financeRows=async(db,sql,args=[])=>(await db.prepare(sql).bind(...args).all()).results||[];
export async function financeClock(db){
 const names=['finance_clock','cost_clock','business_action_source_clock','wholesale_finance_clock','product_cost_clock'];
 return (await Promise.all(names.map(n=>db.prepare(`SELECT version FROM ${n} WHERE id='global'`).first()))).map(r=>r?.version||0).join(':');
}
export function financeGuardSql(version){const names=['finance_clock','cost_clock','business_action_source_clock','wholesale_finance_clock','product_cost_clock'];return {sql:names.map(n=>`COALESCE((SELECT version FROM ${n} WHERE id='global'),0)=?`).join(' AND '),args:version.split(':').map(Number)};}
export async function closedFinanceMonths(db){return financeRows(db,"SELECT p.* FROM finance_period_events p WHERE revision=(SELECT MAX(x.revision) FROM finance_period_events x WHERE x.month=p.month) AND status='closed' ORDER BY month");}
export async function assertFinanceOpen(db,businessDate){const d=date(businessDate);if((await closedFinanceMonths(db)).some(r=>d.slice(0,7)<=r.month))fail('该期间已关账；请管理员先反关账，保留原快照后再修订',409);}
export async function financialRates(db,month){const rs=await financeRows(db,'SELECT r.* FROM finance_rates r WHERE month=? AND revision=(SELECT MAX(x.revision) FROM finance_rates x WHERE x.month=r.month AND x.currency=r.currency)',[month]);return {CNY:{currency:'CNY',rate:1,id:'CNY-1',revision:1,month},...Object.fromEntries(rs.map(r=>[r.currency,r]))};}
