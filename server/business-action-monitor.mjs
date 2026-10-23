import {refreshBusinessActions} from '../lib/business-actions.mjs';
export function scheduleBusinessActionMonitor(db){
 let running=false;
 const run=async()=>{if(running)return;running=true;try{await refreshBusinessActions(db,{id:'business-rules',name:'经营行动规则',role:'管理员'});}catch(e){if(e.status!==409)console.error('Business action refresh failed:',e.message);}finally{running=false;}};
 void run();const timer=setInterval(run,10*60000);timer.unref();return timer;
}
