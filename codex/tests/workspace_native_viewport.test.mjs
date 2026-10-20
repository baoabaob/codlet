import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from '../frontend/node_modules/esbuild/lib/main.js';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createNativeViewportDriver, viewportSignalExports, viewportPersistenceExport, nativeViewportLayout } from '../frontend/src/adapter/workspace-native-viewport.js';
const require=createRequire(new URL('../frontend/package.json',import.meta.url)),{JSDOM}=require('jsdom');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

const graph='import{writer as persist}from"./app-shared-build.js";function viewport(scope,open,options={}){if(!open&&options.closeReason!=="window-resize"&&scope.get(full)){scope.set(expanded,false);scope.set(full,false);return;}scope.set(opened,open);let motionValue=scope.get(motion);motionValue.stop();options.animate===false?motionValue.set(+!!open):animate(motionValue,open);if(!open){scope.set(expanded,false);scope.set(full,false);}}function resize({mainContentWidth:container,storageKey:key,width:size,widthMode:mode}){persist(key,ratio(size,container,mode));}export{viewport as action,expanded as expandedFlag,full as fullFlag,opened as openFlag,motion as motionFlag};';
test('Native viewport source decoding derives semantic exports without executing or assuming minified names',()=>{
  assert.deepEqual(viewportSignalExports(graph),{setOpen:'action',expanded:'expandedFlag',fullWidth:'fullFlag',open:'openFlag',motion:'motionFlag'});
  assert.equal(viewportPersistenceExport(graph),'writer');
  assert.equal(viewportSignalExports(graph.replace('motion as motionFlag','motion as one,motion as two')).motion,'one');
  assert.equal(viewportPersistenceExport(graph.replace('app-shared-build.js','other-module.js')),'writer');
});

test('Native layout discovery reaches a closed pane inside main while pruning the main body and viewer branches',t=>{
  const dom=new JSDOM('<div id="root"><main data-app-shell-main-surface><div><section data-app-shell-main-content-layout></section></div></main></div>');t.after(()=>dom.window.close());
  const document=dom.window.document,root=document.getElementById('root'),main=document.querySelector('main');
  function Shell(){return 'data-app-shell-main-surface contentPaneWidthRatio';}
  function Pane(){return 'pane_resize contentPaneWidthRatio data-app-shell-focus-area';}
  const current={},shell={type:Shell,return:current},host={stateNode:main,return:shell},row={stateNode:main.firstElementChild,return:host},body={stateNode:document.querySelector('section'),return:row};
  const motion={get:()=>360,on(){assert.fail('discovery must not subscribe');}},props={isContentPaneOpen:false,contentPaneWidth:motion,contentPaneWidthRatio:motion,workspaceWidth:motion};
  const pane={type:Pane,memoizedProps:props,return:row};
  current.child=shell;shell.child=host;host.child=row;row.child=body;body.sibling=pane;
  Object.defineProperty(body,'child',{get(){assert.fail('must not scan conversation contents');}});Object.defineProperty(pane,'child',{get(){assert.fail('must not scan viewer contents');}});
  root.__reactContainer$layout={stateNode:{current}};main.__reactFiber$layout=host;
  assert.equal(nativeViewportLayout({root,main}),props);
  const duplicate={...pane,return:row};pane.sibling=duplicate;
  assert.throws(()=>nativeViewportLayout({root,main}),{code:'workspace_host_pending'},'ambiguous matching layouts cannot be guessed');
});

function fixture(t){
  const dom=new JSDOM('<div id="root"><main data-app-shell-main-surface></main><aside data-app-shell-focus-area="right-panel"><span>Retained Native resource</span></aside></div>');t.after(()=>dom.window.close());
  const document=dom.window.document,ThreadScope={id:Symbol('thread')},RouteScope={id:Symbol('route')};
  const signal=scope=>({scope,cache:'signal',resolve(){}}),signals={open:signal(ThreadScope),fullWidth:signal(ThreadScope),expanded:signal(ThreadScope),motion:signal(ThreadScope)},widthSignal=signal(RouteScope),atomWrites=[];
  function context(id,open,width,fullWidth=false){
    const values=new Map([[signals.open,open],[signals.fullWidth,fullWidth],[signals.expanded,false],[signals.motion,{}],[widthSignal,{defaultWidth:width,storageKey:'native:'+id}]]),watchers=new Set(),motions=new Set();
    const routeNode={token:RouteScope,signalBindings:new WeakMap([[widthSignal,{}]])},threadNode={token:ThreadScope,signalBindings:new WeakMap(Object.values(signals).map(value=>[value,{}]))};
    const chain=new Map([[ThreadScope.id,threadNode],[RouteScope.id,routeNode]]),facade={chain,get:value=>values.get(value),set(value,next){values.set(value,next);for(const watcher of watchers)watcher({get:facade.get});},watch(listener){watchers.add(listener);listener({get:facade.get});return()=>watchers.delete(listener);}};
    return{root:document.getElementById('root'),main:document.querySelector('main'),threadId:id,routeNode,threadNode,facade,values,watchers,motions,
      layout:{widthMode:'regular',contentPaneWidth:{get:()=>values.get(widthSignal).defaultWidth,on(event,listener){assert.equal(event,'change');motions.add(listener);return()=>motions.delete(listener);}},contentPaneWidthRatio:{get:()=>0.3},workspaceWidth:{get:()=>1200}},
      resize(value){for(const listener of motions)listener(value);}};
  }
  const a=context('thread-a',true,600,true),b=context('thread-b',false,720);let current=a;
  signals.setOpen=(facade,open,options)=>{assert.equal(options.closeReason,'window-resize');facade.set(signals.open,open);if(!open){facade.set(signals.fullWidth,false);facade.set(signals.expanded,false);}};
  const driver=createNativeViewportDriver({document,native:{ThreadScope,RouteScope,DOM:{flushSync:callback=>callback()},writeAtom(key,value){atomWrites.push({key,value});}},signals,
    readContext:()=>current,readLayout:value=>value.layout,learnWidth:()=>widthSignal});
  return{document,driver,a,b,signals,widthSignal,atomWrites,setCurrent(value){current=value;}};
}

test('Native viewport preserves resource DOM, isolates width persistence and restores each visited context independently',async t=>{
  const f=fixture(t),resource=f.document.querySelector('aside span'),view=await f.driver.create({open:true,width:360});await view.ready;
  const seen=[];view.subscribe(value=>seen.push(value));await view.bind({threadId:'thread-a'});
  assert.equal(f.document.querySelector('aside span'),resource);assert.equal(f.document.querySelector('aside').hasAttribute('inert'),false);
  f.a.resize(520);assert.equal(seen.at(-1).width,520);f.a.facade.set(f.signals.open,false);assert.equal(seen.at(-1).open,false);
  f.setCurrent(f.b);await view.bind({threadId:'thread-b'});
  assert.equal(f.a.values.get(f.widthSignal).storageKey,'native:thread-a');assert.equal(f.a.values.get(f.widthSignal).defaultWidth,600);assert.equal(f.a.values.get(f.signals.fullWidth),true);assert.equal(f.a.values.get(f.signals.open),true);
  await view.update({open:true,width:440});assert.equal(f.b.values.get(f.widthSignal).defaultWidth,440);
  await view.bind(null);assert.equal(f.document.querySelector('aside').style.visibility,'hidden');assert.equal(seen.at(-1).width,440);assert.equal(seen.at(-1).open,true);
  await view.close();await view.close();assert.equal(f.b.values.get(f.widthSignal).storageKey,'native:thread-b');assert.equal(f.b.values.get(f.widthSignal).defaultWidth,720);assert.equal(f.b.values.get(f.signals.open),false);
  assert.equal(f.document.querySelector('aside span'),resource);assert.equal(f.document.querySelector('aside').style.visibility,'');
  assert.ok(f.atomWrites.every(value=>value.key.startsWith('codlet.workspace.viewport.')));assert.equal(f.a.watchers.size+f.b.watchers.size+f.a.motions.size+f.b.motions.size,0);
});

test('Native viewer changes retain their own pane configuration after the owned width override closes',async t=>{
  const f=fixture(t),view=await f.driver.create({open:true,width:360});await view.ready;await view.bind({threadId:'thread-a'});
  const next={defaultWidth:810,storageKey:'native:viewer-specific'};f.a.facade.set(f.widthSignal,next);await tick();
  assert.ok(f.a.facade.get(f.widthSignal).storageKey.startsWith('codlet.workspace.viewport.'));
  await view.close();assert.equal(f.a.facade.get(f.widthSignal),next);assert.equal(f.a.watchers.size+f.a.motions.size,0);
});

test('null binding during navigation never adopts an unconfirmed shell or runs a queued old-context override',async t=>{
  const f=fixture(t),errors=[];let confirmed='thread-a';
  const view=await f.driver.create({open:true,width:520},{onError:error=>errors.push(error),isCurrentContext:id=>id===confirmed});await view.ready;await view.bind({threadId:'thread-a'});
  f.a.facade.set(f.widthSignal,{defaultWidth:810,storageKey:'native:new-viewer'});
  confirmed=null;f.setCurrent(f.b);f.a.layout.widthMode='full';
  const before=f.b.facade.get(f.widthSignal);await view.bind(null);await tick();
  assert.equal(f.b.facade.get(f.widthSignal),before,'null selection cannot lease a target before confirmation');assert.deepEqual(errors,[]);
  confirmed='thread-b';await view.bind({threadId:'thread-b'});assert.equal(f.b.facade.get(f.widthSignal).defaultWidth,520);assert.equal(f.a.facade.get(f.widthSignal).storageKey,'native:new-viewer');
  await view.close();assert.equal(f.b.facade.get(f.widthSignal),before);assert.equal(f.a.watchers.size+f.b.watchers.size+f.a.motions.size+f.b.motions.size,0);
});

test('a failed binding retains the primary error even if restoration also fails',async t=>{
  const f=fixture(t),reported=[],view=await f.driver.create({open:true,width:520},{onError:error=>reported.push(error)});await view.ready;
  f.setCurrent(f.b);f.b.layout.widthMode='full';f.a.routeNode.signalBindings.delete(f.widthSignal);
  await assert.rejects(view.bind({threadId:'thread-b'}),error=>error.code==='workspace_viewport_state_evicted'&&error.cause?.code==='workspace_viewport_state_evicted'&&error.errors?.length===2);
  assert.equal(reported[0].code,'workspace_viewport_state_evicted');assert.ok(reported[0].message.includes('binding failed'));
  await assert.rejects(view.bind({threadId:'thread-b'}),error=>error===reported[0],'subsequent calls expose the first failure, not a generic retired error');
});

test('Native selection changed during readiness fails before mutating another thread and retires notifications',async t=>{
  const f=fixture(t),allocating=f.driver.create({open:true,width:360});f.setCurrent(f.b);const view=await allocating;
  await assert.rejects(view.ready,{code:'workspace_viewport_superseded'});await view.close();
  assert.equal(f.a.values.get(f.widthSignal).storageKey,'native:thread-a');assert.equal(f.b.values.get(f.widthSignal).storageKey,'native:thread-b');
  assert.equal(f.a.watchers.size+f.b.watchers.size,0);
});

test('Native viewport refuses an unbound or foreign signal before an owned state write',async t=>{
  const f=fixture(t);f.a.routeNode.signalBindings.delete(f.widthSignal);const view=await f.driver.create({open:true,width:360});
  await assert.rejects(view.ready,{code:'workspace_host_pending'});await view.close();assert.equal(f.a.values.get(f.widthSignal).storageKey,'native:thread-a');
});

test('evicted Native viewport state reports failed restoration while still removing listeners and the owned width key',async t=>{
  const f=fixture(t),view=await f.driver.create({open:true,width:360});await view.ready;
  f.a.routeNode.signalBindings.delete(f.widthSignal);
  await assert.rejects(view.close(),{code:'workspace_viewport_cleanup_failed'});
  assert.equal(f.a.watchers.size+f.a.motions.size,0);assert.equal(f.atomWrites.at(-1).value,undefined);
  await assert.rejects(view.close(),{code:'workspace_viewport_cleanup_failed'},'failed cleanup cannot become an idempotent success');
});

test('a Native layout drift during deferred configuration releases the owned lease and reports the failure',async t=>{
  const f=fixture(t),errors=[],view=await f.driver.create({open:true,width:360},{onError:error=>errors.push(error)});await view.ready;
  f.a.layout.widthMode='full';f.a.facade.set(f.widthSignal,{defaultWidth:900,storageKey:'native:new-viewer'});await tick();await view.close();
  assert.equal(errors[0].code,'workspace_viewport_unsupported');assert.equal(f.a.facade.get(f.widthSignal).storageKey,'native:new-viewer');assert.equal(f.a.watchers.size+f.a.motions.size,0);
  await assert.rejects(view.update({open:false,width:400}),error=>error.code==='workspace_viewport_unsupported'&&error.message.includes('notification failed'),'retirement retains its original cause');
});

const driverBundle=(await build({entryPoints:[fileURLToPath(new URL('../frontend/src/adapter/workspace-native-viewport.js',import.meta.url))],bundle:true,write:false,format:'iife',globalName:'Viewport',platform:'browser'})).outputFiles[0].text;
const nativeBundle=(await build({absWorkingDir:fileURLToPath(new URL('../frontend',import.meta.url)),stdin:{contents:readFileSync(new URL('./support/native-shell.js',import.meta.url),'utf8'),resolveDir:fileURLToPath(new URL('../frontend',import.meta.url))},bundle:true,write:false,format:'iife',globalName:'NativeShell',platform:'browser',define:{'process.env.NODE_ENV':'"production"'}})).outputFiles[0].text;
test('width discovery mounts only the Native registration in an owned temporary scope and releases its root',t=>{
  const dom=new JSDOM('<div id="root"><main data-app-shell-main-surface></main></div>',{runScripts:'outside-only'});t.after(()=>dom.window.close());
  const window=dom.window,document=window.document;window.eval(driverBundle);const N=window.eval(nativeBundle+';NativeShell;'),R=N.React,h=R.createElement,ThreadScope={id:Symbol('thread')},RouteScope={id:Symbol('route')},originalThread={clientThreadId:'original'},originalRoute={pathname:'/local/original'},ScopeContext=R.createContext(new Map([[ThreadScope,originalThread],[RouteScope,originalRoute]]));
  const signal={scope:RouteScope,cache:'signal',resolve(){}},registrations=[];let roots=0,unmounted=0;
  function Registration({signal,value}){const chain=R.useContext(ScopeContext);R.useLayoutEffect(()=>{registrations.push({signal,value,thread:chain.get(ThreadScope),route:chain.get(RouteScope)});return()=>unmounted++;},[]);return null;}
  const native={...N,ThreadScope,RouteScope,Scope:({scope,value,children})=>{const parent=R.useContext(ScopeContext);return h(ScopeContext,{value:new Map([...parent,[scope,value]])},children);},routeDescription:value=>value,Shell:{RightPanelOutlet:({paneWidth})=>h(Registration,{signal,value:paneWidth})},Client:{createRoot(...args){roots++;return N.Client.createRoot(...args);}}};
  const main=document.querySelector('main');main.__reactFiber$fixture={dependencies:{firstContext:{context:ScopeContext,memoizedValue:new Map([[ThreadScope,originalThread],[RouteScope,originalRoute]])}}};
  assert.equal(window.Viewport.learnNativeViewportWidth(document,native,{main}),signal);assert.equal(roots,1);assert.equal(unmounted,1);assert.equal(registrations.length,1);
  assert.notEqual(registrations[0].thread,originalThread);assert.notEqual(registrations[0].route,originalRoute);assert.equal(originalThread.clientThreadId,'original');
  assert.equal(document.querySelector('[data-codlet-workspace-owned]'),null);assert.equal(document.querySelector('[contenteditable]'),null);
});

test('captured viewport facades keep their existing route nodes when the Native hook rebinds and reuse one pin per context',t=>{
  const dom=new JSDOM('<div id="root"></div>',{runScripts:'outside-only'});t.after(()=>dom.window.close());const window=dom.window,document=window.document;
  window.eval(driverBundle);const N=window.eval(nativeBundle+';NativeShell;'),R=N.React,h=R.createElement,ThreadScope={id:Symbol('thread')},RouteScope={id:Symbol('route')};
  const thread={token:ThreadScope},a={token:RouteScope,writes:[]},b={token:RouteScope,writes:[]},signal={scope:RouteScope};
  const chainA=new Map([[ThreadScope.id,thread],[RouteScope.id,a]]),chainB=new Map([[ThreadScope.id,thread],[RouteScope.id,b]]),Context=R.createContext(null);let userFacade,created=0;
  const native={...N,ThreadScope,RouteScope,Client:{createRoot(...args){created++;return N.Client.createRoot(...args);}},useScope(scope){const chain=R.useContext(Context),node=chain.get(scope.id),ref=R.useRef(null);
    if(!ref.current||ref.current.node!==node){const facade={chain,node,scope,get(){},set(key,value){facade.chain.get(key.scope.id).writes.push(value);},watch(){return()=>{};}};ref.current=facade;}else ref.current.chain=chain;return ref.current;}};
  const Frame=()=>{userFacade=native.useScope(ThreadScope);return h('main',{'data-app-shell-main-surface':''});};const root=native.Client.createRoot(document.getElementById('root')),pins=new WeakMap();t.after(()=>N.DOM.flushSync(()=>root.unmount()));
  N.DOM.flushSync(()=>root.render(h(Context,{value:chainA},h(Frame))));
  const first=window.Viewport.nativeViewportContext(document,native,pins);assert.equal(first.facade.node,a);assert.notEqual(first.facade,userFacade);
  N.DOM.flushSync(()=>root.render(h(Context,{value:chainB},h(Frame))));assert.equal(userFacade.chain.get(RouteScope.id),b);
  first.facade.set(signal,600);assert.deepEqual(a.writes,[600]);assert.deepEqual(b.writes,[]);
  const second=window.Viewport.nativeViewportContext(document,native,pins);assert.equal(second.facade.node,b);assert.equal(window.Viewport.nativeViewportContext(document,native,pins).facade,second.facade);
  assert.equal(created,3,'main root plus one temporary hook-capture root per route');assert.equal(document.querySelector('[data-codlet-workspace-owned]'),null);
});
