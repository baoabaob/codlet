import {deferredNavigation,locateHost} from '../../../../frontend/src/adapter/navigation.js';
import {localConnection} from '../../../../frontend/src/host-discovery.js';
import {createThreadOpener} from '../../../../frontend/src/desktop/thread-navigation.js';
const capability={name:'workspace.audit.navigation',api:1,scope:'target'};
let navigation,original,visited=new Set();
export function activate(context){
  const host=locateHost();if(host.auxiliary)return;
  navigation=deferredNavigation(context);
  const prepared=navigation.ready.then(()=>{
    const connection=localConnection(),manager=connection.manager,router=locateHost().navigator;original={...router.location};
    let metadataReads=0;
    function selection(){connection.check();if(locateHost().navigator!==router)throw Error('Native navigation ownership changed');const threadId=/^\/local\/([\w-]+)$/.exec(router.location.pathname)?.[1]??null,thread=manager.getConversation(threadId);return{threadId,activeTurnId:null,activeTurnKnown:true,resumeState:thread?.resumeState==='resumed'?'resumed':'loading',streamRole:manager.getStreamRole(threadId)?.role??'none'};}
    const opener=createThreadOpener({manager,selection,navigation:()=>({stamp:()=>JSON.stringify(router.location),open:threadId=>{visited.add(threadId);router.push('/local/'+threadId);}}),request:async(method,params)=>{metadataReads++;return manager.sendRequest(method,params);}});
    return{manager,selection,opener,metadataReads:()=>metadataReads};
  });prepared.catch(()=>{});
  context.rpc.provide(capability,'describe',async()=>{const value=await prepared,current=value.selection();return{original:current.threadId,warm:value.manager.getCachedConversations().filter(thread=>thread.id!==current.threadId&&thread.resumeState==='resumed'&&value.manager.getStreamRole(thread.id)?.role==='owner'&&thread.threadRuntimeStatus?.type!=='active').slice(0,2).map(thread=>thread.id)};});
  context.rpc.provide(capability,'open',async(args,invocation)=>{const value=await prepared,start=performance.now(),before=value.metadataReads(),receipt=await value.opener(args,invocation.signal);return{...receipt,providerMs:performance.now()-start,metadataReads:value.metadataReads()-before};});
}
export function deactivate(){try{const host=locateHost(),current=/^\/local\/([\w-]+)$/.exec(host.navigator.location.pathname)?.[1];if(original&&visited.has(current)&&host.navigator.location.pathname!==original.pathname)host.navigator.replace(original,original.state);}catch{}navigation?.dispose();navigation=null;original=null;visited.clear();}
