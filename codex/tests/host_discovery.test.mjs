import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { reactFactories } from '../frontend/src/adapter/react-factories.js';
import { createWorkspaceDiscovery } from '../frontend/src/adapter/workspace-discovery.js';
const desktop = readFileSync(new URL('../bundled/codex-desktop-adapter/renderer.js', import.meta.url), 'utf8');
function fixture() {
  const context = vm.createContext({ module:{exports:{}},setTimeout,clearTimeout,AbortController,crypto:{randomUUID},location:{origin:'app://-',pathname:'/index.html'} });
  vm.runInContext(desktop,context);
  const native = vm.runInContext(`(()=>{
    const token={id:Symbol()},client={requestPromises:new Map(),sendRequest(){},setAppServerVersion(){},getAppServerVersion:()=> 'future-protocol',onError(){}};
    const manager={requestClient:client,getHostId:()=> 'local'};
    for(const name of ['sendRequest','getConversation','getStreamRole','addNotificationCallback','addConversationStateCallback','replyWithCommandExecutionApprovalDecision','replyWithFileChangeApprovalDecision','replyWithPermissionsRequestApprovalResponse','replyWithUserInputResponse'])manager[name]=()=>{};
    const managerFamily={scope:token,read:()=>manager},clientFamily={scope:token,read:()=>client};
    const node={token,store:{},familyBindings:new Map([[managerFamily,new Map([['local',manager]])],[clientFamily,new Map([['local',client]])]])};
    const chain=new Map([[token.id,node]]),root={__reactContainer$fixture:{memoizedProps:{value:chain}}};
    const urls=[{href:'app://-/assets/app-shared-renamed-123.js'}];
    document={readyState:'complete',scripts:[{src:'app://-/assets/index-future.js'}],querySelectorAll:()=>urls,getElementById:()=>root};
    electronBridge={getSentryInitOptions:()=>({appVersion:'unlisted-version',buildNumber:'future'}),sendMessageFromView(){throw Error('must reuse native transport')}};
    const postbox={postMessage(){},getState(){},setState(){}};
    return {token,client,manager,managerFamily,clientFamily,node,chain,root,urls,postbox};
  })()`,context);
  const imports=[];
  const module={arbitraryRenamedExport:native.postbox};
  return {context,native,module,imports,probe:()=>vm.runInContext('probeDesktop',context)(async url=>{imports.push(url);return module;},0)};
}
function largeShell() {
  const f = fixture(); f.context.fixtureNative = f.native;
  f.shell = vm.runInContext(`(() => {
    const f=fixtureNative,rootFiber={memoizedProps:{},child:null},container={stateNode:{current:rootFiber}};
    f.root.__reactContainer$fixture=container;
    const scope={memoizedProps:{value:f.chain},return:rootFiber},router={memoizedProps:{},return:scope},shell={return:router};
    rootFiber.child=scope;scope.child=router;router.child=shell;
    const navigator={location:{pathname:'/local/long-task'},push(to){this.location={pathname:to};},replace(to){this.location={pathname:to};},go(){},listen(){return()=>{};}};
    router.memoizedProps.value={navigator};
    const rail={__reactFiber$fixture:null},navFiber={stateNode:rail,return:shell};rail.__reactFiber$fixture=navFiber;shell.child=navFiber;
    let tail=navFiber,total=5;
    for(let pane=0;pane<3;pane++){
      const content={return:shell};tail.sibling=content;tail=content;total++;
      let previous;
      for(let item=0;item<24000;item++){
        const fiber={return:content};if(previous)previous.sibling=fiber;else content.child=fiber;previous=fiber;total++;
      }
    }
    const rails=[rail];let queries=0;
    f.root.querySelectorAll=selector=>{queries++;return selector==='nav[data-app-navigation-rail="true"]'?rails:[];};
    return {rootFiber,container,scope,router,shell,rail,navFiber,rails,navigator,total,queries:()=>queries,resetQueries:()=>{queries=0;}};
  })()`, f.context);
  return f;
}
test('long conversations and three native panes use bounded shell discovery for Desktop and Workspace',async()=>{
  const f=largeShell();assert.equal(f.shell.total,72008);
  assert.equal(vm.runInContext('hostFibers().size',f.context),5);
  const connection=await f.probe();assert.equal(connection.manager,f.native.manager);
  assert.equal(vm.runInContext('locateNavigator()',f.context),f.shell.navigator);
  f.context.auditConnection=connection;
  const endpoints=new Map(),callbacks=[];
  f.native.manager.addNotificationCallback=()=>()=>{};
  f.native.manager.addConversationStateCallback=callback=>{callbacks.push(callback);return()=>{};};
  f.native.manager.getCachedConversations=()=>[];
  const context={rpc:{provide:(cap,method,handler)=>endpoints.set(cap.name+':'+method,handler),unavailable(){}},reportDiagnostic(){},onDeactivate:()=>()=>{}};
  const adapter=vm.runInContext('createAdapter',f.context)(connection,context);
  assert.equal(adapter.probe().available,true);assert.equal(adapter.probe().navigation.available,true);
  const eventAccess=endpoints.get('codex.backend.events:getApi')({}, {caller:{pluginId:'consumer',generation:1}});
  const observed=[],owner={world:'main',pluginId:'consumer',generation:1,onDeactivate:()=>()=>{}};
  f.context.auditOwner=owner;f.context.auditTicket=eventAccess.ticket;f.context.auditListener=event=>observed.push(event);
  const unsubscribe=vm.runInContext('globalThis[Symbol.for("codlet.codex.desktop.v1")].onEvent(auditOwner,auditTicket,auditListener)',f.context);
  const discovery=createWorkspaceDiscovery(()=>null,{connect:()=>vm.runInContext('localConnection()',f.context)});
  assert.equal(discovery.connection().manager,f.native.manager);
  f.shell.resetQueries();
  // Metadata inspection and native events use the captured owner; an unrelated
  // candidate added later must not be reread or instantiate another service.
  f.context.auditNode=f.native.node;
  vm.runInContext('auditNode.familyBindings.set({scope:auditNode.token,read(){throw Error("unexpected rediscovery")}},new Map([["local",{}]]));',f.context);
  for(let i=0;i<100;i++){connection.check();assert.equal(discovery.connection().manager,f.native.manager);}
  assert.equal(f.shell.queries(),0,'steady connection validation does not rescan the shell or messages');
  assert.equal((await endpoints.get('codex.backend.read:threads.loaded')({},{})).threads.length,0);
  callbacks[0]('long-task');assert.equal(adapter.probe().available,true);
  assert.equal((await endpoints.get('codex.backend.events:read')({waitMs:0},{})).gap,false);
  unsubscribe();discovery.dispose();assert.equal(observed.length,0);adapter.dispose();
});
test('captured scope follows committed alternates and reused children, and rejects detached or replaced owners',async()=>{
  for(const reused of [false,true]){
    const f=largeShell(),connection=await f.probe(),original=f.shell.scope;
    f.context.auditShell=f.shell;
    const next=vm.runInContext(`(()=>{
      const s=auditShell,f=fixtureNative,root={memoizedProps:{},stateNode:s.rootFiber.stateNode};
      root.alternate=s.rootFiber;s.rootFiber.alternate=root;
      let scope;
      if(${reused})scope=s.scope;
      else {scope={memoizedProps:{value:new Map(f.chain)},child:s.router,return:root,alternate:s.scope};s.scope.alternate=scope;}
      root.child=scope;s.container.stateNode.current=root;
      return {root,scope};
    })()`,f.context);
    assert.equal(vm.runInContext('hostFibers().size',f.context),5,'discovery follows shared children through the current alternate parent');
    connection.check();
    // Sidebar/route content retirement must not retire the outer AppScope.
    next.scope.child=null;connection.check();
    next.root.child=null;assert.throws(()=>connection.check(),{code:'desktop_scope_missing'});
    next.root.child=next.scope;
    if(!reused)next.scope.memoizedProps.value.set(f.native.token.id,{...f.native.node});
    else original.memoizedProps.value.set(f.native.token.id,{...f.native.node});
    assert.throws(()=>connection.check(),{code:'desktop_connection_replaced'});
  }
});
test('a stale DOM attachment that returns to the current root cannot override its actually mounted alternate',async()=>{
  const f=largeShell();f.context.auditShell=f.shell;
  vm.runInContext(`const staleParent={return:auditShell.rootFiber,child:null};auditShell.rail.__reactFiber$fixture={stateNode:auditShell.rail,return:staleParent,alternate:auditShell.navFiber};`,f.context);
  assert.equal(vm.runInContext('hostFibers().size',f.context),5);
  const connection=await f.probe();assert.equal(connection.manager,f.native.manager);connection.check();
});
test('unknown large trees, duplicate native landmarks and detached shell ancestry remain fail closed',async()=>{
  const unknown=largeShell();unknown.shell.rails.length=0;
  await assert.rejects(unknown.probe(),{code:'desktop_host_drift'});assert.equal(unknown.imports.length,0);
  const duplicate=largeShell();duplicate.shell.rails.push({});
  await assert.rejects(duplicate.probe(),{code:'desktop_host_drift'});assert.equal(duplicate.imports.length,0);
  const detached=largeShell();detached.shell.navFiber.return=null;
  await assert.rejects(detached.probe(),{code:'desktop_host_pending'});assert.equal(detached.imports.length,0);
});
test('unlisted build, renamed exports and backend version pass actual contracts without a profile',async()=>{
  const f=fixture(),connection=await f.probe();
  assert.equal(connection.manager,f.native.manager);assert.equal(connection.client,f.native.client);assert.equal(connection.postbox,f.native.postbox);
  assert.equal(connection.build.appVersion,'unlisted-version');assert.equal(connection.build.appServerVersion,'future-protocol');
  assert.equal(connection.build.compatibility,'structural');connection.check();
  assert.deepEqual(f.imports,['app://-/assets/app-shared-renamed-123.js']);
  f.native.clientFamily.read=()=>({});assert.throws(()=>connection.check());
});
test('partial, remote, unbound and ambiguous connections cannot acquire a transport',async()=>{
  for(const mutate of [f=>{f.native.node.familyBindings.get(f.native.clientFamily).clear();},f=>{f.native.manager.getHostId=()=> 'remote';},f=>{f.native.clientFamily.scope={};}]){
    const f=fixture();mutate(f);await assert.rejects(f.probe(),{code:'desktop_connection_not_ready'});assert.equal(f.imports.length,0);
  }
  const f=fixture();f.native.urls.push({href:'app://-/assets/app-shared-second.js'});
  await assert.rejects(f.probe(),{code:'desktop_asset_ambiguous'});assert.equal(f.imports.length,0);
});
test('cached task families do not consume local service reads; eligible reads remain bounded',async()=>{
  const f=fixture();f.context.fixtureNative=f.native;
  vm.runInContext(`for(let i=0;i<3000;i++)fixtureNative.node.familyBindings.set({scope:fixtureNative.token,read(){throw Error('must not read task bindings')}},new Map([['task-'+i,{}]]));`,f.context);
  const connection=await f.probe();assert.equal(connection.manager,f.native.manager);connection.check();
  const saturated=fixture();saturated.context.fixtureNative=saturated.native;
  vm.runInContext(`for(let i=0;i<600;i++)fixtureNative.node.familyBindings.set({scope:fixtureNative.token,read:()=>({})},new Map([['local',{}]]));`,saturated.context);
  await assert.rejects(saturated.probe(),{code:'desktop_scope_drift'});assert.equal(saturated.imports.length,0);
});
test('missing manager methods and ambiguous or immutable transports do not install an interceptor',async()=>{
  for(const mutate of [f=>{f.native.manager.sendRequest=undefined;},f=>{f.module.decoy={...f.native.postbox};},f=>{Object.defineProperty(f.native.postbox,'postMessage',{writable:false});}]){
    const f=fixture(),original=f.native.postbox.postMessage;mutate(f);await assert.rejects(f.probe());assert.equal(f.native.postbox.postMessage,original);
  }
});
const factorySource = suffix => `
const react${suffix}=cjs(e=>{e.createElement=()=>{};e.useState=()=>{};e.useEffect=()=>{};e.Fragment=Symbol();e.version='x';});
const wrap${suffix}=cjs((e,m)=>{m.exports=react${suffix}()});
const dom${suffix}=cjs(e=>{e.createPortal=()=>{};e.flushSync=()=>{};e.version='x'});
const client${suffix}=cjs(e=>{e.createRoot=()=>{throw Error('must never execute during discovery')}});
export{wrap${suffix} as r${suffix},dom${suffix} as d${suffix},client${suffix} as c${suffix}};`;
test('React resolution follows parsed export relationships across arbitrary renaming without execution',()=>{
  for(const suffix of ['a','future_123'])assert.deepEqual(reactFactories(factorySource(suffix)),{react:'r'+suffix,dom:'d'+suffix,client:'c'+suffix});
});
test('React resolution rejects missing, duplicate and misleading factory contracts',()=>{
  assert.throws(()=>reactFactories(factorySource('a').replace('e.useState=()=>{};','')),{code:'ui_react_drift'});
  assert.throws(()=>reactFactories(factorySource('a')+factorySource('b')),{code:'ui_react_drift'});
  assert.throws(()=>reactFactories('const text='+JSON.stringify(factorySource('a'))+';'),{code:'ui_react_drift'});
  assert.throws(()=>reactFactories(' '.repeat(16*1024*1024+1)),{code:'ui_react_drift'});
});
