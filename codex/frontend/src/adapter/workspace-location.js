import { nativeMainInput, nativeInputBinding, workspaceError } from './workspace-dom.js';
import { nativeNavigatorIdentity } from '../native-navigation.js';

const TRANSFERS=Symbol.for('codlet.core.workspace.locationTransfers.v2');
const TRANSFER_LIFETIME=10*60*1000,TRANSFER_LIMIT=64;
function connectTransferRegistry(document){
  const target=document.defaultView;
  if(!target[TRANSFERS])Object.defineProperty(target,TRANSFERS,{value:{api:2,entries:new Map(),epoch:0,timer:null}});
  const registry=target[TRANSFERS];
  if(registry.api!==2||!(registry.entries instanceof Map))throw workspaceError('workspace_location_transfer_unavailable','Core location resource registry is incompatible');
  const epoch=++registry.epoch;
  if(registry.timer!==null)target.clearTimeout(registry.timer);registry.timer=null;
  // This housekeeping closure captures only the registry and document timer
  // surface. Each new provider epoch cancels/replaces its predecessor's code.
  function schedule(){
    if(registry.epoch!==epoch)return;
    if(registry.timer!==null)target.clearTimeout(registry.timer);registry.timer=null;
    let next=Infinity;
    for(const [token,entry] of registry.entries)if(!entry.holder){if(entry.expires<=Date.now())registry.entries.delete(token);else next=Math.min(next,entry.expires);}
    if(next!==Infinity)registry.timer=target.setTimeout(()=>{if(registry.epoch!==epoch)return;registry.timer=null;schedule();},Math.max(1,next-Date.now()));
  }
  schedule();return{entries:registry.entries,schedule};
}
function sameNativeHost(document,current,rootNode,identity){
  if(!identity||current?.rootNode!==rootNode||rootNode?.ownerDocument!==document||!rootNode.isConnected)return false;
  const next=nativeNavigatorIdentity(current.navigator);
  return !!next&&next.kind===identity.kind&&next.navigator===identity.navigator&&
    (identity.kind==='data-router'?next.router===identity.router&&next.navigate===identity.navigate&&next.subscribe===identity.subscribe:
      next.push===identity.push&&next.replace===identity.replace&&next.listen===identity.listen);
}
// Only the transfer token is JSON. Native router state and draft identity stay
// in a bounded document-owned Core registry across provider module replacement.
export function createWorkspaceLocations({document,host,load,check,changed,beforeCapture,beforeRestore,retainGuard,readInput=nativeMainInput,readBinding=nativeInputBinding}) {
  const transfers=connectTransferRegistry(document);
  const handles=new Set();let native,prepared,disposed=false;
  const ensure=()=>prepared??=Promise.resolve().then(load).then(value=>{
    if(disposed)throw workspaceError('workspace_retired','Location provider retired');
    if(typeof value?.restoreLocation!=='function')throw workspaceError('workspace_location_restore_unavailable','Native semantic page restoration is unavailable');
    native=value;return value;
  });
  function capture(live,owner,options={}){
    check();live();
    if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>key!=='restoreState'))throw workspaceError('invalid_argument','Invalid location capture options');
    let retained,registry;
    if(options.restoreState!==undefined){
      const state=options.restoreState;
      if(!state||typeof state!=='object'||Array.isArray(state)||Object.keys(state).length!==2||state.api!==1||typeof state.token!=='string')throw workspaceError('invalid_argument','Invalid location transfer state');
      registry=transfers.entries;retained=registry.get(state.token);
      if(!retained||retained.expires<Date.now()||retained.pluginId!==owner?.pluginId||!Number.isSafeInteger(owner?.generation)||owner.generation<=retained.exportedGeneration)throw workspaceError('workspace_location_transfer_retired','Captured location transfer expired or belongs to another generation');
      if(retained.holder)throw workspaceError('workspace_location_transfer_busy','Captured location still has a live owner');
    }
    // Rebind the live handle to this provider's validated host. Dormant records
    // contain only Native provenance, document/root and Native location/draft refs.
    const source=host(),origin=source?.navigator?.location;
    if(!origin||!source.rootNode?.isConnected)throw workspaceError('workspace_host_pending','Native main page is not ready for capture');
    const identity=retained?retained.nativeIdentity:nativeNavigatorIdentity(source.navigator),rootNode=retained?retained.rootNode:source.rootNode;
    if((retained&&retained.document!==document)||!sameNativeHost(document,source,rootNode,identity))throw workspaceError('workspace_host_drift','Captured location belongs to another Native host');
    const saved=retained?.saved??{...origin};
    if(source.auxiliary||!saved.pathname?.startsWith('/')||saved.pathname.startsWith('/codlet/'))throw workspaceError('workspace_location_unsupported','Capture requires a Native main page');
    const record={active:true,saved,source,pending:null,releaseGuard:retainGuard?.(),draft:retained?.draft??null,transfer:retained?options.restoreState.token:null,holder:{}};handles.add(record);
    if(retained){retained.holder=record.holder;transfers.schedule();}
    const ready=ensure().then(()=>{
      check();live();if(!record.active)throw workspaceError('workspace_retired','Captured location retired');
      if(!sameNativeHost(document,host(),rootNode,identity)||(!retained&&host().navigator.location!==origin))throw workspaceError('workspace_location_superseded','Native location changed before capture readiness');
      if(retained)return;
      beforeCapture?.();const input=readInput(document,native);
      if(input?.controller.view.composing)throw workspaceError('workspace_composer_busy','Native main input is composing');
      if(input&&!input.draft)throw workspaceError('workspace_host_pending','Native draft identity and editor initialization are not confirmed');
      record.draft=input?.draft??null;
    });ready.catch(()=>{});
    const kind=/^\/local\/[\w-]+\/?$/.test(saved.pathname)?'thread':'page';
    const dispose=(options={})=>{if(!record.active)return;
      if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>key!=='releaseTransfer')||(options.releaseTransfer!==undefined&&typeof options.releaseTransfer!=='boolean'))throw workspaceError('invalid_argument','Invalid location disposal options');
      record.active=false;record.pending?.abort();record.releaseGuard?.();
      if(record.transfer){const entries=transfers.entries,entry=entries.get(record.transfer);if(entry?.holder===record.holder){if(options.releaseTransfer)entries.delete(record.transfer);else{entry.holder=null;entry.expires=Date.now()+TRANSFER_LIFETIME;}transfers.schedule();}}
      record.saved=null;record.draft=null;handles.delete(record);};
    return Object.freeze({ready,kind,
      async exportState(){
        await ready;check();live();if(!record.active)throw workspaceError('workspace_retired','Captured location retired');
        if(record.pending)throw workspaceError('workspace_location_busy','Cannot transfer a pending location restoration');
        if(typeof owner?.pluginId!=='string'||!Number.isSafeInteger(owner.generation))throw workspaceError('invalid_owner','Location transfer requires a Core-authenticated workspace owner');
        if(!sameNativeHost(document,host(),rootNode,identity))throw workspaceError('workspace_host_drift','Captured location belongs to another Native host');
        registry=transfers.entries;
        if(!record.transfer){if(registry.size>=TRANSFER_LIMIT)throw workspaceError('resource_limit','Too many retained location transfers');record.transfer=document.defaultView.crypto.randomUUID();}
        registry.set(record.transfer,{document,rootNode,nativeIdentity:identity,saved,draft:record.draft,pluginId:owner.pluginId,exportedGeneration:owner.generation,holder:record.holder,expires:Date.now()+TRANSFER_LIFETIME});
        transfers.schedule();
        return Object.freeze({api:1,token:record.transfer});
      },
      async restore(options={}){
        check();live();if(!record.active)throw workspaceError('workspace_retired','Captured location retired');
        if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>key!=='signal'))throw workspaceError('invalid_argument','Invalid location restoration options');
        if(record.pending)throw workspaceError('workspace_location_busy','Location restoration is pending');
        const controller=new document.defaultView.AbortController();record.pending=controller;
        const signal=options.signal,abort=()=>controller.abort(signal?.reason);
        if(signal!=null&&(typeof signal.aborted!=='boolean'||typeof signal.addEventListener!=='function'||typeof signal.removeEventListener!=='function')){record.pending=null;throw workspaceError('invalid_argument','Invalid location restoration signal');}
        if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
        let observer,frame,unlisten,releaseRestore,inspect;
        try{
          await ready;check();live();if(controller.signal.aborted)throw workspaceError('invocation_cancelled','Location restoration cancelled');
          if(!sameNativeHost(document,host(),rootNode,identity))throw workspaceError('workspace_host_drift','Captured page belongs to another Native host');
          releaseRestore=beforeRestore?.();const current=readInput(document,native);
          if(current?.controller.view.composing)throw workspaceError('workspace_composer_busy','Native main input is composing');
          native.check?.();const restoringFrom=host().navigator.location;native.restoreLocation(record.saved);
          await new Promise((resolve,reject)=>{
            inspect=()=>{try{
              check();live();if(controller.signal.aborted)throw workspaceError('invocation_cancelled','Location restoration cancelled');
              if(!sameNativeHost(document,host(),rootNode,identity))throw workspaceError('workspace_host_drift','Captured page belongs to another Native host');
              const location=host().navigator.location;
              if(location.pathname!==saved.pathname||(location.search??'')!==(saved.search??'')||(location.hash??'')!==(saved.hash??'')||(location.state??null)!==(saved.state??null)){
                if(location===restoringFrom)return;
                throw workspaceError('workspace_location_superseded','Native selected another page during restoration');
              }
              if(record.draft){const restored=readInput(document,native);if(!restored?.draft)return;
                const old=record.draft,value=restored.scope.value;
                // Router location publishes before the Native input commit.
                // A transitional input belongs to the previous page, not an
                // evicted target document. Wait for its semantic owner first.
                if(value.kind!==old.kind||(value.conversationId??null)!==old.conversationId||(value.entrypoint??null)!==old.entrypoint)return;
                const binding=readBinding(restored,native);
                if(old.conversationId!==null&&(!binding||binding.threadId!==old.conversationId||binding.hostId!=='local'))return;
                if(restored.draft.key!==old.key||restored.draft.clientThreadId!==old.clientThreadId||restored.draft.routeKind!==old.routeKind)
                  throw workspaceError('workspace_location_state_evicted','Native restored a different draft namespace');
                if(binding&&kind==='thread')changed(binding);else changed();
              }else changed();resolve();
            }catch(error){if(!['workspace_host_pending','ui_host_pending','workspace_composer_binding_drift'].includes(error.code))reject(error);}};
            observer=new document.defaultView.MutationObserver(inspect);observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['data-app-shell-active-page','data-codex-composer-root']});
            unlisten=native.manager?.addConversationStateCallback?.(inspect);
            document.addEventListener('visibilitychange',inspect);
            frame=document.defaultView.requestAnimationFrame?.(inspect);
            controller.signal.addEventListener('abort',inspect,{once:true});queueMicrotask(inspect);
          });
          return Object.freeze({restored:true,kind});
        }finally{observer?.disconnect();unlisten?.();if(frame!=null)document.defaultView.cancelAnimationFrame?.(frame);if(inspect){controller.signal.removeEventListener('abort',inspect);document.removeEventListener('visibilitychange',inspect);}signal?.removeEventListener('abort',abort);releaseRestore?.();if(record.pending===controller)record.pending=null;}
      },dispose});
  }
  return{capture,prepare:ensure,dispose(){disposed=true;for(const record of [...handles]){record.active=false;record.pending?.abort();record.releaseGuard?.();
    if(record.transfer){const entry=transfers.entries.get(record.transfer);if(entry?.holder===record.holder){entry.holder=null;entry.expires=Date.now()+TRANSFER_LIFETIME;transfers.schedule();}}
    record.saved=null;record.draft=null;}handles.clear();}};
}
