import{createWorkspace}from'../../../../frontend/src/adapter/workspace.js';
import{createWorkspaceDiscovery}from'../../../../frontend/src/adapter/workspace-discovery.js';
import{deferredNavigation,locateHost}from'../../../../frontend/src/adapter/navigation.js';
import{localConnection}from'../../../../frontend/src/host-discovery.js';
import{composerBinding,findWorkspaceSurface}from'../../../../frontend/src/adapter/workspace-dom.js';
const capability={name:'workspace.seamless.audit',api:1,scope:'target'};
let workspace,navigation,discovery;
export function activate(context){
 navigation=deferredNavigation(context);discovery=createWorkspaceDiscovery(navigation.native);const metrics={roots:0,flushes:0,historyReads:0};
 const nativeTranscript=discovery.transcript;discovery.transcript=async()=>{const N=await nativeTranscript();return{...N,Client:{...N.Client,createRoot(...args){metrics.roots++;return N.Client.createRoot(...args);}},DOM:{...N.DOM,flushSync(...args){metrics.flushes++;return N.DOM.flushSync(...args);}}};};
 workspace=createWorkspace(context,{locate:locateHost,discovery,apiSymbol:'codlet.workspace.seamless.audit',capability});
 context.rpc.provide(capability,'stats',()=>{const manager=localConnection().manager;return{...metrics,binding:composerBinding(document,findWorkspaceSurface(document)?.composer),cached:manager.getCachedConversations().map(thread=>({id:thread.id,resumeState:thread.resumeState,role:manager.getStreamRole(thread.id)?.role??'none'}))};});
}
export function deactivate(){workspace?.dispose();navigation?.dispose();discovery?.dispose();workspace=navigation=discovery=null;}
