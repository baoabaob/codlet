const pendingCodes=new Set(['workspace_host_pending','ui_host_pending','desktop_host_pending','desktop_connection_not_ready','desktop_scope_missing']);
export function nativeInitializationPending(error) {
  return pendingCodes.has(error?.code);
}

export function memoizeNativeLoad(load) {
  let pending;
  return ()=>{
    if(!pending){
      const result=Promise.resolve().then(load).catch(error=>{
        if(pending===result)pending=undefined;
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

// Native owns initialization timing. Provider lifetime or a caller's explicit
// deadline cancels pending work; contract ambiguity remains an immediate error.
export async function awaitNativeInitialization(load,{signal,timeout=Infinity,pause=delay,clock=()=>Date.now()}={}) {
  const started=clock();let attempt=0;
  const run=async()=>{for(;;){
      signal?.throwIfAborted();
      try{const value=await load();signal?.throwIfAborted();return value;}
      catch(error){
        signal?.throwIfAborted();
        const remaining=timeout-(clock()-started);
        if(!nativeInitializationPending(error)||remaining<=0)throw error;
        await pause(Math.min(remaining,Math.min(1000,50*2**Math.min(attempt++,5))),signal);
      }
    }};
  if(!signal)return run();
  let abort;
  const retired=new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
  try{return await Promise.race([run(),retired]);}
  finally{signal.removeEventListener('abort',abort);}
}
