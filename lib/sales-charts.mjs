// Missing days and incomplete money never become zero-valued graph points.
export function chartDays(rows,from,to){
  const grouped=new Map();
  for(const row of rows){const day=grouped.get(row.date)||{qty:0,qtyKnown:false,revenue:0,adCost:0,revenueMissing:0,costMissing:0};
    day.qtyKnown ||= row.qtyRecords===undefined||row.qtyRecords>0||row.salesComplete===true;
    day.qty+=Number(row.qty)||0;day.revenue+=Number(row.revenue)||0;day.adCost+=Number(row.adCost)||0;
    day.revenueMissing+=Number(row.revenueMissing)||Number(row.revenue==null);day.costMissing+=Number(row.costMissing)||Number(row.adCost==null);grouped.set(row.date,day);
  }
  const count=Math.min(366,Math.max(0,Math.round((Date.parse(to)-Date.parse(from))/86400000)+1));
  return Array.from({length:count},(_,i)=>{const date=new Date(Date.parse(from)+i*86400000).toISOString().slice(0,10),r=grouped.get(date);return {date,qty:r?.qtyKnown?r.qty:null,revenue:r&&!r.revenueMissing?r.revenue:null,adCost:r&&!r.costMissing?r.adCost:null,partial:Boolean(r&&(r.revenueMissing||r.costMissing))};});
}
export function chartScale(values){
  const valid=values.filter(v=>v!==null&&Number.isFinite(v)),min=Math.min(0,...valid),max=Math.max(1,...valid),raw=(max-min)/4,power=10**Math.floor(Math.log10(raw)),step=[1,2,5,10].map(n=>n*power).find(n=>n>=raw)||power*10;
  const low=Math.floor(min/step)*step,high=Math.ceil(max/step)*step;
  return {min:low,max:high,ticks:Array.from({length:Math.round((high-low)/step)+1},(_,i)=>low+i*step)};
}
