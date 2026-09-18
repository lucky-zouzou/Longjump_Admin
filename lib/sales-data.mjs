export const SITE_CURRENCIES={'马来西亚':'MYR','印尼':'IDR','泰国':'THB','越南':'VND','菲律宾':'PHP'};
export const SALES_CURRENCIES=['IDR','MYR','THB','VND','PHP','USD','CNY'];
const blank=v=>v===undefined||v===null||v==='';
// Monetary values use at most two decimal places. Blank and explicit zero are distinct.
export function salesMoney(value,label='金额'){
  if(blank(value)||typeof value==='string'&&!value.trim())return null;
  if(!['string','number'].includes(typeof value))throw Error(`${label}必须是非负金额`);
  const text=String(value).trim();
  if(!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text))throw Error(`${label}请使用非负数字，小数点用英文句点，最多两位小数`);
  const n=Number(text.replaceAll(',',''));
  if(!Number.isFinite(n)||n>1e12)throw Error(`${label}不能超过1万亿`);
  return Math.round(n*100)/100;
}
export function salesFinancials(row,defaultCurrency=''){
  const currency=String(row.currency||defaultCurrency).trim().toUpperCase();
  if(currency&&!SALES_CURRENCIES.includes(currency))throw Error('币种须为 IDR、MYR、THB、VND、PHP、USD 或 CNY');
  const unitPrice=salesMoney(row.unitPrice,'成交单价'),explicit=salesMoney(row.amount,'销售额'),adCost=salesMoney(row.adCost,'投放成本');
  const amount=explicit??(unitPrice===null?null:Math.round(unitPrice*row.qty*100)/100);
  if(amount!==null&&(!Number.isSafeInteger(Math.round(amount*100))||amount>1e12))throw Error('销售额过大，请拆分数据');
  if(Number(row.qty)===0&&(adCost===null||adCost<=0||amount!==null&&amount!==0))throw Error('零销量行仅用于记录有投放未出单的SKU：投放成本须大于0，销售额为0或留空');
  return {currency,amount:Number(row.qty)===0?0:amount,adCost,unitPrice};
}
export function normalizeSales(rows,defaultCurrency=''){
  if(!Array.isArray(rows)||!rows.length||rows.length>5000)throw Error('销售明细需为1—5000行');
  const map=new Map();
  for(const row of rows){
    if(!row||typeof row!=='object'||Array.isArray(row))throw Error('销售明细格式无效');
    const sku=String(row.sku??'').trim().toUpperCase(),qty=Number(row.qty);
    if(!sku||sku.length>120||blank(row.qty)||!['number','string'].includes(typeof row.qty)||typeof row.qty==='string'&&!/^\d+$/.test(row.qty.trim())||!Number.isSafeInteger(qty)||qty<0||qty>1e9)throw Error('销售数据存在空SKU或非正整数销量（有投放未出单可填0）');
    const values=salesFinancials({...row,qty},defaultCurrency);
    if(!values.currency&&(values.amount!==null||values.adCost!==null))throw Error('请指定销售金额的币种');
    const key=JSON.stringify([sku,values.currency,values.amount===null,values.adCost===null]),previous=map.get(key);
    const next={sku,name:String(row.name||previous?.name||'').trim().slice(0,120),qty:qty+(previous?.qty??0),currency:values.currency,
      amount:previous?(previous.amount===null||values.amount===null?null:Math.round((previous.amount+values.amount)*100)/100):values.amount,
      adCost:previous?(previous.adCost===null||values.adCost===null?null:Math.round((previous.adCost+values.adCost)*100)/100):values.adCost};
    if(next.qty>1e9||next.amount>1e12||next.adCost>1e12)throw Error(`${sku}合计数量或金额过大，请拆分导入`);
    map.set(key,next);
  }
  return [...map.values()];
}
