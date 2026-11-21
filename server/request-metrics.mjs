export function createRequestMetrics({clock=Date.now,limit=300,ttl=30*60000}={}){
 const groups=new Map();
 function record(path,duration,status){
  // Fixed API paths only: never store query text, tokens, IDs or request bodies.
  if(!/^\/api\/[a-z-]+(?:\/[a-z-]+)?$/.test(path))return;
  const now=clock();if(!groups.has(path)&&groups.size>=100)return;
  const rows=(groups.get(path)||[]).filter(r=>r.at>now-ttl);rows.push({at:now,duration,status});groups.set(path,rows.slice(-limit));
 }
 function snapshot(){const now=clock(),rows=[];for(const [path,samples] of groups){const live=samples.filter(r=>r.at>now-ttl);if(!live.length){groups.delete(path);continue;}const values=live.map(r=>r.duration).sort((a,b)=>a-b);rows.push({path,count:live.length,p50:Math.round(values[Math.ceil(values.length*.5)-1]),p95:Math.round(values[Math.ceil(values.length*.95)-1]),errors:live.filter(r=>r.status>=500).length,slow:live.filter(r=>r.duration>1000).length});}return {windowMinutes:ttl/60000,sampleLimit:limit,rows:rows.sort((a,b)=>b.p95-a.p95)};}
 return {record,snapshot};
}
