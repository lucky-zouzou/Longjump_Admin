// BEST trackingQuery StateType values. Clearance is release before delivery starts.
const transitStages = ['sea_freight','port_arrived','customs_clearance','last_mile_delivery','awaiting_receipt'];
const stateRank = new Map([['Departed',0],['DestinationArrived',1],['Clearance',2],['Delivering',3],['Delivered',4],['Signed',4]]);

const beijingDay = millis => new Date(millis+8*3600000).toISOString().slice(0,10);

export function bestTimelineConflict(leg, snapshot, now=Date.now()) {
  if (!transitStages.slice(0,4).includes(leg.stage) || !leg.etd) return null;
  for (const group of snapshot.groups||[]) {
    const arrivals=group.events.filter(e=>e.kind==='actual' && e.state==='DestinationArrived' && e.at)
      .map(e=>Date.parse(e.at)).filter(t=>Number.isFinite(t)&&t<=now);
    if (arrivals.length && arrivals.every(t=>beijingDay(t)<leg.etd)) {
      return {arrival:beijingDay(Math.max(...arrivals)), departure:leg.etd};
    }
  }
  return null;
}

export function bestProgress(leg, shipments, now = Date.now()) {
  const current = transitStages.indexOf(leg.stage);
  if (current < 0 || current >= 4 || !leg.etd || !shipments.length) return null;
  const parts = [];
  for (const row of shipments) {
    const age = now-Date.parse(row.last_success_at);
    if (bestTimelineConflict(leg,row.snapshot,now) || row.last_error || !row.snapshot.groups?.length || !Number.isFinite(age) || age<0 || age>2*3600000) return null;
    for (const group of row.snapshot.groups) {
      const actual = group.events.filter(e=>e.kind==='actual' && e.at && Date.parse(e.at)<=now &&
        new Date(Date.parse(e.at)+8*3600000).toISOString().slice(0,10)>=leg.etd);
      const events = actual.filter(e=>stateRank.has(e.state));
      if (!events.length) return null;
      const best = events.reduce((a,b)=>stateRank.get(b.state)>stateRank.get(a.state)?b:a);
      if (actual.some(e=>e.at>=best.at && !stateRank.has(e.state))) return null;
      const arrival = events.filter(e=>e.state==='DestinationArrived').map(e=>e.at).sort()[0];
      parts.push({waybill:row.waybill,rank:stateRank.get(best.state),at:best.at,state:best.state,arrival});
    }
  }
  const rank = Math.min(...parts.map(p=>p.rank));
  const arrivalAt = parts.every(p=>p.arrival) ? parts.map(p=>p.arrival).sort().at(-1) : null;
  if (!leg.ata && !arrivalAt) return null;
  if (rank<=current) return null;
  // Preserve manually registered arrival dates. BEST times are displayed in Beijing time.
  const ata = arrivalAt ? new Date(Date.parse(arrivalAt)+8*3600000).toISOString().slice(0,10) : null;
  return {stage:transitStages[rank],owner:rank===4?'供应链':'海运',ata,evidence:parts};
}
