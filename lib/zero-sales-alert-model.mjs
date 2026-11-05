// Shared by the workspace reminder and its filtered SKU destination.
// A selling platform must not hide another platform's idle inventory.
export function zeroSalesAlert(row){
 const channels=(row.channels||[]).filter(c=>c.knownRecentQty===0&&c.todayQty===0&&(!c.stockValid||c.available>0)).map(c=>({
  ...c,alertKind:!c.reportZero||!c.stockValid||!c.stockMatched?'pending':c.historyVerified?'confirmed':'verify'
 }));
 if(!channels.length)return null;
 const kind=channels.some(c=>c.alertKind==='confirmed')?'confirmed':channels.some(c=>c.alertKind==='verify')?'verify':'pending';
 const available=channels.reduce((n,c)=>n+(c.available??0),0),unit=row.referenceCost?.unitCny;
 return {kind,channels,available,stockKnown:channels.every(c=>c.stockValid),valueCny:unit==null?null:Math.round(available*unit*100)/100,
  costComplete:!!row.referenceCost?.complete,following:channels.some(c=>c.plan||c.promotion)};
}
export function zeroSalesAlertSite(view=''){
 const site=view.startsWith('zero-alerts:')?view.slice('zero-alerts:'.length):'';
 return ['印尼','马来西亚','泰国','越南','菲律宾'].includes(site)?site:'';
}
