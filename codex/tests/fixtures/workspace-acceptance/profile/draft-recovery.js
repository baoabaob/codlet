import {deferredNavigation} from '../../../../frontend/src/adapter/navigation.js';
import {createWorkspaceDiscovery} from '../../../../frontend/src/adapter/workspace-discovery.js';
import {providersFor,wrapProviders} from '../../../../frontend/src/adapter/workspace-dom.js';
const symbol=Symbol.for('codlet.workspace.draft.recovery'),cap={name:'codex.ui.workspace',api:1,scope:'target'};
let audit,workspace,base,discovery,native,root,slot;
export function activate(context){audit={phase:'idle',inspect:()=>({available:true,phase:audit.phase,result:audit.result}),run};globalThis[symbol]=audit;
 async function run({threadIds=[]}={}){audit.phase='recovering';const results=[];
  try{const access=await context.rpc.request(cap,'getApi',{});workspace=globalThis[Symbol.for(access.symbol)].connect(context,access.ticket);if(workspace.getSnapshot().auxiliary){audit.result={status:'auxiliary'};return;}
   base=deferredNavigation(context);discovery=createWorkspaceDiscovery(base.native);native=await discovery.composer();const app=discovery.connection().node,threads=app.retainedScopeEntries?.get(native.ThreadScope);
   const source=workspace.getSurface().content.element,providers=providersFor(source);slot=workspace.createSlot('workspace.overlay');
   if(threadIds.length!==2||threadIds.some(id=>!/^[-\w]{8,256}$/u.test(id))||new Set(threadIds).size!==2)throw Error('Two explicit owned synthetic threadIds required');
   for(const id of threadIds){
    const node=threads?.get('local:'+id)?.node,routes=node?.retainedScopeEntries?.get(native.RouteScope),entries=[...routes??[]];
    const matching=entries.filter(([,entry])=>!entry.node.value.search);
    const result={threadId:id,threadCache:!!node,routeKeys:entries.map(([key])=>key),matches:matching.length};results.push(result);if(matching.length!==1)continue;
    const wrapper=document.createElement('div');wrapper.dataset.codletWorkspaceOwned=context.pluginId;wrapper.setAttribute('inert','');wrapper.style.cssText='position:fixed;left:-17000px;top:0;width:600px;height:400px;';slot.container.append(wrapper);
    const R=native.React,h=R.createElement;let resolve,reject;const ready=new Promise((yes,no)=>{resolve=yes;reject=no;});const observer=new MutationObserver(check);let timer;
    function check(){const editable=wrapper.querySelector('[contenteditable="true"]'),editor=editorFor(wrapper,editable);if(editor){observer.disconnect();clearTimeout(timer);resolve(editor);}}
    function Commit(){R.useLayoutEffect(check);return null;}
    observer.observe(wrapper,{childList:true,subtree:true});root=native.Client.createRoot(wrapper,{onCaughtError:reject,onUncaughtError:reject});
    root.render(wrapProviders(native,providers,h(native.Scope,{scope:native.ThreadScope,value:{clientThreadId:'local:'+id}},h(native.Scope,{scope:native.RouteScope,value:matching[0][1].node.value},h(native.Frame,{conversationId:id,hostId:'local',shouldResume:false,canInteract:true,composerSubmitDisabled:true,hideThreadContent:true,hostMcpApps:false,disableScrollToTop:true}),h(Commit)))));
    timer=setTimeout(()=>reject(Error('Cached draft editor timeout')),10000);const editor=await ready,state=editor.state,doc=state.doc;
    result.recoveredLength=doc.textContent.length;result.wasTestDraft=doc.textContent.startsWith('Codlet local draft');result.snapshot=doc.toJSON();
    if(!result.wasTestDraft){editor.dispatch(editor.state.tr.replaceWith(0,editor.state.doc.content.size,doc.content).setMeta('addToHistory',false));result.restored=true;await new Promise(resolve=>setTimeout(resolve,500));}
    native.DOM.flushSync(()=>root.unmount());root=null;wrapper.remove();
   }
   audit.result={status:'done',results};
  }catch(error){audit.result={status:'failed',message:error.message,results};}finally{root&&native.DOM.flushSync(()=>root.unmount());root=null;workspace?.dispose();discovery?.dispose();base?.dispose();audit.phase='done';}
 }
}
function editorFor(container,editable){if(!editable)return null;const key=Object.keys(container).find(k=>k.startsWith('__reactContainer$')),attached=container[key],pending=[attached?.stateNode?.current??attached],seen=new Set();while(pending.length){const fiber=pending.pop();if(!fiber||seen.has(fiber))continue;seen.add(fiber);for(const value of Object.values(fiber.memoizedProps??{}))if(value&&typeof value==='object')try{if(value.view?.dom===editable&&value.view.state?.doc)return value.view;}catch{}if(fiber.sibling)pending.push(fiber.sibling);if(fiber.child)pending.push(fiber.child);}return null;}
export function deactivate(){root&&native.DOM.flushSync(()=>root.unmount());workspace?.dispose();discovery?.dispose();base?.dispose();if(globalThis[symbol]===audit)delete globalThis[symbol];}
