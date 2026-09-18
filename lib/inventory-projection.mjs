// A lot contributes only on its own expected available date. Unknown and overdue
// arrivals remain unresolved rather than being silently credited today.
export function projectInventory({currentQty,dailyDemand,arrivals=[],horizonDays,asOf}){
  const days=Math.min(730,Math.max(1,Math.ceil(horizonDays))),byDay=new Map();
  let unknownQty=0;
  for(const lot of arrivals){const day=lot.days,qty=Math.max(0,Number(lot.qty)||0);
    if(day==null||!Number.isFinite(day)||day<0){unknownQty+=qty;continue;}
    byDay.set(Math.ceil(day),(byDay.get(Math.ceil(day))||0)+qty);
  }
  const nextDay=[...byDay.keys()].sort((a,b)=>a-b)[0]??null;
  let balance=Number(currentQty)||0,firstShortageDay=balance<0?0:null,minBalance=balance,atNext=null;
  const curve=[];
  for(let day=0;day<=days;day++){
    if(day)balance-=dailyDemand;
    balance+=byDay.get(day)||0;
    if(firstShortageDay===null&&balance<-.000001)firstShortageDay=day;
    minBalance=Math.min(minBalance,balance);
    if(day===nextDay)atNext=Math.floor(balance+.000001);
    curve.push({date:new Date(Date.parse(asOf)+day*86400000).toISOString().slice(0,10),qty:Math.floor(balance+.000001),arrivalQty:byDay.get(day)||0});
  }
  return {curve,firstShortageDay,firstShortageDate:firstShortageDay===null?null:curve[firstShortageDay].date,maxShortage:Math.ceil(Math.max(0,-minBalance)),projectedAtNextArrival:atNext,unknownArrivalQty:unknownQty};
}
