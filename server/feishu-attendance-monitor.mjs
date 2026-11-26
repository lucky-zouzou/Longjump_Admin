import {getFeishuSettings,recordFeishuConnectionCheck} from '../lib/feishu-store.mjs';
import {runFeishuSync,feishuCredentialIdentity} from '../lib/feishu-sync.mjs';

export function scheduleFeishuAttendance(env,{intervalMs=10*60000}={}){
 let running=false;
 const run=async()=>{
  if(running)return;running=true;
  try{
   const settings=await getFeishuSettings(env.DB);
   if(!settings.enabled)return;
   // Manual or another worker's successful recent sync also satisfies this cycle.
   if(settings.lastAttemptAt&&Date.now()-Date.parse(settings.lastAttemptAt)<intervalMs)return;
   let credentials,identity;
   try{credentials=env.readFeishuCredentials();identity=await feishuCredentialIdentity(credentials);}
   catch{if(settings.connectionStatus==='passed')await recordFeishuConnectionCheck(env.DB,{version:settings.version,appId:settings.appId,configSource:'unavailable',ok:false,errorCode:'credentials_unavailable'});return;}
   const verified=await env.DB.prepare("SELECT config_source FROM feishu_settings WHERE id='global'").first();
   if(identity.appId!==settings.appId||identity.configSource!==verified.config_source){if(settings.connectionStatus==='passed')await recordFeishuConnectionCheck(env.DB,{version:settings.version,appId:settings.appId,configSource:identity.configSource,ok:false,errorCode:'credentials_changed'});return;}
   await runFeishuSync(env.DB,credentials,{}, {trigger:'scheduled'});
  }catch(error){if(error.status!==409)console.error('Feishu attendance sync unavailable; review the integration status.');}
  finally{running=false;}
 };
 const initial=setTimeout(run,15000);initial.unref();const timer=setInterval(run,intervalMs);timer.unref();
 return {stop(){clearTimeout(initial);clearInterval(timer);},run};
}
