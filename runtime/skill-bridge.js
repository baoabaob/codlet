function installCodletSkill(config) {
  'use strict';
  const key=Symbol.for(config.marker);
  if(globalThis[key])return;
  if(location.origin!=='app://-'||location.pathname!=='/index.html')return;
  const state={alive:true,status:'starting',error:null,requests:new Map(),delays:new Map(),client:null,original:null,versionSetter:null};
  globalThis[key]=state;
  let sequence=0;
  const delay=ms=>new Promise((resolve,reject)=>{if(!state.alive)return reject(Error('Codlet Core stopped'));const timer=setTimeout(()=>{state.delays.delete(timer);resolve();},ms);state.delays.set(timer,reject);});
  function ask(action,params={}) {
    return new Promise((resolve,reject)=>{
      if(!state.alive)return reject(Error('Codlet Core stopped'));
      const id=++sequence,timer=setTimeout(()=>{state.requests.delete(id);reject(Error('Codlet Core skill response timed out'));},5000);
      state.requests.set(id,{resolve,reject,timer});
      try{globalThis[config.binding](JSON.stringify({id,action,...params}));}catch(error){clearTimeout(timer);state.requests.delete(id);reject(error);}
    });
  }
  state.receive=(id,value)=>{const pending=state.requests.get(id);if(!pending)return;clearTimeout(pending.timer);state.requests.delete(id);value.error?pending.reject(Error(value.error)):pending.resolve(value);};
  function findClient(module,profile){
    const token=module[profile.exports.scope],family=module[profile.exports.client],root=document.getElementById('root');
    if(!token||!family||!root)return null;
    const container=root&&root[Object.keys(root).find(k=>k.startsWith('__reactContainer$'))];
    const pending=[container?.stateNode?.current??container],seen=new Set();
    while(pending.length&&seen.size<4096){const fiber=pending.pop();if(!fiber||seen.has(fiber))continue;seen.add(fiber);
      const chain=fiber.memoizedProps?.value,node=chain instanceof Map&&chain.get(token?.id);
      if(node?.token===token&&node.familyBindings?.get(family)?.has('local'))return family.read(node,chain,'local');
      if(fiber.sibling)pending.push(fiber.sibling);if(fiber.child)pending.push(fiber.child);
    }
    return null;
  }
  async function updateRoots(roots) {
    const deadline=Date.now()+15000;
    for(;;){
      const lease=await ask(roots?'set':'ensure',roots?{roots}:{});
      if(lease.ready)return;
      if(lease.busy){if(Date.now()>deadline)throw Error('Another skill root registration is still pending');await delay(50);continue;}
      try {
        await state.original.call(state.client,'skills/extraRoots/set',{extraRoots:lease.roots},{timeoutMs:10000});
        await ask('complete',{ticket:lease.ticket,ok:true});state.status='ready';state.error=null;return;
      } catch(error){await ask('complete',{ticket:lease.ticket,ok:false}).catch(()=>{});throw error;}
    }
  }
  state.dispose=async roots=>{
    if(!state.alive)return;
    state.alive=false;
    for(const [timer,reject] of state.delays){clearTimeout(timer);reject(Error('Codlet Core stopped'));}state.delays.clear();
    for(const request of state.requests.values()){clearTimeout(request.timer);request.reject(Error('Codlet Core stopped'));}state.requests.clear();
    if(state.wrapper&&state.client?.sendRequest===state.wrapper)state.client.sendRequest=state.original;
    if(state.versionWrapper&&state.client?.setAppServerVersion===state.versionWrapper)state.client.setAppServerVersion=state.versionSetter;
    // Only Core shutdown supplies the complete retained set, excluding our root.
    if(roots&&state.original)await state.original.call(state.client,'skills/extraRoots/set',{extraRoots:roots},{timeoutMs:3000}).catch(()=>{});
    if(globalThis[key]===state)delete globalThis[key];
  };
  void(async()=>{
    const build=globalThis.electronBridge?.getSentryInitOptions?.();
    const profile=config.profiles.find(profile=>build?.appVersion===profile.appVersion&&String(build?.buildNumber)===profile.buildNumber);
    if(!profile)throw Error('Codlet runtime skill has no reviewed client profile');
    const deadline=Date.now()+30000;
    while(state.alive&&!Array.from(document.scripts).some(script=>script.src===profile.entry)){
      if(document.readyState==='complete'||Date.now()>deadline)throw Error('The Desktop entry resource changed');
      await delay(50);
    }
    if(!state.alive)return;
    const module=await import(profile.module);
    while(state.alive&&!state.client){const client=findClient(module,profile);if(client?.getAppServerVersion?.()===profile.appServerVersion)state.client=client;else{if(Date.now()>deadline)throw Error('The local App Server is not ready for the Codlet skill');await delay(100);}}
    if(!state.alive)return;
    const client=state.client;if(typeof client.sendRequest!=='function'||typeof client.setAppServerVersion!=='function')throw Error('The native skill connection changed');
    state.original=client.sendRequest;state.versionSetter=client.setAppServerVersion;
    state.versionWrapper=function(...args){const result=state.versionSetter.apply(this,args);void ask('invalidate').catch(()=>{});return result;};
    state.wrapper=async function(method,params,options){
      if(method==='skills/extraRoots/set'){
        if(!Array.isArray(params?.extraRoots)||Object.keys(params).some(k=>k!=='extraRoots'))return state.original.call(this,method,params,options);
        await updateRoots(params.extraRoots);return {};
      }
      if(['skills/list','thread/start','thread/resume','thread/fork','turn/start'].includes(method)){
        try{await updateRoots();}catch(error){state.status='failed';state.error=String(error.message??error);if(method==='turn/start'&&params?.input?.some(i=>i.type==='text'&&/^\s*\/codlet(?:\s|$)/.test(i.text)))throw error;}
      }
      if(method==='turn/start'&&Array.isArray(params?.input)&&params.input.some(i=>i.type==='text'&&/^\s*\/codlet(?:\s|$)/.test(i.text))&&!params.input.some(i=>i.type==='skill'&&i.name==='codlet')){
        params={...params,input:[...params.input,{type:'skill',name:'codlet',path:config.skillPath}]};
      }
      return state.original.call(this,method,params,options);
    };
    client.sendRequest=state.wrapper;client.setAppServerVersion=state.versionWrapper;
    await updateRoots();
  })().catch(error=>{if(state.alive){state.status='failed';state.error=String(error.message??error);}});
}
