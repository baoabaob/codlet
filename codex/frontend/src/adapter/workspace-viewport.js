import { workspaceError } from './workspace-dom.js';

function options(value={},previous={open:false,width:360}){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['open','width'].includes(key)))throw workspaceError('invalid_argument','Invalid independent viewport state');
  const next={...previous,...value};
  if(typeof next.open!=='boolean'||!Number.isFinite(next.width)||next.width<240||next.width>1600)throw workspaceError('invalid_argument','Invalid viewport openness or width');
  return next;
}
export function createWorkspaceViewports({load,check,isConfirmed,isCurrentContext=id=>id==null||isConfirmed(id),report,prepared:onPrepared,failed:onFailed}){
  let record,prepared,driver,disposed=false;const cleanup=new Set();
  const ensure=()=>prepared??=Promise.resolve().then(load).then(value=>{
    if(disposed)throw workspaceError('workspace_retired','Viewport provider retired');
    if(value?.api!==1||value.independent!==true||value.restoresSettings!==true||value.avoidsThreadPersistence!==true||value.notifiesChanges!==true||typeof value.create!=='function')
      throw workspaceError('workspace_viewport_unsupported','A verified independent Native viewport driver is unavailable');
    driver=value;return value;
  });
  function create(initial,live){
    check();live();if(disposed)throw workspaceError('workspace_retired','Viewport provider retired');
    if(record)throw workspaceError('workspace_viewport_owned','Independent viewport already has an owner');
    const entry={active:true,state:options(initial),threadId:null,view:null,operation:null,closing:null,failure:null,listeners:new Set()};record=entry;
    const valid=()=>{check();live();if(!entry.active)throw entry.failure ?? workspaceError('workspace_retired','Viewport handle retired');};
    const snapshot=()=>Object.freeze({independent:true,...entry.state,threadId:entry.threadId,hostId:entry.threadId?'local':null});
    const callback=(listener,value)=>{try{Promise.resolve(listener(value)).catch(report);}catch(error){report(error);}};
    const notify=()=>{if(entry.active)for(const listener of entry.listeners)callback(listener,snapshot());};
    const receive=value=>{if(!entry.active)return;try{const next=options(value,entry.state);if(next.open===entry.state.open&&next.width===entry.state.width)return;entry.state=next;notify();}catch(error){report(error);}};
    const ready=ensure().then(async value=>{
      valid();const view=await value.create({...entry.state},{isCurrentContext,onError:error=>{entry.failure??=error;onFailed?.(entry.failure);report(error);void close();}});entry.view=view;
      if(!view||!['bind','update','subscribe','close'].every(name=>typeof view[name]==='function'))throw workspaceError('workspace_viewport_unsupported','Native viewport lifecycle is incomplete');
      await view.ready;valid();entry.unlisten=view.subscribe(receive);
      if(typeof entry.unlisten!=='function')throw workspaceError('workspace_viewport_unsupported','Native viewport notifications cannot be released');
      onPrepared?.();
    });ready.catch(()=>{});
    const close=()=>{
      if(entry.closing)return entry.closing;
      entry.active=false;entry.operation?.abort();entry.listeners.clear();entry.unlisten?.();entry.unlisten=null;
      entry.closing=(async()=>{try{await ready;}catch{}await entry.inflight?.catch(()=>{});if(entry.view?.close)await entry.view.close();if(record===entry)record=null;})();
      cleanup.add(entry.closing);entry.closing.then(()=>cleanup.delete(entry.closing),()=>{});entry.closing.catch(report);return entry.closing;
    };
    async function apply(action,value,invocation={}){
      valid();if(entry.operation)throw workspaceError('workspace_viewport_busy','Viewport update is pending');
      if(!invocation||typeof invocation!=='object'||Array.isArray(invocation)||Object.keys(invocation).some(key=>key!=='signal'))throw workspaceError('invalid_argument','Invalid viewport invocation');
      const signal=invocation.signal;
      if(signal!=null&&(typeof signal.aborted!=='boolean'||typeof signal.addEventListener!=='function'||typeof signal.removeEventListener!=='function'))throw workspaceError('invalid_argument','Invalid viewport cancellation signal');
      const controller=new AbortController(),abort=()=>controller.abort(signal?.reason);entry.operation=controller;
      if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
      try{await ready;valid();if(controller.signal.aborted)throw workspaceError('invocation_cancelled','Viewport update cancelled');
        if(action==='bind'){
          if(value!==null&&(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['threadId','hostId'].includes(key))||typeof value.threadId!=='string'||!/^[\w-]{1,256}$/.test(value.threadId)||(value.hostId??'local')!=='local'))throw workspaceError('invalid_argument','Invalid viewport thread identity');
          if(value!==null&&!isConfirmed(value.threadId))throw workspaceError('workspace_selection_not_confirmed','Native selection does not match viewport content');
          const identity=value===null?null:{threadId:value.threadId,hostId:'local'};
          await entry.view.bind(identity,{signal:controller.signal});valid();entry.threadId=identity?.threadId??null;
        }else{const next=options(value,entry.state);const applied=await entry.view.update(next,{signal:controller.signal});valid();entry.state=options(applied??next,entry.state);}
        notify();
        if(controller.signal.aborted)throw workspaceError('outcome_unknown','Viewport caller cancelled after Native application');return snapshot();
      }catch(error){if(entry.failure&&error!==entry.failure&&!error?.errors?.includes(entry.failure))throw entry.failure;throw error;}
      finally{signal?.removeEventListener('abort',abort);if(entry.operation===controller)entry.operation=null;}
    }
    const run=(action,value,invocation)=>{const pending=apply(action,value,invocation);entry.inflight=pending;const clear=()=>{if(entry.inflight===pending)entry.inflight=null;};pending.then(clear,clear);return pending;};
    entry.handle=Object.freeze({ready,getSnapshot(){valid();return snapshot();},subscribe(listener){valid();if(typeof listener!=='function'||entry.listeners.size>=32)throw workspaceError('invalid_argument','Expected a viewport listener (at most 32)');entry.listeners.add(listener);callback(listener,snapshot());return()=>entry.listeners.delete(listener);},bind:(value,invocation)=>run('bind',value,invocation),update:(value,invocation)=>run('update',value,invocation),close,dispose(){void close();}});return entry.handle;
  }
  return{create,prepare:ensure,async cleanup(){await Promise.all([...cleanup]);},dispose(){disposed=true;record?.handle.dispose();}};
}
