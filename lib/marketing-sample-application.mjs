import {canCreatorProfile,canCreatorScope} from './creator-policy.mjs';

const parse=value=>JSON.parse(value||'{}');
export const sampleItems=terms=>(terms.items||[]).filter(i=>Number(i.sampleQty)>0);
export const historicalSampleCost=record=>record&&['samples','sampleFreight'].some(k=>Number(parse(record.data_json).costs?.[k]?.minor)>0||parse(record.data_json).costs?.[k]?.mode==='included');

// Use the same eligibility checks for the entry list and the write endpoint.
// Totals in older terms may be absent; the SKU lines are the shipping authority.
export function sampleBlockReason({profile,scope,round,orders=[],finance}){
 if(profile.deleted_at||profile.state==='paused')return 'paused';
 if(scope.site!=='印尼'||scope.platform!=='TikTok')return 'scope';
 if(orders.some(o=>o.round_id===round.id&&!['rejected','cancelled'].includes(o.status)))return 'existing';
 if(parse(round.logistics_json).dispatch)return 'dispatched';
 if(historicalSampleCost(finance))return 'costed';
 if(!['approved','executing'].includes(round.status)||!round.approved_at)return round.status==='pending'?'approval':'inactive';
 if(!sampleItems(parse(round.terms_json)).length)return 'items';
 return null;
}

export function sampleApplication(actor,c,orders,requests,finances){
 if(actor.role!=='达人BD')return {rounds:[],application:null};
 const scopes=c.scopes.filter(s=>s.site==='印尼'&&s.platform==='TikTok'&&canCreatorScope(actor,s));
 const scopeMap=new Map(scopes.map(s=>[s.id,s]));
 const profiles=c.profiles.filter(p=>!p.deleted_at&&scopeMap.has(p.scope_id)&&canCreatorProfile(actor,p,scopeMap.get(p.scope_id)));
 const people=new Map(profiles.map(p=>[p.id,p])),rounds=[],blocked=[];
 const label=p=>({creatorId:p.id,creatorName:p.name,shop:scopeMap.get(p.scope_id).shop});
 for(const r of c.rounds){
  const profile=people.get(r.creator_id);if(!profile)continue;
  const reason=sampleBlockReason({profile,scope:scopeMap.get(profile.scope_id),round:r,orders,finance:finances.find(f=>f.round_id===r.id)});
  if(!reason)rounds.push({...r,terms:parse(r.terms_json),creatorName:profile.name,shop:scopeMap.get(profile.scope_id).shop});
  else if(reason!=='inactive')blocked.push({...label(profile),key:'round:'+r.id,roundId:r.id,roundNo:r.round_no,reason,orderId:reason==='existing'?orders.find(o=>o.round_id===r.id&&!['rejected','cancelled'].includes(o.status))?.id:null});
 }
 const pending=requests.filter(q=>people.has(q.creator_id)&&['pending','following'].includes(q.state)).map(q=>({...label(people.get(q.creator_id)),key:'request:'+q.id,requestId:q.id,reason:people.get(q.creator_id).state==='paused'?'paused':q.state==='pending'?'accept':'confirm'}));
 return {rounds,application:{scopeCount:scopes.length,profiles:profiles.filter(p=>p.state!=='paused').map(label).sort((a,b)=>a.creatorName.localeCompare(b.creatorName)),pending,blocked}};
}

export function sampleCreatorUrl(kind,id=''){
 const entity=kind==='new'?'sample:new':kind==='creator'?'sample:'+id:kind==='profile'?id:'sample-'+kind+':'+id;
 return '/?page=creators&entity='+encodeURIComponent(entity);
}
export const sampleRoundUrl=id=>'/?page=marketing-samples&entity='+encodeURIComponent('round:'+id);
