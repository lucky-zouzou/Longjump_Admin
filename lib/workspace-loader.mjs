// One in-flight read per mounted workspace. Never cache completed business data.
// A mutation can force a new read; navigation cancels obsolete requests.
export function createWorkspaceLoader(read) {
  let pending;
  const cancel=()=>{const old=pending;pending=undefined;old?.controller.abort();};
  return {
    cancel,
    load(page,{force=false}={}) {
      if(!force&&pending?.page===page)return pending.promise;
      cancel();
      const entry={page,controller:new AbortController(),promise:null};
      pending=entry;
      entry.promise=Promise.resolve().then(()=>read(page,entry.controller.signal)).then(
        value=>pending===entry?value:undefined,
        error=>{if(pending===entry)throw error;},
      ).finally(()=>{if(pending===entry)pending=undefined;});
      return entry.promise;
    },
  };
}
