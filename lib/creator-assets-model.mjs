import {creatorMetrics,financeValue} from './creator-model.mjs';

export const capabilityFormats={outfit:'穿搭搭配',unbox:'开箱展示',review:'测评对比',scenario:'场景演示',tutorial:'使用教程',live:'直播讲解'};
export const playbookStates={pending:'待审核',returned:'待完善',approved:'已入库',archived:'已停用'};
export const assetKey=p=>JSON.stringify([p.site,p.platform,p.platform_id]);
const latest=(rows,key)=>[...rows].sort((a,b)=>b.revision-a.revision).filter((r,i,a)=>a.findIndex(x=>key(x)===key(r))===i);
export function assetContribution(profiles,rounds,contents,finances,observations,now=new Date()){
 const metrics=creatorMetrics(profiles,rounds,contents,finances,now),known=rounds.map(r=>financeValue(r,finances)).filter(Boolean);
 const amounts=known.length?{netCny:known.reduce((n,f)=>n+Math.round(f.data.netRevenueMinor*f.data.rate),0)/100,profitCny:metrics.verifiedProfitCny,costCny:known.reduce((n,f)=>n+Math.round((f.data.netRevenueMinor-f.data.profitMinor)*f.data.rate),0)/100}:null;
 const observationsByWindow=[7,30].map(window=>{
  const mature=contents.filter(c=>c.status==='accepted'&&Date.parse(c.published_at)+window*86400000<=+now),ids=new Set(mature.map(c=>c.id));
  const rows=latest(observations.filter(o=>o.window_days===window&&ids.has(o.content_id)),o=>o.content_id),views=rows.filter(o=>o.data.views!=null),clicks=rows.filter(o=>o.data.views>0&&o.data.clicks!=null);
  return {window,mature:mature.length,reported:rows.length,viewsKnown:views.length,averageViews:views.length?views.reduce((n,o)=>n+o.data.views,0)/views.length:null,clickRate:clicks.length?clicks.reduce((n,o)=>n+o.data.clicks,0)/clicks.reduce((n,o)=>n+o.data.views,0):null,clickSamples:clicks.length};
 });
 return {rounds:rounds.length,completed:metrics.completed,approved:rounds.filter(r=>r.approved_at).length,verifiedRounds:known.length,pendingFinance:metrics.financePending,amounts,onTime:metrics.onTime,originalOnTime:metrics.originalOnTime,videos:contents.filter(c=>c.kind==='video'&&c.status==='accepted').length,lives:contents.filter(c=>c.kind==='live'&&c.status==='accepted').length,observations:observationsByWindow};
}
export function buildCreatorAssets(assets,snapshot,now=new Date()){
 return assets.map(a=>{
  const profiles=snapshot.profiles.filter(p=>assetKey(p)===assetKey(a)),ids=new Set(profiles.map(p=>p.id)),rounds=snapshot.rounds.filter(r=>ids.has(r.creator_id)),rids=new Set(rounds.map(r=>r.id)),contents=snapshot.contents.filter(c=>rids.has(c.round_id)),cids=new Set(contents.map(c=>c.id));
  const data=JSON.parse(a.data_json||'{}');
  return {...a,data,name:profiles[0]?.name||a.platform_id,profileIds:[...ids],shops:profiles.map(p=>p.shop),kinds:[...new Set(profiles.map(p=>p.kind))],tiers:[...new Set(profiles.map(p=>p.tier))],owners:[...new Set(profiles.flatMap(p=>[p.operator_id,p.bd_id]))],capabilityStale:!data.asOf||Date.parse(data.asOf)+90*86400000<+now,contribution:assetContribution(profiles,rounds,contents,snapshot.finances.filter(f=>rids.has(f.round_id)),snapshot.observations.filter(o=>cids.has(o.content_id)),now)};
 });
}
export function replicationSummary(rounds,finances){
 const complete=rounds.filter(r=>r.status==='completed'),verified=complete.map(r=>financeValue(r,finances)).filter(Boolean);
 return {applied:rounds.length,completed:complete.length,verified:verified.length,positive:verified.filter(f=>f.data.profitCnyMinor>0).length,profitCny:verified.length?verified.reduce((s,f)=>s+f.data.profitCnyMinor,0)/100:null};
}
