import {pilotDay,pilotSettings,pilotWeek,runPilot} from '../lib/agent-pilot.mjs';

export async function tickAgentPilot(db,now=new Date()){
 const s=await pilotSettings(db);if(!s.enabled||!s.scope_id)return {skipped:'disabled'};
 const local=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(now);
 const today=pilotDay(now,'Asia/Shanghai'),week=pilotWeek(now);
 const daily=await db.prepare("SELECT COUNT(*) n FROM agent_pilot_runs WHERE scope_id=? AND period_type='daily' AND period_key=? AND json_extract(result_json,'$.configVersion')=?").bind(s.scope_id,today,s.version).first();
 const weekly=await db.prepare("SELECT COUNT(*) n FROM agent_pilot_runs WHERE scope_id=? AND period_type='weekly' AND period_key=?").bind(s.scope_id,week.start).first();
 const due=local>=(s.config.dailyTime||'10:00'),saveDaily=due&&daily.n<2,saveWeekly=due&&weekly.n<2;
 // Catch up a missed Monday once; video association is rechecked every minute.
 return runPilot(db,{now,agents:saveDaily||saveWeekly?['operating','creator']:['creator'],saveDaily,saveWeekly});
}
export function scheduleAgentPilot(db,{intervalMs=60000,onError=()=>console.error('Agent pilot check failed; existing tasks retained')}={}){
 let running=false;const run=async()=>{if(running)return;running=true;try{await tickAgentPilot(db);}catch(error){onError(error);}finally{running=false;}};
 void run();const timer=setInterval(run,intervalMs);timer.unref();return {stop:()=>clearInterval(timer)};
}
