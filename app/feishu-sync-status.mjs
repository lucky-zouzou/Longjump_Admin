// A 202 response accepts a background job; only a newer server result confirms its outcome.
export function manualSyncOutcome(pending,status={},now=Date.now()){
 if(!pending)return 'none';
 if(status.running)return 'running';
 if(!status.lastAttemptAt||status.lastAttemptAt===pending.previousAttempt)
  return now-pending.acceptedAt>=5*60000?'unconfirmed':'waiting';
 if(status.lastError)return 'failed';
 if(status.lastSuccessAt&&status.lastSuccessAt!==pending.previousSuccess)return 'succeeded';
 return 'unconfirmed';
}
