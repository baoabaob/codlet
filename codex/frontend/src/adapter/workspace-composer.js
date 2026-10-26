import { nativeComposerBinding, providersFor, wrapProviders, workspaceError } from './workspace-dom.js';
import { createComposerBinding } from './workspace-composer-binding.js';

function options(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['threadId','hostId','onState'].includes(key)) ||
      !/^[\w-]{8,256}$/.test(value.threadId ?? '') || (value.hostId ?? 'local') !== 'local' || value.onState != null && typeof value.onState !== 'function')
    throw workspaceError('invalid_argument','Invalid local composer identity');
  return { ...value, hostId:'local' };
}

export function createComposers({ document, load, surface, check, report, metrics }) {
  const records=new Set(), containers=new WeakSet(); let native, prepared, disposed=false;
  const boundRecords = new Set(), pendingReleases = new Set(); let cleanupFailure;
  function releaseFailed(error) { cleanupFailure ??= error; }
  function releaseIncomplete(driver) {
    const controller = new AbortController(); let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
      const error = workspaceError('workspace_composer_cleanup_incomplete', 'Incomplete Native driver did not release its resources');
      controller.abort(error); reject(error);
    }, 10000); });
    const pending = Promise.race([Promise.resolve().then(() => {
      if (typeof driver?.close !== 'function') throw workspaceError('workspace_composer_cleanup_incomplete', 'Incomplete Native driver cannot release its resources');
      return driver.close({ signal: controller.signal });
    }), timeout]).finally(() => clearTimeout(timer));
    pendingReleases.add(pending);
    pending.then(() => pendingReleases.delete(pending), error => { pendingReleases.delete(pending); releaseFailed(error); report(error); });
  }
  function ensure() { return prepared ??= Promise.resolve().then(load).then(value => { if(disposed)throw workspaceError('workspace_retired','Composer provider retired'); native=value; return value; }); }
  function binding(record) {
    const input=record.mount.querySelector('[data-codex-composer-root]');
    const value=nativeComposerBinding(input,record.mount,native);
    return value && { ...value, disabled:value.submitDisabled, input, editable:input.querySelector('[contenteditable="true"]') };
  }
  function state(record,phase,error) {
    if(record.phase===phase&&!error)return;record.phase=phase;
    const value=Object.freeze({phase,threadId:record.options.threadId,hostId:'local',diagnostic:error?Object.freeze({code:error.code??'workspace_composer_unavailable',message:error.message}):null});
    try{Promise.resolve(record.options.onState?.(value)).catch(report);}catch(error){report(error);}
  }
  function stopPending(record) { if(record.frame!=null)document.defaultView.cancelAnimationFrame?.(record.frame);record.frame=null;clearTimeout(record.retry);record.retry=null; }
  function rejectActivation(record,code,message) {
    const op=record.activation;if(!op)return;record.activation=null;clearTimeout(op.timer);op.reject(workspaceError(code,message));stopPending(record);
  }
  function deactivate(record) {
    if(record.disposed)return;
    record.epoch++;record.active=false;record.wrapper.setAttribute('inert','');
    if(record.wrapper.contains(document.activeElement))document.activeElement.blur?.();
    rejectActivation(record,'workspace_composer_deactivated','Composer activation was cancelled');
    if(record.readyDone)state(record,'inactive');
    if(record.resume){record.resume=false;render(record);}
  }
  function size(record) {
    if(record.disposed||!record.footer?.isConnected)return;
    const rect=record.footer.getBoundingClientRect(),bottom=record.mount.getBoundingClientRect().bottom;
    const height=Math.ceil(rect.height+Math.max(0,bottom-rect.bottom));
    if(height>0&&Number.isFinite(height)&&height!==record.height){record.height=height;record.sizer.style.height=height+'px';}
  }
  function footer(record,value) {
    const next=value.input.closest('[data-thread-scroll-footer]')??value.input.closest('[data-thread-find-composer]');
    if(!next||!record.mount.contains(next))throw workspaceError('workspace_composer_unavailable','Native composer footer is unavailable');
    if(record.footer!==next){record.resize?.disconnect();record.footer=next;record.resize?.observe(next);size(record);}
  }
  function receipt(record,value) { return Object.freeze({threadId:record.options.threadId,hostId:'local',inputConfirmed:true,submitDisabled:!!value.disabled}); }
  function pulse(record) {
    if(record.disposed||!record.root)return;
    try {
      const value=binding(record);
      if(!value?.editable)return;
      if(value.threadId!==record.options.threadId||value.hostId!=='local')throw workspaceError('workspace_composer_binding_drift','Native composer changed its immutable conversation');
      footer(record,value);
      if(!record.readyDone){record.readyDone=true;clearTimeout(record.readyTimer);state(record,'ready');record.resolveReady(receipt(record,value));}
      const op=record.activation;
      if(op&&op.epoch===record.epoch&&!value.disabled&&native.manager.getConversation(record.options.threadId)?.resumeState==='resumed'&&native.manager.getStreamRole(record.options.threadId)?.role==='owner'){
        record.activation=null;clearTimeout(op.timer);record.active=true;record.wrapper.removeAttribute('inert');stopPending(record);state(record,'active');op.resolve(receipt(record,value));
      }else if(!op)stopPending(record);
    }catch(error){fail(record,error);}
  }
  function schedule(record) {
    if(record.disposed||record.readyDone&&!record.activation)return;
    if(record.frame!=null||record.retry!=null)return;
    const tick=()=>{record.frame=null;record.retry=null;pulse(record);if(!record.readyDone||record.activation)schedule(record);};
    if(document.visibilityState!=='hidden'&&document.defaultView.requestAnimationFrame)record.frame=document.defaultView.requestAnimationFrame(tick);
    else record.retry=setTimeout(tick,50);
  }
  function fail(record,error) {
    if(record.disposed||record.failed)return;record.failed=true;record.active=false;record.wrapper.setAttribute('inert','');stopPending(record);clearTimeout(record.readyTimer);
    if(!record.readyDone)record.rejectReady(error);rejectActivation(record,error.code??'workspace_composer_unavailable',error.message);state(record,'error',error);report(error);
  }
  function render(record) {
    if(record.disposed||record.failed||!record.root)return;
    const N=native,R=N.React,h=R.createElement;
    record.root.render(wrapProviders(N,record.providers,h(record.Boundary,null,h(R.Suspense,{fallback:null},
      h(N.Scope,{scope:N.ThreadScope,value:record.threadValue},h(N.Scope,{scope:N.RouteScope,value:record.routeValue},
        h(N.Frame,{conversationId:record.options.threadId,hostId:'local',canInteract:true,shouldResume:record.resume,composerSubmitDisabled:false,hideThreadContent:true,hostMcpApps:false,disableScrollToTop:true}),h(record.Commit)))))));
  }
  function mount(container,value,owner,live) {
    check();const opts=options(value);
    if(records.size+boundRecords.size>=32)throw workspaceError('resource_limit','At most 32 owned native composers are supported');
    if(!(container instanceof document.defaultView.HTMLElement)||container.ownerDocument!==document||!container.isConnected||container.childNodes.length||containers.has(container)||container.closest('[data-codex-composer-root]')||container.matches('main,.thread-scroll-container'))
      throw workspaceError('invalid_argument','Composer requires a connected empty consumer container');
    if (native?.composerRebind?.supported === true && typeof native.composerRebind.mount === 'function') {
      const source = surface()?.content ?? surface()?.main;
      if (!source?.isConnected) throw workspaceError('workspace_host_pending', 'Native application context is unavailable');
      const providers = providersFor(source);
      if (!providers.length) throw workspaceError('workspace_composer_unavailable', 'Native composer context is unavailable');
      const mount = document.createElement('div');
      mount.dataset.codletWorkspaceOwned = owner; mount.dataset.codletWorkspaceComposer = '';
      mount.setAttribute('inert', ''); mount.style.cssText = 'min-width:0;width:100%;'; container.append(mount); containers.add(container);
      const record = {}; let driver; boundRecords.add(record);
      try {
        driver = native.composerRebind.mount({ document, container: mount, providers, owner, check, metrics });
        const controlled = Object.fromEntries(['bind','activate','block','readBinding','focus','isComposing','close'].map(method => {
          if (typeof driver?.[method] !== 'function') throw workspaceError('workspace_composer_unsupported','Native composer driver is incomplete');
          return [method, driver[method].bind(driver)];
        }));
        const block = controlled.block;
        controlled.block = () => { mount.setAttribute('inert', ''); block(); };
        record.handle = createComposerBinding({ driver: controlled,
          initialIdentity: { threadId: opts.threadId, hostId: 'local' }, onState: state => {
            if (state.phase === 'active') mount.removeAttribute('inert');
            else mount.setAttribute('inert', '');
            return opts.onState?.(state);
          }, check() { check(); live(); }, report, metrics,
          released(error) { if (error) releaseFailed(error); mount.remove(); boundRecords.delete(record); containers.delete(container); } });
        return record.handle;
      } catch (error) {
        try { driver?.block?.(); } catch (failure) { report(failure); }
        if (driver) releaseIncomplete(driver);
        boundRecords.delete(record); containers.delete(container); mount.remove(); throw error;
      }
    }
    const wrapper=document.createElement('div'),sizer=document.createElement('div'),mount=document.createElement('div');
    wrapper.dataset.codletWorkspaceOwned=owner;wrapper.dataset.codletWorkspaceComposer='';wrapper.setAttribute('inert','');
    wrapper.style.cssText='position:relative;min-width:0;width:100%;overflow:hidden;';
    sizer.setAttribute('aria-hidden','true');sizer.dataset.codletWorkspaceComposerSize='';sizer.style.cssText='height:0;pointer-events:none;visibility:hidden;';
    // Keep Native's viewport large enough for draft/attachment growth, while the
    // outer normal-flow sizer follows only the actual Native footer.
    mount.style.cssText='position:absolute;left:0;bottom:0;width:100%;height:100vh;min-width:0;';
    wrapper.append(sizer,mount);container.append(wrapper);
    const record={owner,options:opts,wrapper,sizer,mount,epoch:0,resume:false,active:false,disposed:false,failed:false,readyDone:false,live};records.add(record);containers.add(container);
    const ready=new Promise((resolve,reject)=>{record.resolveReady=resolve;record.rejectReady=reject;});ready.catch(()=>{});
    const valid=()=>{check();live();if(record.disposed||record.failed)throw workspaceError('workspace_retired','Composer handle retired');};
    function dispose() {
      if(record.disposed)return;deactivate(record);record.disposed=true;record.epoch++;stopPending(record);clearTimeout(record.readyTimer);record.observer?.disconnect();record.resize?.disconnect();
      if(!record.readyDone)record.rejectReady(workspaceError('workspace_retired','Composer retired before readiness'));
      if(record.root)native.DOM.flushSync(()=>record.root.unmount());wrapper.remove();records.delete(record);containers.delete(container);state(record,'disposed');
    }
    record.dispose=dispose;state(record,'preparing');
    ensure().then(N=>{
      if(record.disposed)return;valid();N.check?.();
      const source=surface()?.content??surface()?.main??document.querySelector('nav[data-app-navigation-rail="true"]');
      if(!source?.isConnected)throw workspaceError('workspace_host_pending','Native application context is unavailable');
      record.providers=providersFor(source);
      if(!record.providers.length)throw workspaceError('workspace_composer_unavailable','Native composer context is unavailable');
      const route=N.routeDescription({pathname:'/local/'+opts.threadId,search:'?codletComposer='+encodeURIComponent(owner+':'+crypto.randomUUID())});
      if(route?.routeKind!=='local-thread'||route.conversationId!==opts.threadId)throw workspaceError('workspace_composer_unavailable','Native rejected the local composer route');
      record.routeValue=route;record.threadValue={clientThreadId:N.composerValue(route).clientThreadId};
      const R=N.React;
      record.Boundary=class extends R.Component{constructor(props){super(props);this.state={failed:false};}static getDerivedStateFromError(){return{failed:true};}componentDidCatch(error){fail(record,error);}render(){return this.state.failed?null:this.props.children;}};
      record.Commit=function(){R.useLayoutEffect(()=>pulse(record));return null;};
      record.root=N.Client.createRoot(mount,{onUncaughtError:error=>fail(record,error),onCaughtError:error=>fail(record,error)});
      if(document.defaultView.ResizeObserver)record.resize=new document.defaultView.ResizeObserver(()=>size(record));
      record.observer=new document.defaultView.MutationObserver(()=>{if(!record.footer?.isConnected||!record.readyDone||record.activation)pulse(record);});
      record.observer.observe(mount,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled','contenteditable','data-codex-composer-root']});
      render(record);schedule(record);
    }).catch(error=>fail(record,error));
    return Object.freeze({threadId:opts.threadId,hostId:'local',ready,
      activate(){
        valid();
        if(record.active){const current=binding(record);if(current?.threadId===opts.threadId&&!current.disabled)return Promise.resolve(receipt(record,current));}
        deactivate(record);const epoch=++record.epoch;let resolve,reject;
        const result=new Promise((yes,no)=>{resolve=yes;reject=no;});result.catch(()=>{});
        const op={epoch,resolve,reject};record.activation=op;
        state(record,'activating');
        ready.then(()=>{
          if(record.disposed||record.activation!==op)return;valid();native.check?.();
          if(native.manager.getConversation(opts.threadId)?.resumeState!=='resumed'||native.manager.getStreamRole(opts.threadId)?.role!=='owner'){record.resume=true;render(record);}
          pulse(record);schedule(record);
        }).catch(error=>{if(record.activation===op)rejectActivation(record,error.code??'workspace_composer_unavailable',error.message);});
        return result;
      },
      deactivate(){valid();deactivate(record);},
      focus(){valid();if(!record.active)throw workspaceError('workspace_composer_inactive','Activate the composer before focusing it');const value=binding(record);if(!value?.editable||value.threadId!==opts.threadId||value.disabled)throw workspaceError('workspace_composer_not_ready','Native composer is not ready to focus');value.editable.focus({preventScroll:true});return document.activeElement===value.editable||value.editable.contains(document.activeElement);},
      dispose,
    });
  }
  return{mount,prepare:ensure,
    supportsRebind:()=>native?.composerRebind?.supported===true&&typeof native.composerRebind.mount==='function',
    async cleanup({signal}={}) {
      const results = await Promise.allSettled([...pendingReleases, ...[...boundRecords].map(record=>record.handle.close({signal}))]);
      for (const result of results) if (result.status === 'rejected') releaseFailed(result.reason);
      if (cleanupFailure) throw cleanupFailure;
    },
    dispose(){if(disposed)return;for(const record of [...records])record.dispose();for(const record of [...boundRecords])record.handle.dispose();disposed=true;}};
}
