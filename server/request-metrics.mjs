import {MODULE_FIELDS} from '../lib/workspace-model.mjs';
export function createRequestMetrics({clock=Date.now,limit=300,ttl=30*60000}={}){
 const groups=new Map();
 function record(path,duration,status,query){
  // Fixed API paths and known workspace labels only; no arbitrary query text, tokens, IDs or bodies.
  if(!/^\/api\/[a-z-]+(?:\/[a-z-]+)?$/.test(path))return;
  const module=path==='/api/system'&&Object.hasOwn(MODULE_FIELDS,query?.get('module'))?query.get('module'):'',navigation=module&&['page','tasks','shell'].includes(query?.get('navigation'))?query.get('navigation'):'';
  const id=JSON.stringify([path,module,navigation]),now=clock();if(!groups.has(id)){for(const [key,values] of groups)if(values.at(-1).at<=now-ttl)groups.delete(key);if(groups.size>=256)return;}
  const rows=(groups.get(id)||[]).filter(r=>r.at>now-ttl);rows.push({at:now,duration,status});groups.set(id,rows.slice(-limit));
 }
 function snapshot(){const now=clock(),rows=[];for(const [id,samples] of groups){const live=samples.filter(r=>r.at>now-ttl);if(!live.length){groups.delete(id);continue;}const [path,module,navigation]=JSON.parse(id);const values=live.map(r=>r.duration).sort((a,b)=>a-b);rows.push({path,...(module?{module,navigation}:{}),count:live.length,p50:Math.round(values[Math.ceil(values.length*.5)-1]),p95:Math.round(values[Math.ceil(values.length*.95)-1]),errors:live.filter(r=>r.status>=500).length,slow:live.filter(r=>r.duration>1000).length});}return {windowMinutes:ttl/60000,sampleLimit:limit,rows:rows.sort((a,b)=>b.p95-a.p95)};}
 return {record,snapshot};
}
