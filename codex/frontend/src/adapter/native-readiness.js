const pendingCodes=new Set(['workspace_host_pending','ui_host_pending','desktop_host_pending','desktop_connection_not_ready','desktop_scope_missing']);
export function nativeInitializationPending(error) {
  return pendingCodes.has(error?.code)||error?.code==='desktop_contract_drift'&&/required \(found 0\)$/.test(error.message??'');
}

export function memoizeNativeLoad(load) {
  let pending;
  return ()=>{
    if(!pending){
      const result=Promise.resolve().then(load).catch(error=>{
        if(pending===result&&(nativeInitializationPending(error)||error?.name==='AbortError'))pending=undefined;
        throw error;
      });
      pending=result;
    }
    return pending;
  };
}

const delay=(milliseconds,signal)=>new Promise((resolve,reject)=>{
  const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(signal.reason);};
  const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},milliseconds);
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
});

// Cold Native exports are initialized lazily. Retry only that pending state,
// with bounded backoff; contract ambiguity and other failures remain immediate.
export async function awaitNativeInitialization(load,{signal,timeout=15000,pause=delay,clock=()=>Date.now()}={}) {
  const started=clock();let attempt=0;
  for(;;){
    signal?.throwIfAborted();
    try{const value=await load();signal?.throwIfAborted();return value;}
    catch(error){
      signal?.throwIfAborted();
      const remaining=timeout-(clock()-started);
      if(!nativeInitializationPending(error)||remaining<=0)throw error;
      await pause(Math.min(remaining,Math.min(1000,50*2**Math.min(attempt++,5))),signal);
    }
  }
}
