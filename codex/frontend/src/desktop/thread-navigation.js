const fail=(code,message)=>Object.assign(new Error(message),{code});

// Keep the navigation operation independent of transport installation so its
// actual native route and Core RPC latency can be probed without replacing an
// installed adapter's interception hooks or public API.
export function createThreadOpener({manager,selection,navigation,request,beforeNavigate,validateTarget,onValidated}){
  let opening=false;
  return async function openThread(args,signal){
    if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>key!=='threadId'))throw fail('invalid_argument','Invalid task navigation arguments');
    const threadId=args.threadId;
    if(typeof threadId!=='string'||!/^[a-zA-Z0-9_-]{1,256}$/.test(threadId))throw fail('invalid_argument','threadId must be a local task identity');
    if(opening)throw fail('desktop_navigation_busy','Another task open request is still being validated');
    opening=true;
    try{
      const before=selection(),nav=navigation(),stamp=nav.stamp();
      const cached=manager.rpc?await manager.getConversation(threadId):manager.getConversation(threadId);
      if(signal?.aborted)throw fail('invocation_cancelled','Task navigation was cancelled before dispatch');
      if(nav.stamp()!==stamp)throw fail('desktop_navigation_superseded','The user navigated while this task was being checked');
      if(cached?.id===threadId)validateTarget?.(cached);
      if(before.threadId===threadId){onValidated?.();return {...before,status:before.resumeState==='resumed'?'opened':'opening',alreadySelected:true};}
      // The existing local manager has already validated cached identities.
      // Navigating to those tasks needs no second metadata round trip.
      if(cached?.id!==threadId||cached.hostId!=null&&cached.hostId!=='local'){
        const metadata=await request('thread/read',{threadId,includeTurns:false},signal);
        if(metadata?.thread?.id!==threadId)throw fail('desktop_navigation_unavailable','Desktop did not confirm the requested task identity');
        validateTarget?.(metadata.thread);
      }
      if(signal?.aborted)throw fail('invocation_cancelled','Task navigation was cancelled during validation');
      selection();
      if(nav.stamp()!==stamp)throw fail('desktop_navigation_superseded','The user navigated while this task was being checked');
      if(signal?.aborted)throw fail('invocation_cancelled','Task navigation was cancelled before routing');
      onValidated?.();
      beforeNavigate?.();
      nav.open(threadId);
      const current=selection();
      if(current.threadId!==threadId)throw fail('desktop_navigation_superseded','Desktop selected a different task during navigation');
      // Native's mounted route owns cold resume, settings and stream ownership.
      return {...current,status:current.resumeState==='resumed'?'opened':'opening',alreadySelected:false};
    }finally{opening=false;}
  };
}
