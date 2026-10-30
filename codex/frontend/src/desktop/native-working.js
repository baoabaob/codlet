import {loadedAsset,localConnection,hostFibers,linkedNodes} from '../host-discovery.js';
import {resolveLoadedAsset,captureResolvedAssets} from '../host-assets.js';
import {awaitNativeInitialization} from '../adapter/native-readiness.js';
const pending=message=>Object.assign(new Error(message),{code:'desktop_host_pending'});
const drift=message=>Object.assign(new Error(message),{code:'desktop_working_drift'});

function mountedWorkingScope(connection){
  const {node}=connection;
  for(const fiber of hostFibers())for (const hook of linkedNodes(fiber.memoizedState)){
    const value=hook.memoizedState?.current;
    if(value?.scope===node.token&&value.node===node&&value.chain?.get(node.token.id)===node&&typeof value.get==='function'&&typeof value.watch==='function')return value;
  }
  throw pending('Native Working AppScope facade is not mounted');
}

// Reviewed against Native 26.1007.2314 original assets: f9n resolves response,
// runtime and owned child work; k9n resolves blocking/nonblocking input; lGo
// resolves publication. Unknown asset pairs never inherit these private keys.
export const WORKING_PROFILE=Object.freeze({
  initial:'app-initial-b8e1c8014bb4.js',shared:'app-shared-737655e1fb23.js',
  response:'vfn',pending:'nfn',publishing:'AW'
});
// Source hashes, exact export bindings and preserved response/input/owned-work/
// publication semantics: docs/native-working-26.1007.9446.0.json. Availability
// still requires the actual mounted Native scope; platform acceptance is separate.
// Builds 20770/21161: docs/native-desktop-20261021.md. Builds 21421/21477:
// their docs/native-desktop-<build>.json reports verify selectors and AppScope.
export const WORKING_PROFILES=Object.freeze([WORKING_PROFILE,Object.freeze({
  initial:'app-initial-102e45562729.js',shared:'app-shared-30671c57ec82.js',
  response:'vfn',pending:'nfn',publishing:'AW'
}),Object.freeze({
  initial:'app-initial-5851df3f6cb1.js',shared:'app-shared-bbfeca5e5737.js',
  response:'Sbn',pending:'nbn',publishing:'oZ'
}),Object.freeze({
  initial:'app-initial-2b6b8063022d.js',shared:'app-shared-9cc135f1bdc1.js',
  response:'NCn',pending:'pCn',publishing:'JQ'
}),Object.freeze({
  initial:'app-initial-83973da15da9.js',shared:'app-shared-efae91d19fbd.js',
  response:'NCn',pending:'pCn',publishing:'JQ'
}),Object.freeze({
  initial:'app-initial-ad16eaadf81f.js',shared:'app-shared-2feb3d4c6fcc.js',
  response:'NCn',pending:'pCn',publishing:'JQ'
}),Object.freeze({
  initial:'app-initial-438d1df57f70.js',shared:'app-shared-955d52676f9c.js',
  response:'hRn',pending:'pRt',publishing:'_E',publishingModule:'app-primary-844e405f2b90.js'
}),Object.freeze({
  initial:'app-initial-b0cd131b9dba.js',shared:'app-shared-624e1c099f95.js',
  response:'oLn',pending:'pBt',publishing:'xE',publishingModule:'app-primary-8eba40dc50b2.js'
}),Object.freeze({
  initial:'app-initial-4267e52fe5b0.js',shared:'app-shared-b9a49a97ca55.js',
  response:'VXt',pending:'tXt',publishing:'FC',publishingModule:'app-primary-998934e837fc.js'
})]);

export function nativeWorkingState(response,pending,publishing){
  if(!['loading','idle','error'].includes(response)||typeof publishing!=='boolean'||
    pending!==null&&(!pending||!['input','approval'].includes(pending.kind)||typeof pending.blocking!=='boolean'))return null;
  if(publishing)return true;
  if(response!=='loading')return false;
  // A blocking request has paused this execution; an asynchronous input does
  // not stop concurrent work. Unread/hidden/virtualized presentation is ignored.
  return pending?.blocking!==true;
}

export async function loadNativeWorking({load=url=>import(url),connect=localConnection,scope=mountedWorkingScope,asset=loadedAsset,read,signal,report=()=>{}}={}){
  const [initialUrl,sharedUrl]=await Promise.all(['initial','shared'].map(name=>asset===loadedAsset?resolveLoadedAsset(name,{read,signal}):asset(name)));
  const checkAssets=asset===loadedAsset?captureResolvedAssets({initial:initialUrl,shared:sharedUrl},{signal}):()=>signal?.throwIfAborted();
  const profile=WORKING_PROFILES.find(value=>initialUrl===`app://-/assets/${value.initial}`&&sharedUrl===`app://-/assets/${value.shared}`);
  if(!profile)throw Error('Native Working profile is not reviewed');
  let connection,retirement;
  const retire=()=>{
    if(!connection)return;
    if(retirement)return retirement;
    signal?.removeEventListener('abort',abort);
    try{retirement=Promise.resolve(connection.dispose?.());}catch(error){retirement=Promise.reject(error);}
    retirement=retirement.catch(error=>{try{report(error);}catch{}});return retirement;
  };
  const abort=()=>retire();
  try{
  checkAssets();const [initial,,extra]=await Promise.all([load(initialUrl),load(sharedUrl),profile.publishingModule?load(`app://-/assets/${profile.publishingModule}`):null]);checkAssets();
  connection=connect();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){retire();signal.throwIfAborted();}
  await connection.ready;checkAssets();connection.check?.();const facade=scope(connection);
  const namespaces={response:initial,pending:initial,publishing:extra??initial};
  const roles=Object.fromEntries(Object.entries(namespaces).map(([name,namespace])=>[name,namespace[profile[name]]]));
  if(Object.values(roles).some(role=>role===undefined))throw pending('Native Working selector initialization is pending');
  for(const role of Object.values(roles))if(!role||role.scope!==connection.node.token||typeof role.read!=='function')throw Error('Native Working selector is unavailable');
  if(!facade||facade.node!==connection.node||facade.scope!==connection.node.token||typeof facade.get!=='function'||typeof facade.watch!=='function')throw Error('Native Working AppScope facade is unavailable');
  const check=()=>{checkAssets();connection.check?.();if(asset!==loadedAsset&&(asset('initial')!==initialUrl||asset('shared')!==sharedUrl)||Object.entries(roles).some(([name,role])=>namespaces[name][profile[name]]!==role))throw drift('Native Working profile changed');};
  const read=(id,get)=>{
    const key={hostId:'local',conversationId:id};
    return nativeWorkingState(get(roles.response,key),get(roles.pending,key),get(roles.publishing,key));
  };
  return{read(id){check();return read(id,facade.get.bind(facade));},watch(id,listener){check();return facade.watch(({get})=>{try{check();listener(read(id,get));}catch(error){listener(null,error);}});},dispose:retire};
  }catch(error){await retire();throw error;}
}

export function createNativeWorking({load=options=>loadNativeWorking(options),changed,report=()=>{}}={}){
  let driver,preparing,disposed=false,failure=null;
  const controller=new AbortController();
  const values=new Map(),subscriptions=new Map();
  const notify=error=>{try{report(error);}catch{}};
  const terminal=error=>typeof error?.code==='string'&&(/^(desktop_asset_|desktop_working_)/.test(error.code)||['desktop_connection_replaced','desktop_scope_missing','desktop_document_unsupported'].includes(error.code));
  const retire=error=>{
    if(disposed||failure)return;
    failure=error;const previous=driver;driver=null;
    for(const release of subscriptions.values())try{release?.();}catch(cleanup){notify(cleanup);}subscriptions.clear();
    try{Promise.resolve(previous?.dispose?.()).catch(notify);}catch(cleanup){notify(cleanup);}
    notify(error);for(const id of values.keys())set(id,null);
  };
  function set(id,value,notify=true){const normalized=typeof value==='boolean'?value:null,previous=values.get(id)??null;values.set(id,normalized);if(notify&&previous!==normalized)changed?.(id);}
  async function prepare(){
    if(disposed)return;
    if(driver||failure)return;
    if(!preparing)preparing=awaitNativeInitialization(async()=>{const value=await load({signal:controller.signal,report:notify});if(disposed){try{await value.dispose?.();}catch(cleanup){notify(cleanup);}controller.signal.throwIfAborted();}return value;},{signal:controller.signal}).then(value=>{driver=value;for(const id of values.keys()){read(id);changed?.(id);}}).catch(error=>{if(!disposed){failure=error;notify(error);}}).finally(()=>{preparing=null;});
    await preparing;
  }
  function read(id,thread){
    if(disposed)return null;
    if(!driver){values.set(id,null);return null;}
    let current=null;try{current=driver.read(id);}catch(error){if(terminal(error)){retire(error);return null;}}set(id,current,false);
    try{
      if(!subscriptions.has(id)){
        // Reserve before a Native watch's synchronous first callback.
        subscriptions.set(id,null);const release=driver.watch(id,(value,error)=>{if(terminal(error)){retire(error);return;}if(!disposed&&subscriptions.has(id))set(id,value);});
        if(disposed||failure||!subscriptions.has(id)){release?.();return null;}
        if(typeof release!=='function')throw Error('Native Working watch did not return cleanup');subscriptions.set(id,release);
      }
      return values.get(id)??null;
    }catch(error){if(terminal(error)){retire(error);return null;}subscriptions.get(id)?.();subscriptions.delete(id);values.set(id,null);return null;}
  }
  return{prepare,read,available:()=>disposed||failure?false:driver?true:null,remove(id){subscriptions.get(id)?.();subscriptions.delete(id);values.delete(id);},dispose(){disposed=true;controller.abort();for(const release of subscriptions.values())release?.();subscriptions.clear();values.clear();driver?.dispose?.();}};
}
