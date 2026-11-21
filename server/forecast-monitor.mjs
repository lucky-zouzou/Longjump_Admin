import {loadForecast} from '../lib/forecast.ts';
import {recordForecastObservations} from '../lib/forecast-observations.mjs';
export function scheduleForecastMonitor(db){
 let running=false;
 const run=async()=>{if(running)return;running=true;try{const {suggestions}=await loadForecast(db,{role:'管理员'});await recordForecastObservations(db,suggestions);}catch(e){if(e.status!==409)console.error('Forecast observation failed:',e.message);}finally{running=false;}};
 const initial=setTimeout(run,30000);initial.unref();const timer=setInterval(run,30*60000);timer.unref();return timer;
}
