function installCodletSkill(config) {
  'use strict';
  const key=Symbol.for(config.marker);
  if(globalThis[key])return;
  if(location.origin!=='app://-'||location.pathname!=='/index.html')return;
  const state={alive:true,status:'starting',error:null,requests:new Map(),delays:new Map(),client:null,clientId:null,clientEpoch:0,authorityId:null,original:null,versionSetter:null,nativeWrites:new Set(),uncertain:false,uncertainAuthority:null,cleanup:null};
  let retired;
  const retirement=new Promise(resolve=>{retired=resolve;});
  const stopped=()=>Object.assign(Error('Codlet Core stopped'),{code:'runtime_skill_retired'});
  const unknown=()=>Object.assign(Error('The Native skill root write outcome is unknown until this Core runtime retires'),{code:'native_skill_write_unknown'});
  const owned=promise=>Promise.race([promise,retirement.then(()=>{throw stopped();})]);
  function waitSignal(promise,signal) {
    if(typeof signal?.addEventListener!=='function')return promise;
    return new Promise((resolve,reject)=>{
      const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason??Error('Skill readiness was cancelled'));};
      if(signal.aborted){abort();return;}
      signal.addEventListener('abort',abort,{once:true});
      promise.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
    });
  }
  globalThis[key]=state;
  let sequence=0;
  const delay=ms=>new Promise((resolve,reject)=>{if(!state.alive)return reject(Error('Codlet Core stopped'));const timer=setTimeout(()=>{state.delays.delete(timer);resolve();},ms);state.delays.set(timer,reject);});
  function ask(action,params={}) {
    return new Promise((resolve,reject)=>{
      if(!state.alive)return reject(Error('Codlet Core stopped'));
      const id=++sequence,timer=setTimeout(()=>{state.requests.delete(id);reject(Error('Codlet Core skill response timed out'));},5000);
      state.requests.set(id,{resolve,reject,timer,action,epoch:state.clientEpoch});
      try{globalThis[config.binding](JSON.stringify({id,action,clientId:state.clientId,clientEpoch:state.clientEpoch,...(state.authorityId?{authorityId:state.authorityId}:{}),...params}));}catch(error){clearTimeout(timer);state.requests.delete(id);reject(error);}
    });
  }
  state.receive=(id,value)=>{const pending=state.requests.get(id);if(!pending)return;clearTimeout(pending.timer);state.requests.delete(id);if(value.error&&value.unobserved&&pending.action==='baseline'&&pending.epoch===state.clientEpoch)state.authorityId=null;value.error?pending.reject(Object.assign(Error(value.error),{code:value.unknown?'native_skill_write_unknown':value.unobserved?'native_skill_roots_unobserved':'runtime_skill_contract'})):pending.resolve(value);};
  function markUnknown(scope={}) {
    if(!scope.authorityId||scope.authorityId===state.authorityId){state.uncertain=true;state.uncertainAuthority=scope.authorityId??state.authorityId;state.status='unknown';state.error=unknown().message;}
    if(state.alive)void ask('unknown',scope).catch(()=>{});
  }
  function nativeWrite(params,options,operation) {
    const book=state.client.requestPromises,before=new Map(book),record={book,client:state.client,epoch:state.clientEpoch,authorityId:state.authorityId,pending:[],promise:null};
    if(state.nativeWrites.size)markUnknown();
    state.nativeWrites.add(record);operation.dispatched=true;operation.native=record;
    let result;
    try{result=state.original.call(state.client,'skills/extraRoots/set',params,options);}catch(error){result=Promise.reject(error);}
    for(const [id,pending]of book)if(before.get(id)!==pending||!before.has(id))record.pending.push([id,pending]);
    record.promise=Promise.resolve(result).finally(()=>state.nativeWrites.delete(record));
    return record.promise;
  }
  const sameNativeWrite=record=>record.client===state.client&&record.epoch===state.clientEpoch&&record.authorityId===state.authorityId&&record.book===state.client.requestPromises&&record.pending.every(([id,pending])=>!record.book.has(id)||record.book.get(id)===pending);
  async function baseline() {
    const client=state.client,epoch=state.clientEpoch,book=client.requestPromises;
    if(findClient()!==client||client.hostId!=='local'||client.requestClientId!==state.clientId)throw Object.assign(Error('The current Native skill connection changed'),{code:'native_skill_owner_changed'});
    const pending=[...book].filter(([id,value])=>(typeof id==='string'&&id.length>0||Number.isSafeInteger(id))&&typeof value?.method==='string');
    const reply=await ask('baseline',{anchors:pending.map(([id,value])=>({id,method:value.method}))});
    if(!state.alive||client!==state.client||client.hostId!=='local'||client.requestClientId!==state.clientId||epoch!==state.clientEpoch||book!==client.requestPromises||pending.some(([id,value])=>book.has(id)&&book.get(id)!==value))throw Object.assign(Error('The Native skill request owner changed during observation'),{code:'native_skill_owner_changed'});
    if(reply.authorityId){if(state.uncertain&&reply.observed===true&&reply.authorityId!==state.uncertainAuthority){state.uncertain=false;state.uncertainAuthority=null;}state.authorityId=reply.authorityId;}
    return reply;
  }
  function findClient(){
    const root=document.getElementById('root');
    if(!root)return null;
    const container=root&&root[Object.keys(root).find(k=>k.startsWith('__reactContainer$'))];
    const pending=[container?.stateNode?.current??container],seen=new Set(),nodes=new Set(),clients=new Set();
    while(pending.length){const fiber=pending.pop();if(!fiber||seen.has(fiber))continue;
      seen.add(fiber);
      const chain=fiber.memoizedProps?.value;
      if(chain instanceof Map)for(const node of chain.values()){
        if(!node?.token||chain.get(node.token.id)!==node||!(node.familyBindings instanceof Map)||nodes.has(node))continue;
        nodes.add(node);
        const bound=[];
        for(const [family,bindings]of node.familyBindings){
          if(family?.scope!==node.token||typeof family.read!=='function'||!(bindings instanceof Map)||!bindings.has('local'))continue;
          bound.push(family.read(node,chain,'local'));
        }
        for(const manager of bound){
          const client=manager?.requestClient;
          if(typeof manager?.getHostId==='function'&&manager.getHostId()==='local'&&typeof manager.getConversation==='function'&&bound.includes(client)&&
            client?.hostId==='local'&&typeof client.sendRequest==='function'&&typeof client.getAppServerVersion==='function'&&typeof client.setAppServerVersion==='function'&&client.requestPromises instanceof Map)clients.add(client);
        }
      }
      if(fiber.sibling)pending.push(fiber.sibling);if(fiber.child)pending.push(fiber.child);
    }
    if(clients.size>1)throw Error('The local Desktop skill connection is ambiguous');
    return clients.size===1?[...clients][0]:null;
  }
  async function updateRoots(roots,options,operation={dispatched:false},nativeCaller=false) {
    for(;;){
      const fact=await baseline();
      if(state.uncertain)throw unknown();
      if(fact.busy){if(nativeCaller)throw Error('A Native skill root write is already pending');await delay(50);continue;}
      const scope={clientId:state.clientId,clientEpoch:state.clientEpoch,authorityId:state.authorityId};
      const lease=await ask(roots?'set':'ensure',roots?{roots}:{});
      if(scope.clientEpoch!==state.clientEpoch||scope.authorityId!==state.authorityId)throw stopped();
      if(lease.ready){
        if(!state.alive)throw stopped();
        if(state.uncertain)throw unknown();
        state.status='ready';state.error=null;return;
      }
      if(lease.busy){if(nativeCaller)throw Error('A Native skill root write is already pending');await delay(50);continue;}
      let result;
      try {
        const preparedFact=await baseline();
        if(preparedFact.busy)throw Error('The Native skill roots changed before dispatch');
        const admitted=await ask('dispatch',{...scope,ticket:lease.ticket});
        if(admitted.admitted!==true)throw Error('The Native skill root write was not admitted');
        if(!state.alive||scope.clientEpoch!==state.clientEpoch||scope.authorityId!==state.authorityId)throw stopped();
        const pending=nativeWrite({extraRoots:lease.roots},options,operation);
        result=await(nativeCaller?pending:owned(pending));
      } catch(error){
        if(operation.dispatched){markUnknown(scope);if(state.alive)await ask('complete',{...scope,ticket:lease.ticket,ok:false,unknown:true}).catch(()=>{});}
        else if(state.alive)await ask('complete',{...scope,ticket:lease.ticket,ok:false}).catch(()=>{});
        throw error;
      }
      if(!state.alive)return result;
      if(state.uncertain||!sameNativeWrite(operation.native)){markUnknown(scope);if(nativeCaller)return result;throw unknown();}
      try {const fact=await baseline();if(fact.busy)throw unknown();await ask('complete',{...scope,ticket:lease.ticket,ok:true});}
      catch(error){markUnknown(scope);if(nativeCaller)return result;throw error;}
      state.status='ready';state.error=null;return result;
    }
  }
  let ensuring=null;
  const ensure=options=>ensuring??=(updateRoots(undefined,options).finally(()=>{ensuring=null;}));
  state.dispose=async roots=>{
    if(!state.alive)return state.disposal;
    const owns=state.wrapper&&state.client?.sendRequest===state.wrapper;
    state.alive=false;retired();
    for(const [timer,reject] of state.delays){clearTimeout(timer);reject(Error('Codlet Core stopped'));}state.delays.clear();
    for(const request of state.requests.values()){clearTimeout(request.timer);request.reject(Error('Codlet Core stopped'));}state.requests.clear();
    state.disposal=(async()=>{
      let status='retired',reason=null;
      if(state.nativeWrites.size||state.uncertain){status='unknown';reason=state.nativeWrites.size?'native_skill_write_pending':'native_skill_write_unknown';}
      else if(roots&&state.original&&owns){
        try{state.cleanup=nativeWrite({extraRoots:roots},{timeoutMs:3000},{});await state.cleanup;status='restored';}
        catch{status='unknown';reason='native_skill_write_unknown';}
      }
      if(state.wrapper&&state.client?.sendRequest===state.wrapper)state.client.sendRequest=state.original;
      if(state.versionWrapper&&state.client?.setAppServerVersion===state.versionWrapper)state.client.setAppServerVersion=state.versionSetter;
      if(globalThis[key]===state)delete globalThis[key];
      return {api:1,status,reason,pendingNativeWrites:state.nativeWrites.size};
    })();
    return state.disposal;
  };
  state.ready=(async()=>{
    const fastDiscoveryUntil=Date.now()+30000;
    // Reuse the mounted local request client. Hashed resources, minified export
    // names and frontend/backend versions are not part of the skills RPC ABI.
    while(state.alive&&!state.client){
      const client=findClient();
      if(client?.getAppServerVersion?.())state.client=client;
      else{
        // First-run setup can outlast the initial discovery window. Retain an
        // owned, slower wait so a later ready connection can still register.
        const slow=Date.now()>=fastDiscoveryUntil;
        if(slow)state.status='waiting';
        await delay(slow?1000:100);
      }
    }
    if(!state.alive)return;
    const client=state.client;if(typeof client.sendRequest!=='function'||typeof client.setAppServerVersion!=='function')throw Error('The native skill connection changed');
    if(typeof client.requestClientId!=='string'||!client.requestClientId)throw Error('The Native request client identity is unavailable');
    state.clientId=client.requestClientId;
    state.original=client.sendRequest;state.versionSetter=client.setAppServerVersion;
    state.versionWrapper=function(...args){const result=state.versionSetter.apply(this,args);state.clientEpoch++;state.authorityId=null;ensuring=null;state.status='waiting';return result;};
    state.wrapper=async function(method,params,options){
      if(this!==state.client)return state.original.call(this,method,params,options);
      if(!state.alive){if(method==='skills/extraRoots/set'&&state.cleanup)await state.cleanup.catch(()=>{});return state.original.call(this,method,params,options);}
      if(method==='skills/extraRoots/set'){
        const operation={dispatched:false};
        try{
          if(!Array.isArray(params?.extraRoots)||Object.keys(params).some(k=>k!=='extraRoots'))throw Error('The Native skill root parameters cannot be merged');
          return await updateRoots(params.extraRoots,options,operation,true);
        }catch(error){if(operation.dispatched)throw error;return nativeWrite(params,options,operation);}
      }
      if(['skills/list','thread/start','thread/resume','thread/fork','turn/start'].includes(method)){
        const required=method==='turn/start'&&params?.input?.some(i=>i.type==='text'&&/^\s*\/codlet(?:\s|$)/.test(i.text));
        if(!required){
          const result=state.original.call(this,method,params,options);
          ensure(options).catch(error=>{if(state.alive&&!state.uncertain){state.status=error.code==='native_skill_roots_unobserved'?'waiting':'failed';state.error=String(error.message??error);}});
          return result;
        }
        await waitSignal(ensure(options),options?.signal);
      }
      if(method==='turn/start'&&Array.isArray(params?.input)&&params.input.some(i=>i.type==='text'&&/^\s*\/codlet(?:\s|$)/.test(i.text))&&!params.input.some(i=>i.type==='skill'&&i.name==='codlet')){
        params={...params,input:[...params.input,{type:'skill',name:'codlet',path:config.skillPath}]};
      }
      return state.original.call(this,method,params,options);
    };
    client.sendRequest=state.wrapper;client.setAppServerVersion=state.versionWrapper;
    await ensure();
  })();
  state.ready.catch(error=>{if(state.alive&&!state.uncertain){state.status=error.code==='native_skill_roots_unobserved'?'waiting':'failed';state.error=String(error.message??error);if(state.status==='failed')void ask('failed',{message:state.error.slice(0,1000)}).catch(()=>{});}});
}
