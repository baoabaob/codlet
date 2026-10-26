// Executed only by Core in its owned, audited main renderer. No new service
// connection is created. Read the existing official AppScope update signal.
(async () => {
  const profiles = __CODLET_PROFILES__, action = __CODLET_ACTION__;
  const detected = globalThis.electronBridge?.getSentryInitOptions?.();
  const entries = new Set(Array.from(document.scripts, script => script.src));
  const matchesByEntry = profiles.builds.filter(p => p.appVersion === detected?.appVersion && p.buildNumber === String(detected?.buildNumber) && entries.has(p.entry));
  const profile = matchesByEntry.length === 1 ? matchesByEntry[0] : null;
  if (window !== window.top || location.origin !== 'app://-' || location.pathname !== '/index.html' || !profile?.officialUpdates) return {available:false,reason:'profile'};
  const module = await import(profile.module), scopeModule = profile.scopeModule ? await import(profile.scopeModule) : module;
  const servicesModule = !profile.servicesModule || profile.servicesModule === profile.module ? module :
    profile.servicesModule === profile.scopeModule ? scopeModule : await import(profile.servicesModule);
  const token = scopeModule[profile.exports.scope];
  const root = document.getElementById('root'), key = root && Object.keys(root).find(k => k.startsWith('__reactContainer$'));
  const container = key && root[key], pending = [container?.stateNode?.current ?? container], seen = new Set();
  let node,chain;
  while (pending.length) {
    const fiber = pending.pop(); if (!fiber || seen.has(fiber)) continue; seen.add(fiber);
    const current = fiber.memoizedProps?.value, candidate = current instanceof Map && current.get(token?.id);
    if (candidate?.token === token && candidate.familyBindings instanceof Map && candidate.store) { node = candidate; chain = current; break; }
    if (fiber.child) pending.push(fiber.child); if (fiber.sibling) pending.push(fiber.sibling);
  }
  const selector = module[profile.officialUpdates.stateSelector];
  if (!node || selector?.scope !== token || typeof selector.resolve !== 'function') return {available:false,reason:'scope'};
  const matches = [];
  // Read the audited selector's existing update dependency; no atom writes or
  // additional application service connection is created.
  selector.resolve(node,chain).read(atom => {
    const value = node.store.get(atom);
    if (value && typeof value.isUpdateReady === 'boolean' && ['idle','checking','downloading','ready','installing'].includes(value.lifecycleState) && 'downloadProgressPercent' in value && 'installProgressPercent' in value && 'relaunchNotice' in value && typeof value.supportsAutoInstallWhenIdle === 'boolean') matches.push({value,atom});
    return value;
  });
  const services = servicesModule[profile.exports.services];
  if (matches.length !== 1 || typeof services?.appUpdates?.installUpdate !== 'function') return {available:false,reason:'state'};
  const value = matches[0].value;
  const result = {available:true,phase:value.lifecycleState,isUpdateReady:value.isUpdateReady};
  const guardKey=Symbol.for('codlet.core.official-update-guard.v1');
  let guard=globalThis[guardKey];
  if(action.kind==='dispose'){
    guard?.dispose();delete globalThis[guardKey];return result;
  }
  if(action.guard===true){
    if(guard&&guard.services!==services&&guard.wrappedServices!==services){guard.dispose();guard=null;}
    if(!guard){
      const updates=services.appUpdates,install=updates.installUpdate,setServices=servicesModule[profile.exports.servicesSetter];
      const state={services,updates,install,warn:true,inFlight:null,preference:null,wrappedServices:null,readState:()=>node.store.get(matches[0].atom)};
      const cancelPreference=()=>{if(state.preference){state.preference.resolve(false);state.preference=null;}};
      async function guardedInstall(...args){
        if(state.inFlight)return state.inFlight;
        const task=(async()=>{
          if(state.warn){
            const chinese=/^zh(?:[-_]|$)/i.test(document.documentElement?.lang??'');
            let choice;
            try{choice=await globalThis.__codletRendererV1?.__confirmOfficialUpdate();}catch{}
            if(typeof choice?.accepted!=='boolean')choice={accepted:globalThis.confirm?.(chinese?'直接更新官方客户端可能导致 Codlet 不适配，是否仍要更新？':'Updating the official client directly may make Codlet incompatible. Update anyway?')===true,suppress:false};
            if(!choice.accepted)return;
            if(choice.suppress){
              const saved=await new Promise(resolve=>{state.preference={id:crypto.randomUUID(),resolve};});
              if(!saved)globalThis.alert?.(chinese?'无法保存“不再显示此提示”，下次更新时仍会提示。':'The warning preference could not be saved. It will appear again next time.');
            }
          }
          const latest=state.readState();
          if(!latest?.isUpdateReady||latest.lifecycleState!=='ready')return;
          return install.apply(updates,args);
        })();
        state.inFlight=task;
        try{return await task;}finally{if(state.inFlight===task)state.inFlight=null;}
      }
      const descriptor=Object.getOwnPropertyDescriptor(updates,'installUpdate');
      if(typeof setServices==='function'){
        const wrappedUpdates=new Proxy(updates,{get(target,key){return key==='installUpdate'?guardedInstall:Reflect.get(target,key,target);}});
        state.wrappedServices=new Proxy(services,{get(target,key){return key==='appUpdates'?wrappedUpdates:Reflect.get(target,key,target);}});
        setServices(state.wrappedServices);
        state.dispose=()=>{cancelPreference();if(servicesModule[profile.exports.services]===state.wrappedServices)setServices(services);};
      }else{
        try{Object.defineProperty(updates,'installUpdate',{configurable:true,writable:true,value:guardedInstall});}catch{}
        if(services.appUpdates.installUpdate!==guardedInstall)return {...result,warningAvailable:false};
        state.dispose=()=>{cancelPreference();if(updates.installUpdate===guardedInstall){if(descriptor)Object.defineProperty(updates,'installUpdate',descriptor);else delete updates.installUpdate;}};
      }
      guard=globalThis[guardKey]=state;
    }
    guard.warn=action.warnBeforeUpdate!==false;
    guard.readState=()=>node.store.get(matches[0].atom);
    if(guard.preference&&action.warningReceipt?.id===guard.preference.id){
      const pending=guard.preference;guard.preference=null;pending.resolve(action.warningReceipt.saved===true);
    }
    result.warningAvailable=true;
    if(guard.preference)result.warningRequest={id:guard.preference.id};
  }
  if (action.kind === 'retire') {
    const key = Symbol.for('codlet.core.official-install');
    if (globalThis[key] === action.id && ['idle','ready'].includes(value.lifecycleState)) delete globalThis[key];
    return result;
  }
  if (action.kind === 'install') {
    const key = Symbol.for('codlet.core.official-install');
    if (globalThis[key]) return {...result,accepted:globalThis[key] === action.id};
    if (value.lifecycleState !== 'ready' || !value.isUpdateReady) return {...result,accepted:false};
    // Reserve before invoking. A lost reply must never issue a second install.
    globalThis[key] = action.id;
    // A combined transaction has already received its own explicit consent.
    await (guard?guard.install.call(guard.updates):services.appUpdates.installUpdate());
    return {...result,accepted:true};
  }
  return result;
})()
