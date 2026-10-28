import {financeRows as rows} from './finance-periods.mjs';
import {costContext} from './cost-source-context.mjs';
// Physical buckets are disjoint: reserved is part of sellable book stock, not
// additional stock. Consigned unsold goods remain owned inventory outside it.
export async function inventoryValuation(db){
 const [balances,transit,consigned,context]=await Promise.all([
 rows(db,'SELECT * FROM inventory_balances'),
 rows(db,`SELECT l.site,l.channel,i.sku,SUM(MAX(0,i.qty-i.received_qty)) qty FROM transport_leg_items i JOIN transport_legs l ON l.id=i.leg_id WHERE l.stage IN ('sea_freight','port_arrived','customs_clearance','last_mile_delivery','awaiting_receipt') GROUP BY l.site,l.channel,i.sku`),
 rows(db,`SELECT i.sku,i.id,COALESCE((SELECT SUM(si.qty) FROM wholesale_shipment_items si WHERE si.order_item_id=i.id),0)-COALESCE((SELECT SUM(r.qty-r.consignment_sold_qty) FROM wholesale_returns r WHERE r.order_item_id=i.id),0)-COALESCE((SELECT SUM(c.qty) FROM wholesale_consignment_sales c WHERE c.order_item_id=i.id),0) qty FROM wholesale_order_items i JOIN wholesale_orders o ON o.id=i.order_id WHERE o.sale_type='consignment'`),costContext(db)]);
 const map=new Map(),get=(site,channel,sku)=>{const key=[site,channel,sku].join('|');if(!map.has(key))map.set(key,{site,channel,sku,available:0,reserved:0,pending:0,quarantine:0,transit:0,consigned:0,anomalies:[]});return map.get(key);};
 for(const b of balances){const v=get(b.site,b.channel,b.sku);v.available=b.qty-b.reserved_qty;v.reserved=b.reserved_qty;v.pending=b.pending_shelf_qty;v.quarantine=b.quarantine_qty;if([v.available,v.reserved,v.pending,v.quarantine].some(n=>!Number.isSafeInteger(n)||n<0))v.anomalies.push('库存结构异常');}
 for(const t of transit)get(t.site,t.channel,t.sku).transit+=t.qty;
 for(const c of consigned){const v=get('印尼','线下分销',c.sku);v.consigned+=c.qty;if(c.qty<0)v.anomalies.push('寄售实销/退货数量异常');}
 const valuationDocs=await rows(db,"SELECT * FROM finance_documents d WHERE kind='inventory_valuation' AND revision=(SELECT MAX(x.revision) FROM finance_documents x WHERE x.kind=d.kind AND x.business_key=d.business_key) AND status='active'");
 const all=[...map.values()].map(v=>{
  const ref=context.products.filter(p=>p.site===v.site&&p.sku===v.sku&&p.effective_date<=new Date().toISOString().slice(0,10)).sort((a,b)=>b.version-a.version)[0];
  const lots=context.state.lots.filter(l=>l.sku===v.sku&&l.ticket.site===v.site&&l.ticket.channel===v.channel),known=lots.filter(l=>l.ticket.reviewed_at&&!l.estimated&&!l.missing.length&&l.remainingQty>=0);
  const buckets=['available','reserved','pending','quarantine','transit','consigned'].map(bucket=>({bucket,qty:v[bucket],referenceValueCny:v.anomalies.length||ref?.basis!=='landed'||ref.total==null?null:Math.round(v[bucket]*ref.total/100)/100}));
  const certificate=valuationDocs.find(d=>d.site===v.site&&d.channel===v.channel&&JSON.parse(d.data_json).sku===v.sku),cert=certificate?JSON.parse(certificate.data_json):null;
  const certifiedLots=cert?cert.lots.map(c=>context.state.lots.find(l=>l.ticket.business_key===c.ticketKey&&l.lineKey===c.lineKey)).filter(Boolean):[];
  const verified=cert&&certifiedLots.length===cert.lots.length&&cert.basis===valuationBasis({...v,buckets},certifiedLots);
  return {...v,buckets,totalQty:buckets.reduce((s,b)=>s+b.qty,0),reference:ref?{id:ref.id,version:ref.version,basis:ref.basis,unitCny:ref.total==null?null:ref.total/10000}:null,referenceValueCny:buckets.some(b=>b.referenceValueCny==null)?null:Math.round(buckets.reduce((s,b)=>s+b.referenceValueCny,0)*100)/100,batchRemainingQty:lots.reduce((s,l)=>s+l.remainingQty,0),batchKnownValueCny:known.length?known.reduce((s,l)=>s+Object.values(l.remaining).reduce((n,v)=>n+v,0),0)/100:null,batchPending:lots.length-known.length,actualValueCny:verified?certificate.amount_minor/100:null,valuationKey:certificate?.business_key||null,valuationRevision:certificate?.revision||0,valuationStatus:verified?'实物与实际批次已核对':certificate?'库存或成本已变化，需重新核对':'待核对实物与批次对应关系',lots:lots.map(l=>({ticket:l.ticket.business_key,line:l.lineKey,qty:l.remainingQty,costVersion:l.ticket.revision,reviewed:!!l.ticket.reviewed_at,estimated:l.estimated}))};
 });
 return {asOf:new Date().toISOString(),rows:all,totals:{qty:all.reduce((s,r)=>s+r.totalQty,0),knownReferenceValueCny:Math.round(all.reduce((s,r)=>s+(r.referenceValueCny||0),0)*100)/100,unknownValueRows:all.filter(r=>r.referenceValueCny==null).length,actualValueCny:all.length&&all.every(r=>r.actualValueCny!=null)?Math.round(all.reduce((s,r)=>s+r.actualValueCny,0)*100)/100:null,knownActualValueCny:Math.round(all.reduce((s,r)=>s+(r.actualValueCny||0),0)*100)/100,unverifiedActualRows:all.filter(r=>r.actualValueCny==null).length},method:'现货可售、预留、待上架、隔离、海运在途、客户处寄售未售分列；完整到仓参考成本仅估算占用资金。批次未关联余额并非实际盘点存货，财务确认实物与批次数量对应后列示实际价值；数量或成本版本变化后需复核。'};
}

export function valuationBasis(row,lots){return JSON.stringify({site:row.site,channel:row.channel,sku:row.sku,buckets:row.buckets.map(b=>[b.bucket,b.qty]),lots:lots.map(l=>[l.ticket.business_key,l.lineKey,l.ticket.id,l.ticket.reviewed_at,l.remainingQty,l.remaining]).sort((a,b)=>String(a[0]+a[1]).localeCompare(String(b[0]+b[1])))});}
