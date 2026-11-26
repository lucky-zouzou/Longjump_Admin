import { expireWholesaleReservations } from '../lib/wholesale-workflow.mjs';
// The host supplies the existing DB binding; no credentials or alternative DB paths.
export function startWholesaleReservationMonitor(db,{intervalMs=60000,onError=error=>console.error('wholesale reservation monitor:',error.message)}={}){
 let running=false;const run=async()=>{if(running)return;running=true;try{return await expireWholesaleReservations(db);}catch(error){onError(error);}finally{running=false;}};
 const timer=setInterval(run,Math.max(10000,intervalMs));timer.unref?.();return {run,stop:()=>clearInterval(timer)};
}
