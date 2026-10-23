import {loadedAsset,localConnection,hostFibers} from '../host-discovery.js';
import {awaitNativeInitialization} from '../adapter/native-readiness.js';
const pending=message=>Object.assign(new Error(message),{code:'desktop_host_pending'});

function mountedWorkingScope(connection){
  const {node}=connection;
  for(const fiber of hostFibers())for(let hook=fiber.memoizedState,count=0;hook&&count++<128;hook=hook.next){
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

export async function loadNativeWorking({load=url=>import(url),connect=localConnection,scope=mountedWorkingScope,asset=loadedAsset}={}){
  const initialUrl=asset('initial'),sharedUrl=asset('shared');
  const profile=WORKING_PROFILES.find(value=>initialUrl===`app://-/assets/${value.initial}`&&sharedUrl===`app://-/assets/${value.shared}`);
  if(!profile)throw Error('Native Working profile is not reviewed');
  const [initial]=await Promise.all([load(initialUrl),load(sharedUrl)]),connection=connect(),facade=scope(connection);
  const roles={response:initial[profile.response],pending:initial[profile.pending],publishing:initial[profile.publishing]};
  if(Object.values(roles).some(role=>role===undefined))throw pending('Native Working selector initialization is pending');
  for(const role of Object.values(roles))if(!role||role.scope!==connection.node.token||typeof role.read!=='function')throw Error('Native Working selector is unavailable');
  if(!facade||facade.node!==connection.node||facade.scope!==connection.node.token||typeof facade.get!=='function'||typeof facade.watch!=='function')throw Error('Native Working AppScope facade is unavailable');
  const check=()=>{connection.check?.();if(asset('initial')!==initialUrl||asset('shared')!==sharedUrl||Object.entries(roles).some(([name,role])=>initial[profile[name]]!==role))throw Error('Native Working profile changed');};
  const read=(id,get)=>{
    const key={hostId:'local',conversationId:id};
    return nativeWorkingState(get(roles.response,key),get(roles.pending,key),get(roles.publishing,key));
  };
  return{read(id){check();return read(id,facade.get.bind(facade));},watch(id,listener){check();return facade.watch(({get})=>{try{check();listener(read(id,get));}catch{listener(null);}});}};
}

export function createNativeWorking({load=()=>loadNativeWorking(),changed}={}){
  let driver,preparing,disposed=false;
  const controller=new AbortController();
  const values=new Map(),subscriptions=new Map();
  function set(id,value,notify=true){const normalized=typeof value==='boolean'?value:null,previous=values.get(id)??null;values.set(id,normalized);if(notify&&previous!==normalized)changed?.(id);}
  async function prepare(){
    if(disposed)return;
    if(driver)return;
    if(!preparing)preparing=awaitNativeInitialization(async()=>{const value=await load();if(disposed){value.dispose?.();controller.signal.throwIfAborted();}return value;},{signal:controller.signal}).then(value=>{driver=value;}).catch(()=>{}).finally(()=>{preparing=null;});
    await preparing;
  }
  function read(id,thread){
    if(disposed||!driver)return null;
    let current=null;try{current=driver.read(id);}catch{}set(id,current,false);
    try{
      if(!subscriptions.has(id)){
        // Reserve before a Native watch's synchronous first callback.
        subscriptions.set(id,null);const release=driver.watch(id,value=>{if(!disposed&&subscriptions.has(id))set(id,value);});
        if(typeof release!=='function')throw Error('Native Working watch did not return cleanup');subscriptions.set(id,release);
      }
      return values.get(id)??null;
    }catch{subscriptions.get(id)?.();subscriptions.delete(id);values.set(id,null);return null;}
  }
  return{prepare,read,available:()=>disposed?false:driver?true:null,remove(id){subscriptions.get(id)?.();subscriptions.delete(id);values.delete(id);},dispose(){disposed=true;controller.abort();for(const release of subscriptions.values())release?.();subscriptions.clear();values.clear();driver?.dispose?.();}};
}
