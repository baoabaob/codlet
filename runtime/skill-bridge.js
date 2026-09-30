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
  function findClient(){
    const root=document.getElementById('root');
    if(!root)return null;
    const container=root&&root[Object.keys(root).find(k=>k.startsWith('__reactContainer$'))];
    const pending=[container?.stateNode?.current??container],seen=new Set(),nodes=new Set(),clients=new Set();
    while(pending.length){const fiber=pending.pop();if(!fiber||seen.has(fiber))continue;
      if(seen.size>=20000)throw Error('The Desktop tree exceeds the skill discovery limit');seen.add(fiber);
      const chain=fiber.memoizedProps?.value;
      if(chain instanceof Map)for(const node of chain.values()){
        if(!node?.token||chain.get(node.token.id)!==node||!(node.familyBindings instanceof Map)||nodes.has(node))continue;
        nodes.add(node);if(nodes.size>256||node.familyBindings.size>512)throw Error('The Desktop scope exceeds the skill discovery limit');
        const bound=[];
        for(const [family,bindings]of node.familyBindings){
          if(family?.scope!==node.token||typeof family.read!=='function'||!(bindings instanceof Map)||!bindings.has('local'))continue;
          bound.push(family.read(node,chain,'local'));
        }
        for(const manager of bound){
          const client=manager?.requestClient;
          if(typeof manager?.getHostId==='function'&&manager.getHostId()==='local'&&typeof manager.getConversation==='function'&&bound.includes(client)&&
            typeof client?.sendRequest==='function'&&typeof client.getAppServerVersion==='function'&&typeof client.setAppServerVersion==='function'&&client.requestPromises instanceof Map)clients.add(client);
        }
      }
      if(fiber.sibling)pending.push(fiber.sibling);if(fiber.child)pending.push(fiber.child);
    }
    if(clients.size>1)throw Error('The local Desktop skill connection is ambiguous');
    return clients.size===1?[...clients][0]:null;
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
    const deadline=Date.now()+30000;
    // Reuse the mounted local request client. Hashed resources, minified export
    // names and frontend/backend versions are not part of the skills RPC ABI.
    while(state.alive&&!state.client){const client=findClient();if(client?.getAppServerVersion?.())state.client=client;else{if(Date.now()>deadline)throw Error('The local App Server is not ready for the Codlet skill');await delay(100);}}
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
  })().catch(error=>{if(state.alive){state.status='failed';state.error=String(error.message??error);void ask('failed',{message:state.error.slice(0,1000)}).catch(()=>{});}});
}
