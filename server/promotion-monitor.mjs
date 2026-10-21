import {refreshPromotions} from '../lib/promotions.mjs';
export function schedulePromotionMonitor(db){let running=false;const run=async()=>{if(running)return;running=true;try{await refreshPromotions(db);}catch(e){if(e.status!==409)console.error('Promotion monitoring failed:',e.message);}finally{running=false}};void run();const timer=setInterval(run,60000);timer.unref();return timer;}
