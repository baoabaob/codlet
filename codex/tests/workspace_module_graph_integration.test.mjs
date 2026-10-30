import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspaceDiscovery} from '../frontend/src/adapter/workspace-discovery.js';
const root='app://-/assets/';
function fixture(t){
  const previous={document:globalThis.document,window:globalThis.window,location:globalThis.location,navigator:Object.getOwnPropertyDescriptor(globalThis,'navigator')};
  const domRoot={id:'root'},internal={containerInfo:domRoot};internal.current={stateNode:internal};domRoot.__reactContainer$test={stateNode:internal};
  const script={type:'module',src:root+'index-new.js'};
  globalThis.document={scripts:[script],getElementById:id=>id==='root'?domRoot:null,querySelectorAll:selector=>selector.startsWith('script')?[script]:[{href:root+'app-shared-new.js'},{href:root+'app-initial-new.js'}]};
  globalThis.window={__nativeRoot:{_internalRoot:internal}};
  globalThis.location={origin:'app://-',pathname:'/index.html'};
  Object.defineProperty(globalThis,'navigator',{value:{platform:'Win32'},configurable:true});
  t.after(()=>{globalThis.document=previous.document;globalThis.window=previous.window;globalThis.location=previous.location;if(previous.navigator)Object.defineProperty(globalThis,'navigator',previous.navigator);else delete globalThis.navigator;});
  function Scope(){return ['Missing parent scope','providedValue'];}
  function composerValue(){return ['routeKind','local-thread','client-local-thread','browserTabMentionConversationId'];}
  function routeDescription(path){return ['pathname','routeTemplate','local-thread','client-local-thread','routeKind','/extension/panel/new','new URLSearchParams',path];}
  function Content({conversationId,hostId,isReadOnly,trackReadState,retainActiveInterest,contentSearchOrchestrationId}){return [conversationId,hostId,isReadOnly,trackReadState,retainActiveInterest,contentSearchOrchestrationId];}
  function Frame(){return ['hideThreadContent','canInteract','shouldResume','threadAccess','hostMcpApps'];}
  function ThreadSubscription(){return ['threadKey','cancelRelease','useSyncExternalStore','hostId','threadId'];}
  function Capture({allowsBareModifiers,allowsSequences,captureAriaLabel,onStartCapture,onCapture,onCancelCapture}){return [allowsBareModifiers,allowsSequences,captureAriaLabel,onStartCapture,onCapture,onCancelCapture];}
  function eventAccelerator(event){return ['ctrlKey','metaKey','altKey','shiftKey','Command',event].join('+');}
  function Row(){return ['labelSizing','controlSizing','description','control'];}
  function useCommand(){return ['contextHandler','keyboardHandler','menuItem','useEffect'];}
  function dispatchKeyboard(a,b,c){return ['keyboard_shortcut',a,b,c];}
  function bindings(command,keymap,platform){return effective({keymapState:keymap,command,macOS:platform==='macOS',chatgpt:true}).map(accelerator=>({accelerator:accelerator,label:format(accelerator)}));}
  const token={id:Symbol()},keymap={scope:token,resolve:()=>({})},connection={node:{token,store:{get:()=>({})},cachedBindings:new Set([keymap])},chain:new Map(),manager:{getConversation(){},getStreamRole(){},loadBackgroundThreadHistoryPage(){},loadRemainingTurnItems(){},addConversationStateCallback(){}},check:()=>connection,dispose(){}};
  const namespace={
    [root+'app-shared-new.js']:{Scope,Row,composerScope:{__scopeBrand:'ComposerScope',id:Symbol()},ThreadScope:{__scopeBrand:'ThreadScope',id:Symbol()},RouteScope:{__scopeBrand:'RouteScope',id:Symbol()}},
    [root+'app-initial-new.js']:{composerValue,routeDescription,useCommand,dispatchKeyboard,bindings,keymap,commands:[{id:'newTask'},{id:'keyboardShortcuts'}]},
    [root+'app-primary-new.js']:{ThreadSubscription,Capture,eventAccelerator},
    [root+'local-conversation-thread-wrapper.js']:{},[root+'local-conversation-thread-inner.js']:{Content,Frame},[root+'keyboard-shortcuts-settings-wrapper.js']:{},
  };
  const files={
    [root+'app-shared-new.js']:'export{};',
    [root+'app-initial-new.js']:'import("./local-conversation-thread-wrapper.js");var query,state;function init(){query=queryFactory(app,"codex-command-keymap-state",{enabled:true,staleTime:minute});state=signal(app,({get})=>{let{data:value}=get(query);return value==null||get(flag)?value:{...value,primaryNumberShortcutTarget:void 0}})}export{state as keymap};',
    [root+'index-new.js']:'import("./app-main-new.js")',
    [root+'app-main-new.js']:'import{client as factory}from"./app-shared-new.js";let library=factory(),element=document.getElementById("root"),browser=window;browser.__nativeRoot??(browser.__nativeRoot=library.createRoot(element));let root=browser.__nativeRoot;preload(async()=>{let{initializeApp:run}=await import("./app-runtime-new.js");return{initializeApp:run}}).then(({initializeApp:run})=>run()).then(element=>root.render(element));',
    [root+'app-runtime-new.js']:'import"./app-primary-new.js";import"./settings-lazy-routes-new.js";',
    [root+'settings-lazy-routes-new.js']:'import("./keyboard-shortcuts-settings-wrapper.js")',
    [root+'keyboard-shortcuts-settings-wrapper.js']:'export{view as KeyboardShortcutsSettings};',
    [root+'local-conversation-thread-wrapper.js']:'import{view,init}from"./local-conversation-thread-inner.js";init();export{view as LocalConversationSideChatTab}',
    [root+'local-conversation-thread-inner.js']:Content.toString(),
    [root+'app-primary-new.js']:'export{};',
  },reads=[],loads=[];
  const options={connect:()=>connection,load:async url=>{loads.push(url);assert.ok(url in namespace,url);return namespace[url];},read:async url=>{reads.push(url);assert.ok(url in files,url);return files[url];}};
  const discovery=createWorkspaceDiscovery(async()=>({React:{},Client:{}}),options);t.after(()=>discovery.dispose());
  return{discovery,files,reads,loads,options,Content,Frame,ThreadSubscription,Capture};
}

test('transcript and shortcuts share the current root runtime proof and primary namespace',async t=>{
  const f=fixture(t),transcript=await f.discovery.transcript(),composer=await f.discovery.composer(),shortcuts=await f.discovery.shortcuts();
  assert.equal(transcript.Content,f.Content);assert.equal(transcript.ThreadSubscription,f.ThreadSubscription);assert.equal(composer.Frame,f.Frame);assert.equal(shortcuts.Capture,f.Capture);
  assert.equal(f.reads.filter(url=>url===root+'app-runtime-new.js').length,1);
  assert.equal(f.loads.filter(url=>url===root+'app-primary-new.js').length,1);
  assert.equal(f.loads.includes(root+'app-runtime-new.js'),false);
  assert.equal(f.loads.includes(root+'settings-lazy-routes-new.js'),false);
  const publicRoot=globalThis.window.__nativeRoot;globalThis.window.__nativeRoot={...publicRoot};
  assert.throws(()=>shortcuts.keymap(),{code:'desktop_asset_owner_replaced'});globalThis.window.__nativeRoot=publicRoot;
  f.discovery.dispose();assert.throws(()=>shortcuts.keymap(),{name:'AbortError'});
});

test('retirement during the runtime source read prevents late primary or settings imports',async t=>{
  const f=fixture(t);f.discovery.dispose();
  let release,started;const waiting=new Promise(resolve=>{started=resolve;});
  const options={...f.options,read:async url=>{if(url===root+'app-runtime-new.js'){started();await new Promise(resolve=>{release=resolve;});}return f.options.read(url);}};
  const discovery=createWorkspaceDiscovery(async()=>({React:{},Client:{}}),options);t.after(()=>discovery.dispose());
  const result=discovery.transcript();await waiting;discovery.dispose();release();
  await assert.rejects(result,{name:'AbortError'});
  assert.equal(f.loads.includes(root+'app-primary-new.js'),false);
  assert.equal(f.loads.includes(root+'keyboard-shortcuts-settings-wrapper.js'),false);
});

test('repeated failed preparations bind one runtime owner check and retain the original read error',async t=>{
  const f=fixture(t);f.discovery.dispose();const failure=new Error('runtime source unavailable');
  let checks=0,reads=0;
  globalThis.window=new Proxy(globalThis.window,{getOwnPropertyDescriptor(target,key){if(key==='__nativeRoot')checks++;return Reflect.getOwnPropertyDescriptor(target,key);}});
  const discovery=createWorkspaceDiscovery(async()=>({React:{},Client:{}}),{...f.options,read:async url=>{if(url===root+'app-runtime-new.js'){reads++;throw failure;}return f.options.read(url);}});t.after(()=>discovery.dispose());
  const checkCount=()=>{const before=checks;discovery.connection();return checks-before;};
  await assert.rejects(discovery.transcript(),error=>error===failure);
  const first=checkCount();assert.ok(first>0);
  for(let attempt=0;attempt<4;attempt++)await assert.rejects(discovery.transcript(),error=>error===failure);
  assert.equal(checkCount(),first);assert.equal(reads,1);assert.equal(f.loads.includes(root+'app-primary-new.js'),false);
  globalThis.window.__nativeRoot={...globalThis.window.__nativeRoot};assert.throws(()=>discovery.connection(),{code:'desktop_asset_owner_replaced'});
});
