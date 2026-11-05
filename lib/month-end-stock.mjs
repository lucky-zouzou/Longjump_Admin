import {transitLots} from './transit-stock.mjs';
import {financeRows as rows} from './finance-periods.mjs';
import {effectiveCost} from './effective-cost.mjs';
import {SITE_CURRENCIES} from './sales-data.mjs';
const buckets=['available','reserved','pending','quarantine','transit','consigned'];
export const periodCutoff=(month,site)=>new Date(Date.UTC(+month.slice(0,4),+month.slice(5),1)-(['马来西亚','菲律宾'].includes(site)?8:7)*3600000).toISOString();
async function physical(db,until){
 const records=await rows(db,`SELECT source,payload FROM (SELECT source,payload,ROW_NUMBER() OVER(PARTITION BY source,entity ORDER BY at DESC,seq DESC) n FROM finance_stock_history WHERE at<?) WHERE n=1 AND payload IS NOT NULL`,[until]);
 const by={};for(const r of records)(by[r.source]??=[]).push(JSON.parse(r.payload));const table=k=>by[k]||[],map=new Map();
 const get=(site,channel,sku)=>{const k=JSON.stringify([site,channel,sku]);if(!map.has(k))map.set(k,{site,channel,sku,...Object.fromEntries(buckets.map(b=>[b,0]))});return map.get(k);};
 for(const b of table('inventory_balances'))Object.assign(get(b.site,b.channel,b.sku),{available:b.qty-b.reserved_qty,reserved:b.reserved_qty,pending:b.pending_shelf_qty,quarantine:b.quarantine_qty});
 for(const l of transitLots({batches:table('production_batches'),shipmentRows:table('shipment_batches'),shipmentItemRows:table('shipment_batch_items'),receipts:table('shipment_receipt_items'),transportLegRows:table('transport_legs'),transportLegItemRows:table('transport_leg_items')}))get(l.site,l.channel,l.sku).transit+=l.qty;
 const co=new Set(table('wholesale_orders').filter(o=>o.sale_type==='consignment').map(o=>o.id)),items=new Map(table('wholesale_order_items').filter(i=>co.has(i.order_id)).map(i=>[i.id,i.sku]));
 for(const [t,f] of [['wholesale_shipment_items',i=>i.qty],['wholesale_consignment_sales',i=>-i.qty],['wholesale_returns',i=>i.consignment_sold_qty-i.qty]])for(const i of table(t)){const sku=items.get(i.order_item_id);if(sku)get('印尼','线下分销',sku).consigned+=f(i);}
 return [...map.values()];
}
export async function monthEndStock(db,month,context,all){
 const {started_at:start}=await db.prepare('SELECT started_at FROM finance_stock_baseline').first(),siteCutoffs=Object.fromEntries(Object.keys(SITE_CURRENCIES).map(s=>[s,periodCutoff(month,s)])),byTime=new Map(),out=[],unavailable=[];
 for(const [site,until] of Object.entries(siteCutoffs)){
  if(start>=until||new Date().toISOString()<until){unavailable.push(site);continue;}
  if(!byTime.has(until))byTime.set(until,await physical(db,until));
  // Physical sources carry a recorded-at history. Valuation documents are append-only.
  // Retain an actual value only if the matching certificate was in force at cutoff
  // and no later evidence could have changed the lots it valued.
  const docs=new Map();for(const d of all)if(d.kind==='inventory_valuation'&&d.site===site&&d.created_at<until&&d.business_date<month+'-32'){
   if(!docs.has(d.business_key)||d.revision>docs.get(d.business_key).revision)docs.set(d.business_key,d);}
  for(const r of byTime.get(until).filter(r=>r.site===site)){
   const qty=buckets.reduce((s,b)=>s+r[b],0),anomaly=buckets.some(b=>r[b]<0);
   const cert=[...docs.values()].find(d=>d.status==='active'&&d.channel===r.channel&&d.data.sku===r.sku&&buckets.every(b=>d.data.buckets?.find(x=>x.bucket===b)?.qty===r[b]));
   let actual=null;
   if(!anomaly&&qty===0)actual=0;
   else if(!anomaly&&cert){
    const changed=await db.prepare(`SELECT EXISTS(SELECT 1 FROM cost_records WHERE site=? AND created_at>? AND created_at<?) OR EXISTS(SELECT 1 FROM cost_reviews WHERE created_at>? AND created_at<?) OR EXISTS(SELECT 1 FROM sales_records WHERE site=? AND ((created_at>? AND created_at<?) OR (reversed_at>? AND reversed_at<?))) OR EXISTS(SELECT 1 FROM finance_stock_history WHERE source LIKE 'wholesale_%' AND at>? AND at<?) changed`).bind(site,cert.created_at,until,cert.created_at,until,site,cert.created_at,until,cert.created_at,until,cert.created_at,until).first();
    if(!changed.changed)actual=cert.amount_minor/100;
   }
   const ref=effectiveCost(context.products.filter(p=>p.created_at<until),site,r.sku,new Date(Date.UTC(+month.slice(0,4),+month.slice(5),0)).toISOString().slice(0,10));
   out.push({...r,totalQty:qty,anomaly,actualValueCny:actual,valuationKey:actual!=null?cert?.business_key||null:null,referenceValueCny:!anomaly&&ref?.basis==='landed'&&ref.total!=null?Math.round(qty*ref.total/100)/100:null});
  }
 }
 const known=out.reduce((n,r)=>n+(r.actualValueCny??0),0),unverified=out.filter(r=>r.actualValueCny==null).length;
 return {status:unavailable.length?'unavailable':'historical',asOf:unavailable.length?null:month+' 月末（各站当地）',siteCutoffs,baseline:start,unavailableSites:unavailable,rows:out,totals:{qty:unavailable.length?null:out.reduce((n,r)=>n+r.totalQty,0),knownActualValueCny:unavailable.length?null:Math.round(known*100)/100,actualValueCny:unavailable.length||unverified?null:Math.round(known*100)/100,unverifiedActualRows:unverified},method:'按各站月末截点还原六类库存。启用历史前的月份无期末证据；参考成本不计入实物核定价值。'};
}
