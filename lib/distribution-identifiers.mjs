// Public business numbers are independent of immutable internal UUIDs.
// Never rewrite an existing number when a workflow or company name changes.
const destinations=new Set(['wholesale_customers.code','wholesale_orders.order_no','domestic_customers.code','domestic_orders.order_no','marketing_sample_orders.order_no']);
const alphabet='0123456789';
export function randomBusinessNumber(country,random=crypto.getRandomValues.bind(crypto)){
 if(!['CN','ID'].includes(country))throw new Error('Unsupported distribution country');
 let suffix='';while(suffix.length<6){for(const value of random(new Uint8Array(12))){if(value<250)suffix+=alphabet[value%10];if(suffix.length===6)break;}}
 return country+'-'+suffix;
}
export async function uniqueBusinessNumber(db,table,column,country,{candidate=randomBusinessNumber}={}){
 if(!destinations.has(table+'.'+column))throw new Error('Unsupported business number destination');
 for(let attempt=0;attempt<24;attempt++){
  const value=candidate(country);if(!new RegExp('^'+country+'-[0-9]{6}$').test(value))throw new Error('Invalid business number candidate');
  if(!await db.prepare(`SELECT 1 FROM ${table} WHERE ${column}=? LIMIT 1`).bind(value).first())return value;
 }
 throw Object.assign(new Error('编号生成遇到冲突，请重试；未覆盖原记录'),{status:409});
}
