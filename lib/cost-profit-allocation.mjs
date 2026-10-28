import {allocate} from './cost-profit-model.mjs';
// The order is still the accounting document. This explicit, conserved view
// distributes only shared values; it never writes a second expense entry.
export function skuContributions(order,sales){
 const groups=new Map(),saleMap=new Map(sales.map(s=>[s.id,s]));
 for(const e of order.evidence){
  if(!groups.has(e.sku))groups.set(e.sku,{sku:e.sku,qty:0,weight:0,costs:{},evidence:[]});
  const g=groups.get(e.sku),s=saleMap.get(e.salesRecordId);g.qty+=e.qty;g.evidence.push(e);
  const weight=order.data.allocationBasis==='quantity'?e.qty:s?.reported_amount!=null&&s.qty>0?s.reported_amount*e.qty/s.qty:null;
  if(weight==null)g.unknown=true;else g.weight+=weight;
  for(const [k,n] of Object.entries(e.costs))g.costs[k]=n==null||g.costs[k]===null?null:(g.costs[k]||0)+n;
 }
 const list=[...groups.values()].sort((a,b)=>a.sku.localeCompare(b.sku)),known=list.length&&!list.some(r=>r.unknown)&&list.reduce((s,r)=>s+r.weight,0)>0;
 if(!known&&list.length>1)return {rows:list.map(r=>({...r,gross:null,contribution:null,estimated:order.estimated,allocationPending:true})),unallocated:order.contribution};
 const weights=list.length===1?[1]:list.map(r=>r.weight),shared={gross:order.gross,...Object.fromEntries(Object.entries(order.costs).filter(([k])=>!['product','sea','tax','inbound'].includes(k)))};
 const split=Object.fromEntries(Object.entries(shared).map(([k,n])=>[k,n==null?null:allocate(n,weights)]));
 return {rows:list.map((r,i)=>{const costs={...r.costs,...Object.fromEntries(Object.entries(split).filter(([k])=>k!=='gross').map(([k,n])=>[k,n?.[i]??null]))},gross=split.gross?.[i]??null;return {...r,gross,costs,contribution:order.contribution==null||gross==null||Object.values(costs).some(n=>n==null)?null:gross-Object.values(costs).reduce((a,b)=>a+b,0),estimated:order.estimated,method:order.data.allocationBasis==='quantity'?'按关联件数分摊共享费用':'按来源销售金额分摊共享费用'};}),unallocated:0};
}
