import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from '../frontend/node_modules/esbuild/lib/main.js';
import { createLoadedThreads } from '../frontend/src/desktop/loaded-threads.js';
import { keymapExport, assetReferences } from '../frontend/src/adapter/workspace-discovery.js';
import { componentSource } from '../frontend/src/host-discovery.js';
import { createTranscriptIsolation } from '../frontend/src/adapter/workspace-shadow.js';
const require = createRequire(new URL('../frontend/package.json', import.meta.url)), { JSDOM } = require('jsdom');
const source = (await build({ entryPoints: [new URL('../frontend/src/adapter/workspace.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')], bundle: true, write: false, format: 'iife', globalName: 'Workspace', platform: 'browser' })).outputFiles[0].text;
const domSource = (await build({ entryPoints: [new URL('../frontend/src/adapter/workspace-dom.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')], bundle: true, write: false, format: 'iife', globalName: 'WorkspaceDom', platform: 'browser' })).outputFiles[0].text;
const nativeSource = (await build({ absWorkingDir: fileURLToPath(new URL('../frontend', import.meta.url)), stdin: { contents: readFileSync(new URL('./support/native-shell.js', import.meta.url), 'utf8'), resolveDir: fileURLToPath(new URL('../frontend', import.meta.url)) }, bundle: true, write: false, format: 'iife', globalName: 'NativeShell', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } })).outputFiles[0].text;
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture(t,options={}) {
  const dom = new JSDOM('<!doctype html><body><div id="root"><nav><button id="activity"></button><span data-thread-title id="thread"></span></nav><div data-app-shell-main-titlebar></div><main data-app-shell-main-surface><div data-includes-composer><div class="thread-scroll-container"><section id="body">body</section><footer data-thread-scroll-footer><div data-codex-composer-root></div></footer></div></div></main><aside data-app-shell-focus-area="right-panel"></aside></div></body>', { url: 'app://-/index.html', runScripts: 'outside-only' });
  const { window } = dom, { document } = window; window.eval(source); window.eval(domSource);
  const current = {};
  document.getElementById('root').__reactContainer$fixture = { stateNode: { current } };
  function attach(node, props, parent = current, name = 'fixture') {
    const previousKey = Object.keys(node).find(key => key.startsWith('__reactFiber$')), previous = previousKey && node[previousKey];
    const parents = new Set();
    for (let value = parent; value && !parents.has(value); value = value.return) parents.add(value);
    if (previous?.return && !parents.has(previous)) {
      if (previous.return.child === previous) previous.return.child = previous.sibling;
      else for (let sibling = previous.return.child; sibling; sibling = sibling.sibling) if (sibling.sibling === previous) { sibling.sibling = previous.sibling; break; }
    }
    if (previousKey) delete node[previousKey];
    const fiber = { ...props, stateNode: node, return: parent, sibling: parent.child };
    parent.child = fiber; node['__reactFiber$' + name] = fiber; return fiber;
  }
  const activity = document.getElementById('activity');
  attach(activity, { memoizedProps: {}, type: function activityOwner({ onActivate, needsAttention }) { return 'sidebarElectron.priorityThreads.coachmark.description'; } });
  const frames = new Map(), diagnostics = [], cleanups = new Set(), asyncCleanups = new Set(), rpc = new Map(); let frameCount = 0, discoveryCount = 0;
  const context = { onDeactivate(fn) { cleanups.add(fn); return () => cleanups.delete(fn); }, onCleanup(fn) { asyncCleanups.add(fn); return () => asyncCleanups.delete(fn); }, reportDiagnostic(error) { diagnostics.push(error); }, rpc: { provide(cap, method, handler) { rpc.set(cap.name + ':' + method, handler); } } };
  const navigator = { location: { pathname: '/local/thread-a', search: '', hash: '' } }, host = { navigator, rootNode: document.getElementById('root') };
  const discovery = { transcript() { throw Error('Not loaded'); }, shortcuts() { throw Error('Not loaded'); }, dispose() {} };
  const workspace = window.Workspace.createWorkspace(context, { document, validateDocument() {}, locate: () => { discoveryCount++; return host; }, discovery, requestFrame(fn) { frames.set(++frameCount, fn); return frameCount; }, cancelFrame(id) { frames.delete(id); },...options });
  t.after(() => { workspace.dispose(); window.close(); });
  function owner(id, generation = 1) { const cleanups = new Set(); return { world: 'main', pluginId: id, generation, onDeactivate(fn) { cleanups.add(fn); return () => cleanups.delete(fn); }, retire() { for (const fn of [...cleanups]) fn(); } }; }
  const connect = (id = 'consumer', generation = 1) => { const ctx = owner(id, generation), descriptor = workspace.issueTicket({}, { caller: ctx }); return { ctx, session: workspace.connect(ctx, descriptor.ticket), descriptor }; };
  async function flush() { await tick(); const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); await tick(); }
  return { window, document, current, attach, workspace, discovery, rpc, connect, owner, flush, frames, navigator, diagnostics, cleanup: cleanup => Promise.all([...asyncCleanups].map(fn => fn(cleanup))), stats: () => ({ frameCount, discoveryCount }) };
}

test('workspace tickets bind owner/generation, are single-use, and deactivation retires all owned handles', async t => {
  const f = fixture(t), ctx = f.owner('alice'), descriptor = f.workspace.issueTicket({}, { caller: ctx });
  assert.deepEqual(Object.keys(descriptor).sort(), ['api', 'symbol', 'ticket']);
  assert.throws(() => f.workspace.connect(f.owner('bob'), descriptor.ticket), { code: 'api_ticket_retired' });
  assert.throws(() => f.workspace.connect(f.owner('alice', 2), descriptor.ticket), { code: 'api_ticket_retired' });
  const session = f.workspace.connect(ctx, descriptor.ticket);
  assert.throws(() => f.workspace.connect(ctx, descriptor.ticket), { code: 'api_ticket_retired' });
  const slot = session.createSlot('activity.before'); await f.flush(); assert.equal(slot.container.nextElementSibling.id, 'activity');
  let updates = 0; session.subscribe(() => updates++); assert.equal(updates, 1);
  ctx.retire(); assert.equal(slot.container.isConnected, false); assert.equal(f.frames.size, 0);
  assert.throws(() => session.getSnapshot(), { code: 'workspace_retired' });
});

test('workspace preparation reports each interface separately without mounting, navigating or reading history',async t=>{
  const f=fixture(t),session=f.connect().session;let history=0,navigations=0;
  f.discovery.navigation=async()=>({inputApi:0,openLocalThread(){navigations++;},manager:{}});
  f.discovery.transcript=async()=>({manager:{loadBackgroundThreadHistoryPage(){history++;}},Content(){}});
  f.discovery.shortcuts=async()=>{throw Object.assign(new Error('Shortcut role missing'),{code:'workspace_shortcuts_unavailable'});};
  const result=plain(await session.prepare({features:['navigation','transcript','shortcuts','viewport']}));
  assert.equal(result.evidence,'interface-contract');assert.equal(result.lifecycleVerified,false);assert.equal(result.available,false);
  assert.equal(result.features.navigation.available,true);assert.equal(result.features.transcript.available,true);
  assert.equal(result.features.shortcuts.available,false);assert.equal(result.features.shortcuts.diagnostic.code,'workspace_shortcuts_unavailable');
  assert.equal(result.features.viewport.available,false);assert.equal(navigations,0);assert.equal(history,0);
  assert.equal(f.document.querySelectorAll('[data-codlet-workspace-owned]').length,0);
  await f.flush();assert.equal(session.getSnapshot().available,true,'an independent failed interface does not disable the existing surface');
});

test('workspace preparation validates options and rejects completion after consumer retirement',async t=>{
  const f=fixture(t),owner=f.connect();let resolve;
  for(const options of [null,{features:[]},{features:['transcript','transcript']},{features:['privateFactory']},{extra:true}])
    await assert.rejects(owner.session.prepare(options),{code:'invalid_argument'});
  f.discovery.transcript=()=>new Promise(done=>{resolve=done;});
  const pending=owner.session.prepare({features:['transcript']});await tick();owner.ctx.retire();resolve({});
  await assert.rejects(pending,{code:'workspace_retired'});
  assert.equal(f.document.querySelectorAll('[data-codlet-workspace-owned]').length,0);
});

test('workspace preparation never initializes main-window modules in an auxiliary window',async t=>{
  const f=fixture(t,{locate:()=>({auxiliary:true,navigator:f.navigator,rootNode:f.document.getElementById('root')})});
  let loaded=0;
  f.discovery.navigation=f.discovery.transcript=async()=>{loaded++;return {};};
  const session=f.connect().session;
  await assert.rejects(session.prepare(),{code:'workspace_feature_unavailable'});
  assert.equal(loaded,0);
});

test('a failed composer control is a bounded workspace diagnostic and disposal restores passive publishing',async t=>{
  const f=fixture(t),input=f.document.querySelector('[data-codex-composer-root]'),button=f.document.createElement('button');button.dataset.composerNavigationTarget='permissions';input.append(button);
  const session=f.connect().session,lease=session.acquireComposerControl({control:'permissions',threadId:null});
  const duplicate=button.cloneNode(true);duplicate.removeAttribute('style');duplicate.removeAttribute('inert');duplicate.removeAttribute('aria-hidden');input.append(duplicate);
  f.workspace.refresh();await f.flush();assert.equal(session.getSnapshot().diagnostic.code,'workspace_control_unsupported');assert.equal(session.getSnapshot().available,true);assert.equal(session.getSurface().composer.element,input);assert.equal(lease.container.hasAttribute('inert'),true);
  f.workspace.refresh();await f.flush();assert.equal(f.diagnostics.length,1);assert.equal(f.frames.size,0);
  lease.dispose();await f.flush();assert.equal(session.getSnapshot().diagnostic,null);assert.equal(button.style.display,'');assert.equal(duplicate.style.display,'');assert.equal(lease.container.isConnected,false);assert.equal(f.frames.size,0);
});

test('a Native main page without a composer exposes page content and header for workspace entry', async t => {
  const f=fixture(t),main=f.document.querySelector('main');main.replaceChildren();
  const layout=f.document.createElement('div');layout.dataset.appShellMainContentLayout='';main.append(layout);f.navigator.location.pathname='/settings';
  const session=f.connect().session;await f.flush();
  assert.equal(session.getSurface().main.element,main);assert.equal(session.getSurface().content.element,layout);
  assert.equal(session.getSurface().header.element,f.document.querySelector('[data-app-shell-main-titlebar]'));
  assert.equal(session.getSurface().composer,null);assert.equal(session.getSnapshot().available,false,'available retains its composer meaning');
  const overlay=session.createSlot('workspace.overlay');assert.equal(overlay.container.parentElement,f.document.getElementById('root'));overlay.dispose();
});

test('Native home exposes its real composer and content without a thread scroller, preserving input state under body leases',async t=>{
  const f=fixture(t),main=f.document.querySelector('main');
  main.innerHTML='<div data-app-shell-main-content-layout><section id="greeting">Greeting</section><div><div id="above">Suggestions</div><div><div data-codex-composer-root data-composer-placement="home"><div contenteditable="true">unsent draft</div><button>Native utility</button></div><section id="below">Tips</section></div></div></div>';
  f.navigator.location.pathname='/';const session=f.connect().session;await f.flush();
  const surface=session.getSurface(),layout=main.firstElementChild,composer=main.querySelector('[data-codex-composer-root]'),editable=composer.firstElementChild;
  layout.getBoundingClientRect=()=>({x:100,y:90,left:100,right:1100,top:90,bottom:890,width:1000,height:800});
  const actual=f.window.WorkspaceDom.findWorkspaceSurface(f.document,composer);
  assert.equal(actual.scroller,null);assert.equal(actual.footer,composer);assert.equal(actual.content,layout);
  assert.equal(surface.composer.element,composer);assert.equal(surface.footer.element,composer);assert.equal(surface.scroller,null);assert.equal(session.getSnapshot().features.surface,true);
  assert.equal(f.window.WorkspaceDom.workspaceBodyGeometry(f.document,actual).bodyViewport.rect.height,800);
  const originalParent=composer.parentElement,lease=session.acquireSurface({hideBody:true,composerEnabled:false});
  for(const id of ['greeting','above','below'])assert.equal(f.document.getElementById(id).style.visibility,'hidden');
  assert.equal(composer.style.visibility,'');assert.equal(composer.hasAttribute('inert'),true);assert.equal(composer.parentElement,originalParent);assert.equal(editable.textContent,'unsent draft');assert.equal(composer.querySelector('button').isConnected,true);
  assert.equal(layout.hasAttribute('inert'),false);assert.equal(f.document.querySelector('[data-app-shell-main-titlebar]').style.visibility,'');
  lease.dispose();for(const id of ['greeting','above','below'])assert.equal(f.document.getElementById(id).style.visibility,'');assert.equal(composer.hasAttribute('inert'),false);
  const hide=session.acquireSurface({hideComposer:true});assert.equal(composer.style.visibility,'hidden');hide.dispose();assert.equal(composer.style.visibility,'');
});

test('a malformed thread composer cannot borrow the home fallback or an unrelated scroller',t=>{
  const f=fixture(t),main=f.document.querySelector('main');
  main.innerHTML='<div data-app-shell-main-content-layout><div data-codex-composer-root></div><div class="thread-scroll-container"><footer data-thread-scroll-footer></footer></div></div>';
  assert.throws(()=>f.window.WorkspaceDom.findWorkspaceSurface(f.document,main.querySelector('[data-codex-composer-root]')),{code:'workspace_host_drift'});
});

function plainThreadFixture(t){
  const f=fixture(t),main=f.document.querySelector('main');
  // Current build21828 ordinary-thread branch: no data-includes-composer.
  main.innerHTML='<div data-app-shell-main-content-layout="thread-edge-scroll"><div data-app-shell-focus-area="main"><div id="native-thread-frame"><div class="thread-scroll-container"><section id="body">actual history</section><div data-thread-scroll-footer="true"><div data-codex-composer-root data-composer-placement="thread"><div contenteditable="true">unsent draft</div></div></div></div></div></div></div>';
  const layout=main.firstElementChild,region=layout.firstElementChild,container=region.firstElementChild,scroller=container.firstElementChild,footer=scroller.lastElementChild,composer=footer.firstElementChild;
  const mainFiber=f.attach(main,{type:'main'}),layoutFiber=f.attach(layout,{type:'div'},mainFiber),regionFiber=f.attach(region,{type:'div'},layoutFiber);
  const frame={type:function NativeConversationFrame({floatingContent,contentX}){return 'LocalConversationPage';},memoizedProps:{conversationId:'thread-a',hostId:'local'},return:regionFiber};regionFiber.child=frame;
  const containerFiber=f.attach(container,{type:'div'},frame),scrollFiber=f.attach(scroller,{type:'div'},containerFiber),footerFiber=f.attach(footer,{type:'div'},scrollFiber);f.attach(composer,{type:'div'},footerFiber);
  return{...f,main,layout,region,scroller,footer,composer,frame,regionFiber};
}
test('ordinary Native thread exposes its committed main focus content without a unified-timeline wrapper',async t=>{
  const f=plainThreadFixture(t),actual=f.window.WorkspaceDom.findWorkspaceSurface(f.document,f.composer);
  assert.equal(actual.content,f.region);assert.equal(actual.scroller,f.scroller);assert.equal(actual.footer,f.footer);assert.equal(actual.composer,f.composer);
  const session=f.connect().session;await f.flush();assert.equal(session.getSnapshot().available,true);assert.equal(session.getSurface().content.element,f.region);
  const lease=session.acquireSurface({hideBody:true});assert.equal(f.document.getElementById('body').style.visibility,'hidden');assert.equal(f.footer.style.visibility,'');assert.equal(f.composer.textContent,'unsent draft');lease.dispose();assert.equal(f.document.getElementById('body').style.visibility,'');
});
test('another workspace main and focus region cannot change the confirmed ordinary thread owner',t=>{
  const f=plainThreadFixture(t),other=f.document.createElement('main');other.dataset.appShellMainSurface='other';other.innerHTML='<div data-app-shell-main-content-layout><div data-app-shell-focus-area="main"></div></div>';f.document.getElementById('root').append(other);
  assert.equal(f.window.WorkspaceDom.findWorkspaceSurface(f.document,f.composer).content,f.region);
});
test('an ordinary thread rejects a retired React owner instead of accepting its retained DOM',t=>{
  const f=plainThreadFixture(t);f.current.child=null;
  assert.throws(()=>f.window.WorkspaceDom.findWorkspaceSurface(f.document,f.composer),{code:'workspace_host_drift'});
});
test('an ownerless focus wrapper cannot replace the actual Native content boundary',t=>{
  const f=plainThreadFixture(t),wrapper=f.document.createElement('div');wrapper.dataset.appShellFocusArea='main';f.scroller.before(wrapper);wrapper.append(f.scroller);
  assert.throws(()=>f.window.WorkspaceDom.findWorkspaceSurface(f.document,f.composer),{code:'workspace_host_drift'});
});
test('ordinary thread rejects conflicting frame identity and a footer outside its scroller',t=>{
  const f=plainThreadFixture(t);f.frame.memoizedProps.hostId='remote';
  assert.throws(()=>f.window.WorkspaceDom.findWorkspaceSurface(f.document,f.composer),{code:'workspace_host_drift'});
  f.frame.memoizedProps.hostId='local';f.region.append(f.footer);
  assert.throws(()=>f.window.WorkspaceDom.findWorkspaceSurface(f.document,f.composer),{code:'workspace_host_drift'});
});
test('ordinary thread rejects an unproven frame and two current Native frame owners',t=>{
  const f=plainThreadFixture(t),type=f.frame.type;f.frame.type=function Unrelated(){return null;};
  assert.throws(()=>f.window.WorkspaceDom.findWorkspaceSurface(f.document,f.composer),{code:'workspace_host_drift'});
  f.frame.type=type;const outer={type,memoizedProps:f.frame.memoizedProps,child:f.frame,return:f.regionFiber};f.regionFiber.child=outer;f.frame.return=outer;
  assert.throws(()=>f.window.WorkspaceDom.findWorkspaceSurface(f.document,f.composer),{code:'workspace_host_drift'});
});

test('body viewport follows Native motion and floating edge regions without a fixed summary width',t=>{
  const f=fixture(t),scroller=f.document.querySelector('.thread-scroll-container'),floating=f.document.createElement('div');f.document.querySelector('main').append(floating);
  const bounds={x:100,y:50,left:100,right:1300,top:50,bottom:950,width:1200,height:900};scroller.getBoundingClientRect=()=>bounds;
  floating.getBoundingClientRect=()=>({x:1127,y:60,left:1127,right:1300,top:60,bottom:940,width:173,height:880});let shift=-86.5;
  const surface={scroller,floatingContent:[floating],contentMotion:{get:()=>shift}};
  assert.equal(f.window.WorkspaceDom.workspaceBodyGeometry(f.document,surface).bodyViewport.rect.width,1027);
  shift=0;assert.equal(f.window.WorkspaceDom.workspaceBodyGeometry(f.document,surface).bodyViewport.rect.width,1027,'gutter mode retains Native floating space');
  floating.setAttribute('inert','');const hidden=f.window.WorkspaceDom.workspaceBodyGeometry(f.document,surface);assert.equal(hidden.floatingContent[0].visible,false);assert.equal(hidden.bodyViewport.rect.width,1200);
  shift=-41;assert.equal(f.window.WorkspaceDom.workspaceBodyGeometry(f.document,surface).bodyViewport.rect.width,1118,'Native animation displacement remains independent of floating visibility');
});

test('Native footer transform changes notify surface geometry without a full discovery scan',async t=>{
  const f=fixture(t,{testPoints:{enabled:true,runId:'footer-transform'}}),session=f.connect().session,footer=f.document.querySelector('footer');await f.flush();let x=200;
  footer.getBoundingClientRect=()=>({x,y:982,left:x,right:x+700,top:982,bottom:1096,width:700,height:114});
  const before=f.workspace.readTestPoints().counts['surface.scan'],revision=session.getSnapshot().revision;
  x=155;footer.style.transform='translateX(-45px)';await f.flush();
  assert.equal(session.getSurface().footer.rect.x,155);assert.ok(session.getSnapshot().revision>revision);
  assert.equal(f.workspace.readTestPoints().counts['surface.scan'],before);assert.ok(f.workspace.readTestPoints().counts['surface.style']>0);
});

test('Native content motion subscriptions retire on owner cleanup and do not add a polling loop',async t=>{
  const f=fixture(t),input=f.document.querySelector('[data-codex-composer-root]'),listeners=new Set();let shift=0;
  const motion={get:()=>shift,on(event,listener){assert.equal(event,'change');listeners.add(listener);return()=>listeners.delete(listener);}};
  function NativeFrame(){return 'floatingContent contentX LocalConversationPage';}
  const frame={type:NativeFrame,memoizedProps:{contentX:motion},return:f.current,sibling:f.current.child};f.current.child=frame;
  f.attach(input,{},frame,'motion');
  const scroller=f.document.querySelector('.thread-scroll-container');scroller.getBoundingClientRect=()=>({x:100,y:50,left:100,right:1300,top:50,bottom:950,width:1200,height:900});
  const connected=f.connect();await f.flush();assert.equal(listeners.size,1);assert.equal(f.frames.size,0);
  shift=-64;for(const listener of listeners)listener(shift);await f.flush();assert.equal(connected.session.getSurface().bodyViewport.rect.width,1072);assert.equal(f.frames.size,0);
  connected.ctx.retire();assert.equal(listeners.size,0);
});

test('a transcript can reuse Native shell providers on a page without a main conversation surface',async t=>{
  const f=fixture(t),N=native(f),rail=f.document.querySelector('nav');rail.dataset.appNavigationRail='true';
  f.attach(rail,{dependencies:f.document.querySelector('[data-includes-composer]').__reactFiber$providers.dependencies});
  f.document.querySelector('main').remove();f.navigator.location.pathname='/settings';
  N.manager={getConversation:()=>({resumeState:'resumed',turns:[{}]}),addConversationStateCallback:()=>()=>{}};
  N.Scope=({children})=>children;N.composerScope={};N.composerValue=()=>({});N.ThreadSubscription=()=>null;
  N.Content=({conversationId})=>N.React.createElement('div',{className:'thread-scroll-container'},N.React.createElement('div',{'data-thread-find-target':'conversation'},'Native '+conversationId));f.discovery.transcript=async()=>N;
  const session=f.connect().session,box=f.document.createElement('div');f.document.body.append(box);
  const handle=session.mountTranscript(box,{threadId:'thread-b'});await handle.ready;
  assert.equal(box.textContent,'Native thread-b');assert.equal(N.roots(),1);assert.equal(f.navigator.location.pathname,'/settings');handle.dispose();
});

test('surface leases compose, rebind after navigation and precisely restore attributes/priorities without clobbering a newer patch', async t => {
  const f = fixture(t), a = f.connect('a').session, b = f.connect('b').session, body = f.document.getElementById('body');
  body.style.setProperty('visibility', 'collapse', 'important'); body.setAttribute('aria-hidden', 'false');
  const first = a.acquireSurface({ hideBody: true, composerEnabled: false }), second = b.acquireSurface({ hideBody: true });
  assert.equal(body.style.visibility, 'hidden'); assert.equal(body.hasAttribute('inert'), true);
  first.dispose(); assert.equal(body.style.visibility, 'hidden'); second.dispose();
  assert.equal(body.style.visibility, 'collapse'); assert.equal(body.style.getPropertyPriority('visibility'), 'important'); assert.equal(body.getAttribute('aria-hidden'), 'false'); assert.equal(body.hasAttribute('inert'), false);
  const lease = a.acquireSurface({ hideBody: true, hideHeader: true });
  const replacement = body.cloneNode(true); replacement.removeAttribute('style'); replacement.removeAttribute('inert'); replacement.removeAttribute('aria-hidden'); body.replaceWith(replacement); f.navigator.location.pathname = '/local/thread-b'; await f.flush();
  assert.equal(body.style.visibility, 'collapse'); assert.equal(replacement.style.visibility, 'hidden');
  replacement.style.visibility = 'visible'; lease.dispose(); assert.equal(replacement.style.visibility, 'visible'); assert.equal(replacement.hasAttribute('inert'), false);
  assert.equal(a.getSnapshot().threadId, 'thread-b');
});

test('body leases contain explicitly visible Native rails and preserve independently visible resources',async t=>{
  const f=fixture(t),body=f.document.getElementById('body'),session=f.connect().session;
  body.style.opacity='.6';body.innerHTML='<div style="visibility:visible;position:fixed">Native prompt rail and hover preview</div>';
  const footer=f.document.querySelector('footer'),panel=f.document.querySelector('aside'),preview=body.firstElementChild;
  const lease=session.acquireSurface({hideBody:true});
  assert.equal(f.window.getComputedStyle(preview).visibility,'visible');
  assert.equal(body.style.opacity,'0');assert.equal(body.style.getPropertyPriority('opacity'),'important');
  assert.equal(body.hasAttribute('inert'),true);assert.equal(preview.isConnected,true);
  assert.equal(footer.style.opacity,'');assert.equal(panel.style.opacity,'');
  lease.dispose();assert.equal(body.style.opacity,'0.6');assert.equal(body.style.getPropertyPriority('opacity'),'');
  assert.equal(body.hasAttribute('inert'),false);
  const next=session.acquireSurface({hideBody:true});body.style.opacity='.8';next.dispose();assert.equal(body.style.opacity,'0.8');
});

test('body leases suppress the Native message rail sibling and its linked external preview',async t=>{
  const f=fixture(t),scroller=f.document.querySelector('.thread-scroll-container'),rail=f.document.createElement('nav');
  rail.innerHTML='<div data-thread-user-message-navigation-rail-list aria-describedby="native-rail-preview"><button>Message</button></div>';
  scroller.parentElement.append(rail);
  const preview=f.document.createElement('div');preview.id='native-rail-preview';preview.setAttribute('role','tooltip');preview.innerHTML='<div data-thread-user-message-navigation-tooltip-preview>Preview</div>';f.document.body.append(preview);
  const session=f.connect().session,lease=session.acquireSurface({hideBody:true});
  for(const node of [rail,preview]){assert.equal(node.style.visibility,'hidden');assert.equal(node.style.opacity,'0');assert.equal(node.hasAttribute('inert'),true);}
  assert.equal(f.document.querySelector('aside').hasAttribute('inert'),false);
  assert.equal(f.document.querySelector('footer').style.opacity,'');
  lease.dispose();for(const node of [rail,preview]){assert.equal(node.style.visibility,'');assert.equal(node.style.opacity,'');assert.equal(node.hasAttribute('inert'),false);assert.equal(node.isConnected,true);}
});

test('a cached footer activation inside a stable scroller updates the public composer and its lease', async t => {
  const f = fixture(t), scroller = f.document.querySelector('.thread-scroll-container'), oldFooter = scroller.querySelector('footer');
  oldFooter.dataset.appShellActivePage = 'true';
  const nextFooter = oldFooter.cloneNode(true); nextFooter.dataset.appShellActivePage = 'false'; scroller.append(nextFooter);
  const session = f.connect().session, lease = session.acquireSurface({ composerEnabled: false });
  assert.equal(session.getSurface().composer.element, oldFooter.querySelector('[data-codex-composer-root]'));
  oldFooter.dataset.appShellActivePage = 'false'; nextFooter.dataset.appShellActivePage = 'true';
  await f.flush();
  assert.equal(session.getSurface().composer.element, nextFooter.querySelector('[data-codex-composer-root]'));
  assert.equal(oldFooter.hasAttribute('inert'), false);
  assert.equal(nextFooter.hasAttribute('inert'), true);
  lease.dispose(); assert.equal(nextFooter.hasAttribute('inert'), false);
});

test('committed navigation publishes the confirmed composer before a queued visible frame', async t => {
  let binding;
  const f = fixture(t, { navigationBinding: () => binding, testPoints: { enabled: true, runId: 'confirmed-surface' } });
  Object.defineProperty(f.document, 'visibilityState', { value: 'visible', configurable: true });
  const firstMain = f.document.querySelector('main'), secondMain = firstMain.cloneNode(true);
  firstMain.dataset.appShellActivePage = 'true'; secondMain.dataset.appShellActivePage = 'false'; firstMain.after(secondMain);
  const firstInput = firstMain.querySelector('[data-codex-composer-root]'), secondInput = secondMain.querySelector('[data-codex-composer-root]');
  binding = { threadId: 'thread-a', hostId: 'local', input: firstInput, submitDisabled: false };
  const session = f.connect().session;
  f.discovery.navigation = async () => ({ manager: { getConversation: id => ({ id, resumeState: 'resumed' }) } });
  f.navigator.push = pathname => {
    f.navigator.location.pathname = pathname;
    firstMain.dataset.appShellActivePage = 'false'; secondMain.dataset.appShellActivePage = 'true';
    binding = { ...binding, threadId: 'thread-b', input: secondInput };
  };
  const navigation = session.createNavigation(); await navigation.ready;
  const geometryBefore = f.workspace.readTestPoints().counts['surface.geometry'];
  await navigation.open({ threadId: 'thread-b' }).committed;
  assert.equal(session.getSurface().composer.element, secondInput, 'receipt cannot expose the old composer until rAF');
  assert.equal(session.getSurface().main.element, secondMain);
  assert.equal(session.getSnapshot().threadId, 'thread-b');
  const points = f.workspace.readTestPoints().samples;
  const committed = points.find(point => point.phase === 'navigation.committed');
  const phases = ['navigation.input.confirmed', 'navigation.surface.scan', 'navigation.surface.control', 'surface.geometry.complete', 'navigation.surface.publish', 'navigation.surface', 'navigation.committed'];
  const measured = phases.map(phase => points.find(point => point.phase === phase && point.operationId === committed.operationId));
  assert.ok(measured.every(Boolean), 'surface and geometry phases correlate with the confirming navigation');
  assert.ok(measured.every((point, index) => !index || point.timestamp >= measured[index - 1].timestamp));
  await f.flush();
  assert.equal(session.getSurface().composer.element, secondInput);
  assert.equal(f.workspace.readTestPoints().counts['surface.geometry'], geometryBefore + 1, 'the queued frame does not repeat committed geometry');
});

test('a confirmed surface input outside the native root, owned by a consumer or inactive cannot substitute a cached composer', t => {
  const f = fixture(t), input = f.document.querySelector('[data-codex-composer-root]');
  input.dataset.codletWorkspaceOwned = 'consumer';
  assert.throws(() => f.window.WorkspaceDom.findWorkspaceSurface(f.document, input), { code: 'workspace_host_drift' });
  delete input.dataset.codletWorkspaceOwned;
  input.closest('footer').dataset.appShellActivePage = 'false';
  assert.throws(() => f.window.WorkspaceDom.findWorkspaceSurface(f.document, input), { code: 'workspace_host_drift' });
  delete input.closest('footer').dataset.appShellActivePage;
  f.document.body.append(input);
  assert.throws(() => f.window.WorkspaceDom.findWorkspaceSurface(f.document, input), { code: 'workspace_host_drift' });
});

test('streamed body tokens and owned slots do not schedule full discovery; burst shell changes coalesce to one frame', async t => {
  const f = fixture(t), session = f.connect().session, slot = session.createSlot('activity.before'); await f.flush();
  const before = f.stats();
  for (let i = 0; i < 100; i++) f.document.getElementById('body').append(f.document.createElement('span'));
  for (let i = 0; i < 100; i++) slot.container.append(f.document.createElement('button'));
  await f.flush(); assert.deepEqual(f.stats(), before);
  for (let i = 0; i < 40; i++) f.document.querySelector('nav').append(f.document.createElement('span'));
  await f.flush(); assert.equal(f.stats().frameCount, before.frameCount + 1); assert.equal(f.stats().discoveryCount, 1);
  await f.flush(); assert.equal(f.frames.size, 0);
});

test('native thread references are bounded, reject remote/consumer/main nodes, and surface ambiguity fails closed', async t => {
  const f = fixture(t), session = f.connect().session, row = f.document.getElementById('thread');
  f.attach(row, { memoizedProps: { threadKey: { threadId: 'thread-a', hostId: 'local' } } });
  assert.deepEqual(plain(session.resolveThreadReference(row)), { threadId: 'thread-a', hostId: 'local' });
  row.__reactFiber$fixture.memoizedProps.threadKey.hostId = 'remote'; assert.equal(session.resolveThreadReference(row), null);
  row.__reactFiber$fixture.memoizedProps.threadKey.hostId = 'local'; f.document.querySelector('main').append(row); assert.equal(session.resolveThreadReference(row), null);
  f.document.getElementById('root').append(f.document.querySelector('main').cloneNode(true)); await f.flush();
  assert.equal(session.getSurface().available, false); assert.equal(session.getSnapshot().diagnostic.code, 'workspace_host_drift');
});

test('loaded summaries contain metadata only, update one affected thread and emit nothing for unchanged tokens', () => {
  const threads = new Map(Array.from({ length: 105 }, (_, i) => ['thread-' + i, { id: 'thread-' + i, title: 'Task ' + i, cwd: 'X:/fixture', resumeState: 'resumed', turns: [{ status: i === 0 ? 'inProgress' : 'completed', items: [{ text: 'private history' }] }], requests: [] }]));
  let enumerations = 0; const events = [], manager = { getCachedConversations() { enumerations++; return [...threads.values()]; }, getConversation: id => threads.get(id) };
  const summaries = createLoadedThreads(manager, event => events.push(event), 'instance');
  const first = summaries.read({ limit: 100 }); assert.equal(first.threads.length, 100); assert.ok(first.cursor); assert.equal(first.threads[0].runtimeStatus, 'running'); assert.equal('turns' in first.threads[0], false);
  for (let i = 0; i < 1000; i++) { threads.get('thread-0').turns[0].items[0].text += 'x'; summaries.refresh('thread-0'); }
  assert.equal(events.length, 0); assert.equal(enumerations, 1);
  threads.get('thread-0').requests.push({ id: 'approval' }); summaries.refresh('thread-0'); assert.equal(events.length, 1); assert.equal(events[0].thread.runtimeStatus, 'attention');
  const last = summaries.read({ cursor: first.cursor }); assert.equal(last.threads.length, 5); assert.equal(last.cursor, null);
  assert.throws(() => summaries.read({ cursor: first.cursor }), { code: 'invalid_argument' });
  threads.delete('thread-0'); summaries.refresh('thread-0'); assert.equal(events.at(-1).thread, null);
  assert.deepEqual(summaries.read({ threadId: 'missing' }), { threads: [], cursor: null }); assert.equal(enumerations, 1); summaries.dispose();
});

test('more than 4096 loaded summaries page completely and later additions and updates remain available',()=>{
  const threads=new Map(Array.from({length:4205},(_,index)=>{const id='large-loaded-'+index;return[id,{id,title:'Task '+index,cwd:'X:/fixture',resumeState:'resumed',threadRuntimeStatus:{type:'idle'},requests:[]}];})),events=[];
  let enumerations=0;const summaries=createLoadedThreads({getCachedConversations(){enumerations++;return[...threads.values()];},getConversation:id=>threads.get(id)},event=>events.push(event),'large-instance');
  const readAll=()=>{const ids=[];let cursor;do{const page=summaries.read({limit:100,...(cursor?{cursor}:{})});assert.ok(page.threads.length<=100);ids.push(...page.threads.map(thread=>thread.id));cursor=page.cursor;}while(cursor);return ids;};
  assert.deepEqual(readAll(),[...threads.keys()]);assert.equal(enumerations,1);
  const id='large-added-after-initialization';threads.set(id,{id,title:'New cached task',resumeState:'resumed',threadRuntimeStatus:{type:'active',activeFlags:[]},requests:[]});summaries.refresh(id);
  assert.equal(events.at(-1).thread.runtimeStatus,'running');assert.equal(summaries.read({threadId:id}).threads[0].id,id);
  threads.get('large-loaded-4100').title='Updated beyond previous cap';summaries.refresh('large-loaded-4100');assert.equal(events.at(-1).thread.title,'Updated beyond previous cap');
  assert.deepEqual(readAll(),[...threads.keys()]);assert.equal(enumerations,1);
  assert.throws(()=>summaries.read({limit:101}),{code:'invalid_argument'});assert.throws(()=>summaries.read({cursor:'foreign-cursor'}),{code:'invalid_argument'});
  threads.delete(id);summaries.refresh(id);assert.equal(events.at(-1).thread,null);assert.deepEqual(summaries.read({threadId:id}),{threads:[],cursor:null});summaries.dispose();
});

function native(f) {
  const N = { ...f.window.eval(nativeSource + ';NativeShell;') }, context = N.React.createContext(null);
  const provider = { dependencies: { firstContext: { context, memoizedValue: 'native-app-scope' } }, return: f.current, child: f.current.child };
  for (let child = provider.child; child; child = child.sibling) child.return = provider;
  f.current.child = provider;
  f.attach(f.document.querySelector('[data-includes-composer]'), { dependencies: provider.dependencies }, provider, 'providers');
  let roots = 0; const createRoot = N.Client.createRoot;
  N.Client = { createRoot(...args) { roots++; delete args[0].__reactContainer$fixture; return createRoot(...args); } };
  N.roots = () => roots; return N;
}

test('current Provider capture keeps the nearest Native scope chain when the same Context is nested',t=>{
  const f=fixture(t),N=native(f),R=N.React,h=R.createElement,Context=R.createContext(null),outer=new Map(),inner=new Map([['AppScope','original']]);
  const box=f.document.getElementById('root'),root=N.Client.createRoot(box);t.after(()=>N.DOM.flushSync(()=>root.unmount()));
  const render=value=>h(Context,{value:outer},h(Context,{value},h('main',{'data-app-shell-main-surface':''},h('div',{id:'provider-target'}))));
  N.DOM.flushSync(()=>root.render(render(inner)));const target=f.document.getElementById('provider-target');
  assert.equal(f.window.WorkspaceDom.providersFor(target).find(([context])=>context===Context)?.[1],inner,'the outer empty chain cannot replace the nearest AppScope');
  const next=new Map([['AppScope','updated']]);N.DOM.flushSync(()=>root.render(render(next)));
  assert.equal(f.document.getElementById('provider-target'),target);assert.equal(f.window.WorkspaceDom.providersFor(target).find(([context])=>context===Context)?.[1],next,'current tree proof retains the new nearest value on a reused DOM node');
});

test('Native transcript mount inherits the inner AppScope instead of rendering a missing-parent error under an outer empty chain',async t=>{
  const f=fixture(t),N=native(f),R=N.React,h=R.createElement,Context=R.createContext(new Map()),root=N.Client.createRoot(f.document.getElementById('root'));t.after(()=>N.DOM.flushSync(()=>root.unmount()));
  const NativeMain=()=>h(R.Fragment,null,h('div',{'data-app-shell-main-titlebar':''}),h('main',{'data-app-shell-main-surface':''},h('div',{'data-includes-composer':''},h('div',{className:'thread-scroll-container'},h('section'),h('footer',{'data-thread-scroll-footer':''},h('div',{'data-codex-composer-root':''}))))));
  N.DOM.flushSync(()=>root.render(h(Context,{value:new Map()},h(Context,{value:new Map([['AppScope','native']])},h(NativeMain)))));
  N.manager={getConversation:()=>({resumeState:'resumed',turns:[{}]}),addConversationStateCallback:()=>()=>{}};N.Scope=({children})=>children;N.composerScope={};N.composerValue=()=>({});N.ThreadSubscription=()=>null;
  N.Content=({conversationId})=>{if(R.useContext(Context).get('AppScope')!=='native')throw Error('Missing parent scope');return h('div',{className:'thread-scroll-container'},h('div',{'data-thread-find-target':'conversation'},'Native '+conversationId));};f.discovery.transcript=async()=>N;
  const session=f.connect().session,container=f.document.createElement('div');f.document.body.append(container);const handle=session.mountTranscript(container,{threadId:'thread-b'});await handle.ready;
  assert.equal(container.textContent,'Native thread-b');assert.equal(f.diagnostics.some(value=>value.message==='Missing parent scope'),false);
  const own=container.querySelector('.thread-scroll-container'),main=f.document.querySelector('main .thread-scroll-container');main.scrollTop=120;own.scrollLeft=9;
  Object.defineProperties(own,{scrollHeight:{value:2400,configurable:true},clientHeight:{value:400,configurable:true}});
  handle.scrollToLatest();assert.deepEqual(plain(handle.getScrollPosition()),{top:2000,left:9});assert.equal(main.scrollTop,120);
  Object.defineProperty(own,'scrollHeight',{value:260});handle.scrollToLatest();assert.equal(own.scrollTop,0);
  handle.dispose();assert.throws(()=>handle.scrollToLatest(),{code:'workspace_retired'});
});

function composerNative(f,{wrong=false}={}){
  const N=native(f),R=N.React,h=R.createElement,scopeContext=R.createContext(new Map()),controllerContext=R.createContext(null);let mounted=0,renders=0;
  N.ThreadScope={id:Symbol('thread')};N.RouteScope={id:Symbol('route')};N.composerScope={id:Symbol('composer')};
  N.Scope=({scope,value,children})=>{const parent=R.useContext(scopeContext),node=R.useMemo(()=>({token:scope,value}),[scope,value]),chain=R.useMemo(()=>new Map([...parent,[scope.id,node]]),[parent,scope,node]);return h(scopeContext.Provider,{value:chain},children);};
  N.routeDescription=({pathname,search})=>({pathname,search,routeKind:'local-thread',conversationId:pathname.slice('/local/'.length)});N.composerValue=value=>({kind:'local',placement:'main',conversationId:value.conversationId,clientThreadId:'local:'+value.conversationId});
  N.manager={getConversation:id=>({id,resumeState:'resumed'}),getStreamRole:()=>({role:'owner'})};
  function Input({submitDisabled,onSubmitLocal,identity,location}){const controller=R.useContext(controllerContext),ref=R.useRef(null);R.useLayoutEffect(()=>{controller.view.dom=ref.current;});return h('div',null,h('div',{ref,contentEditable:true,suppressContentEditableWarning:true,'data-thread':identity.conversationId,'data-client':identity.clientThreadId,'data-route':location.conversationId}),h('button',{disabled:submitDisabled,onClick:onSubmitLocal},'Native action'));}
  function Composer(props){
    const{composerSubmitDisabled,isThreadHistoryLoading,composerController,onDocumentChange,onDocumentDispose}=props,[shown,setShown]=R.useState(false),chain=R.useContext(scopeContext);
    const node=chain.get(N.composerScope.id),ref=R.useRef(null);ref.current={node,scope:N.composerScope,value:node.value,chain,getOwnValue:token=>chain.get(token.id)?.value};
    const controller=R.useMemo(()=>({view:{dom:null,isDestroyed:false},getPersistedText(){return '';},restoreDraft(){}}),[]),submit=R.useCallback(()=>N.actions.push(chain.get(N.RouteScope.id).value.conversationId),[chain]);
    R.useEffect(()=>{mounted++;setShown(true);return()=>mounted--;},[]);if(!shown)return h('span',{'data-native-preparing':''});
    return h('footer',{'data-thread-scroll-footer':''},h('div',{'data-codex-composer-root':''},h(controllerContext.Provider,{value:controller},h(Input,{submitDisabled:composerSubmitDisabled||isThreadHistoryLoading,onSubmitLocal:submit,identity:node.value,location:chain.get(N.RouteScope.id).value}))));
  }
  N.actions=[];N.Frame=props=>{renders++;const conversationId=wrong?'wrong-thread':props.conversationId;return h(N.Scope,{scope:N.composerScope,value:N.composerValue({conversationId})},h(Composer,{...props,conversationId,composerPresentation:null,isThreadHistoryLoading:false}));};N.composerStats=()=>({mounted,renders});f.discovery.composer=async()=>N;return N;
}

test('owned composers activate independently without rerender, implicit peer deactivation, navigation or focus',async t=>{
  const f=fixture(t),N=composerNative(f),owner=f.connect(),states=[];const boxes=['composer-one','composer-two'].map(id=>{const box=f.document.createElement('div');f.document.body.append(box);return{box,handle:owner.session.mountComposer(box,{threadId:id,onState:state=>states.push([id,state.phase])})};});
  await Promise.all(boxes.map(x=>x.handle.ready));assert.equal(N.composerStats().mounted,2);assert.equal(N.roots(),2);const before=N.composerStats(),focus=f.document.activeElement;
  for(const view of boxes){assert.equal(view.box.firstElementChild.hasAttribute('inert'),true);const input=view.box.querySelector('[contenteditable]');assert.equal(input.dataset.thread,view.handle.threadId);assert.equal(input.dataset.route,view.handle.threadId);assert.equal(input.dataset.client,'local:'+view.handle.threadId);assert.throws(()=>{view.handle.threadId='other-id';},TypeError);}
  for(let repeat=0;repeat<2;repeat++)for(const view of boxes){const receipt=await view.handle.activate();assert.equal(receipt.threadId,view.handle.threadId);assert.equal(receipt.hostId,'local');assert.equal(receipt.inputConfirmed,true);assert.equal(receipt.submitDisabled,false);assert.equal(f.document.activeElement,focus);assert.equal(view.box.firstElementChild.hasAttribute('inert'),false);view.box.querySelector('button').click();}
  assert.deepEqual(N.actions,['composer-one','composer-two','composer-one','composer-two']);assert.deepEqual(N.composerStats(),before);assert.equal(f.navigator.location.pathname,'/local/thread-a');assert.equal(boxes[0].box.firstElementChild.hasAttribute('inert'),false);assert.equal(boxes[1].box.firstElementChild.hasAttribute('inert'),false);
  owner.ctx.retire();assert.equal(N.composerStats().mounted,0);assert.equal(f.document.querySelectorAll('[data-codlet-workspace-composer]').length,0);assert.throws(()=>boxes[0].handle.activate(),{code:'workspace_retired'});
});

test('deactivation synchronously blocks late activation while allowing the prepared input to finish warming',async t=>{
  const f=fixture(t),N=composerNative(f),owner=f.connect();let release;f.discovery.composer=()=>new Promise(resolve=>{release=resolve;});const box=f.document.createElement('div');f.document.body.append(box);const handle=owner.session.mountComposer(box,{threadId:'late-composer'}),activation=handle.activate();handle.deactivate();await assert.rejects(activation,{code:'workspace_composer_deactivated'});assert.equal(box.firstElementChild.hasAttribute('inert'),true);await tick();release(N);await handle.ready;await tick();assert.equal(box.firstElementChild.hasAttribute('inert'),true);assert.throws(()=>handle.focus(),{code:'workspace_composer_inactive'});assert.equal(f.navigator.location.pathname,'/local/thread-a');
});

test('composer cancellation only affects its handle and disposal prevents roots after late discovery',async t=>{
  const f=fixture(t),N=composerNative(f),alice=f.connect('alice'),bob=f.connect('bob');const make=(owner,id)=>{const box=f.document.createElement('div');f.document.body.append(box);return{box,handle:owner.session.mountComposer(box,{threadId:id})};};const first=make(alice,'alice-first'),second=make(alice,'alice-second'),other=make(bob,'bob-composer');await Promise.all([first.handle.ready,second.handle.ready,other.handle.ready]);await first.handle.activate();await other.handle.activate();const late=second.handle.activate();assert.equal(first.box.firstElementChild.hasAttribute('inert'),false);assert.equal(other.box.firstElementChild.hasAttribute('inert'),false);second.handle.deactivate();await assert.rejects(late,{code:'workspace_composer_deactivated'});await tick();assert.equal(second.box.firstElementChild.hasAttribute('inert'),true);
  const delayed=fixture(t),D=composerNative(delayed),owner=delayed.connect();let release;delayed.discovery.composer=()=>new Promise(resolve=>release=resolve);const box=delayed.document.createElement('div');delayed.document.body.append(box);const handle=owner.session.mountComposer(box,{threadId:'retired-composer'}),activation=handle.activate();await tick();owner.ctx.retire();await assert.rejects(handle.ready,{code:'workspace_retired'});await assert.rejects(activation,{code:'workspace_composer_deactivated'});release(D);await tick();assert.equal(D.roots(),0);assert.equal(box.childNodes.length,0);
});

test('surface scans retain resize subscriptions on identical nodes and only replace changed roles',async t=>{
  const f=fixture(t,{testPoints:{enabled:true,runId:'resize-subscriptions'}}),observers=[];
  f.window.ResizeObserver=class {
    constructor(callback){this.callback=callback;this.nodes=new Set();this.adds=0;this.removes=0;this.disconnects=0;observers.push(this);}
    observe(node){this.nodes.add(node);this.adds++;}
    unobserve(node){this.nodes.delete(node);this.removes++;}
    disconnect(){this.nodes.clear();this.disconnects++;}
  };
  const owner=f.connect(),ro=observers[0],initial=ro.adds;
  assert.equal(initial,7);
  for(let repeat=0;repeat<3;repeat++){
    for(let i=0;i<40;i++)f.document.querySelector('nav').append(f.document.createElement('span'));
    await f.flush();
    assert.equal(ro.adds,initial);assert.equal(ro.removes,0);assert.equal(ro.disconnects,0);
    await f.flush();assert.equal(f.frames.size,0);
  }
  const previous=owner.session.getSurface().composer.element,beforeRevision=owner.session.getSnapshot().revision;
  const next=previous.cloneNode(true);previous.replaceWith(next);await f.flush();
  assert.equal(owner.session.getSurface().composer.element,next);
  assert.ok(owner.session.getSnapshot().revision>beforeRevision,'equal rectangles must still publish replaced role identity');
  assert.equal(ro.adds,initial+1);assert.equal(ro.removes,1);assert.equal(ro.disconnects,0);
  const before=f.workspace.readTestPoints().counts['surface.geometry'];
  ro.callback([{target:previous}]);await f.flush();
  assert.equal(f.workspace.readTestPoints().counts['surface.geometry'],before,'late notifications from a retired role are ignored');
  owner.ctx.retire();assert.equal(ro.nodes.size,0);assert.equal(ro.disconnects,1);
});

test('feature updates publish without rereading geometry and metrics exist only when explicitly enabled',async t=>{
  const f=fixture(t,{testPoints:{enabled:true,runId:'feature-only'}}),owner=f.connect(),N=native(f);
  const before=f.workspace.readTestPoints().counts['surface.geometry'];
  N.Button=props=>N.React.createElement('button',props);N.Tooltip=({children})=>children;f.discovery.action=async()=>N;
  const action=owner.session.registerAction({id:'measurement-action',label:'Measurement action',icon:{paths:['M0 0 H4 V4 H0 Z']},onInvoke(){}});
  await action.ready;await f.flush();
  assert.equal(owner.session.getSnapshot().features.action,true);
  assert.equal(f.workspace.readTestPoints().counts['surface.geometry'],before);
  assert.equal('readTestPoints' in fixture(t).workspace,false);
});

test('composer readiness rejects a Native input bound to another conversation',async t=>{
  const f=fixture(t),N=composerNative(f,{wrong:true}),owner=f.connect(),box=f.document.createElement('div');f.document.body.append(box);const handle=owner.session.mountComposer(box,{threadId:'expected-thread'});await assert.rejects(handle.ready,{code:'workspace_composer_binding_drift'});assert.equal(box.firstElementChild.hasAttribute('inert'),true);handle.dispose();assert.equal(N.composerStats().mounted,0);
});

function rebindingNative(f, { pendingSave = false, saveError } = {}) {
  const N = native(f), R = N.React, h = R.createElement;
  let mounted = 0, closed = 0, saveResolve;
  const saved = pendingSave ? new Promise(resolve => saveResolve = resolve) : Promise.resolve();
  function Input({ binding, active, commit, submit }) {
    R.useLayoutEffect(commit, [commit]);
    return h('div', {'data-codex-composer-root': ''},
      h('div', { contentEditable: active, suppressContentEditableWarning: true, 'data-thread': binding.threadId }),
      h('button', { disabled: !active, onClick: submit }, 'Native fixture submit'));
  }
  N.actions = [];
  N.Frame = () => assert.fail('rebind fixture must never mount the thread Frame');
  N.composerRebind = { supported: true, mount({ container }) {
    const root = N.Client.createRoot(container); mounted++;
    // Prototype methods and private fields exercise the actual driver boundary.
    return new class {
      #binding; #active = false; #closed = false;
      block() { this.#active = false; }
      isComposing() { return false; }
      readBinding() { return this.#binding && {...this.#binding, inputConfirmed: true, submitDisabled: !this.#active}; }
      render(value, active, signal) {
        return new Promise((resolve, reject) => {
          const abort = () => reject(signal.reason); signal.addEventListener('abort', abort, {once:true});
          const commit = () => {
            signal.removeEventListener('abort', abort);
            if (signal.aborted || this.#closed) return;
            this.#binding = value; this.#active = active; resolve();
          };
          root.render(h(Input, {key:value.threadId, binding:value, active, commit,
            submit:() => { if (this.#active && this.#binding.bindingRevision === value.bindingRevision) N.actions.push([value.threadId,value.bindingRevision]); }}));
        });
      }
      bind(value, {signal}) { return this.render(value, false, signal); }
      activate({bindingRevision,signal}) { assert.equal(this.#binding.bindingRevision,bindingRevision);return this.render(this.#binding,true,signal); }
      focus() { const input=container.querySelector('[contenteditable="true"]');input?.focus();return f.document.activeElement===input; }
      async close({signal}) {
        this.#closed=true;N.DOM.flushSync(()=>root.unmount());mounted--;closed++;
        if (saveError) throw saveError;
        await saved;signal.throwIfAborted();
      }
    }();
  }};
  f.discovery.composerCapabilities = async () => ({rebind:true}); f.discovery.composer = async () => N;
  N.stats = () => ({mounted,closed}); N.confirmSave = () => saveResolve();
  return N;
}

test('rebind capability is observable before mounting and public ownership wrappers retain live identity getters',async t=>{
  const f=fixture(t,{testPoints:{enabled:true,runId:'rebind-public'}}),N=rebindingNative(f),owner=f.connect(),features=[];
  owner.session.subscribe(snapshot=>features.push(snapshot.features.composerRebind));
  assert.equal(owner.session.getSnapshot().features.composerRebind,false);assert.equal(N.roots(),0);
  await f.flush();assert.equal(owner.session.getSnapshot().features.composerRebind,true);assert.equal(N.roots(),0);assert.deepEqual(features,[false,true]);
  const box=f.document.createElement('div');f.document.body.append(box);const handle=owner.session.mountComposer(box,{threadId:'first-public'});
  const first=await handle.ready;await handle.activate({bindingRevision:first.bindingRevision});assert.equal(handle.focus({bindingRevision:first.bindingRevision}),true);
  box.querySelector('button').click();const second=await handle.bind({threadId:'second-public'});
  assert.equal(handle.threadId,'second-public');assert.equal(N.roots(),1);assert.equal(box.firstElementChild.hasAttribute('inert'),true);
  await handle.activate({bindingRevision:second.bindingRevision});box.querySelector('button').click();
  assert.deepEqual(N.actions,[['first-public',1],['second-public',2]]);assert.equal(f.navigator.location.pathname,'/local/thread-a');
  assert.throws(()=>handle.close({unknown:true}),{code:'invalid_argument'});
  owner.ctx.retire();await f.cleanup({signal:new f.window.AbortController().signal});assert.equal(N.stats().mounted,0);assert.equal(N.stats().closed,1);
  assert.equal(box.childNodes.length,0);assert.ok(f.workspace.readTestPoints().counts['composer.bind.complete']>=2);
});

test('Core asynchronous cleanup waits for a Native checkpoint even after synchronous consumer disposal',async t=>{
  const f=fixture(t),N=rebindingNative(f,{pendingSave:true}),owner=f.connect();await f.flush();
  const box=f.document.createElement('div');f.document.body.append(box);const handle=owner.session.mountComposer(box,{threadId:'save-fixture'});await handle.ready;
  owner.ctx.retire();let complete=false;const cleanup=f.cleanup({signal:new f.window.AbortController().signal}).then(()=>complete=true);
  await tick();assert.equal(N.stats().mounted,0);assert.equal(complete,false);assert.equal(N.stats().closed,1);
  N.confirmSave();await cleanup;await handle.close();assert.equal(complete,true);assert.equal(box.childNodes.length,0);
});

test('Core cleanup retains an already-settled Native checkpoint failure after the consumer removes the handle',async t=>{
  const f=fixture(t),error=Object.assign(Error('checkpoint not confirmed'),{code:'workspace_composer_cleanup_incomplete'});
  const N=rebindingNative(f,{saveError:error}),owner=f.connect();await f.flush();
  const box=f.document.createElement('div');f.document.body.append(box);
  const handle=owner.session.mountComposer(box,{threadId:'failed-save-fixture'});await handle.ready;
  handle.dispose();await assert.rejects(handle.close(),{code:error.code});await tick();
  assert.equal(box.childNodes.length,0);assert.equal(N.stats().mounted,0);
  owner.ctx.retire();await assert.rejects(f.cleanup({signal:new f.window.AbortController().signal}),{code:error.code});
});

test('an incomplete Native factory releases its root and remains part of asynchronous provider cleanup',async t=>{
  const f=fixture(t),N=rebindingNative(f,{pendingSave:true}),create=N.composerRebind.mount,owner=f.connect();await f.flush();
  N.composerRebind.mount=options=>{const driver=create(options);driver.focus=undefined;return driver;};
  const box=f.document.createElement('div');f.document.body.append(box);
  assert.throws(()=>owner.session.mountComposer(box,{threadId:'invalid-driver-fixture'}),{code:'workspace_composer_unsupported'});
  let complete=false;const cleanup=f.cleanup({signal:new f.window.AbortController().signal}).then(()=>complete=true);await tick();
  assert.equal(N.stats().mounted,0);assert.equal(N.stats().closed,1);assert.equal(complete,false);assert.equal(box.childNodes.length,0);
  N.confirmSave();await cleanup;assert.equal(complete,true);
});

test('retirement during capability discovery cannot enable it late or allocate a Native input',async t=>{
  const f=fixture(t),N=rebindingNative(f);let resolve;
  f.discovery.composerCapabilities=()=>new Promise(yes=>resolve=yes);const owner=f.connect();await tick();owner.ctx.retire();resolve({rebind:true});await f.flush();
  assert.equal(N.roots(),0);
  f.discovery.composerCapabilities=async()=>({rebind:true});const current=f.connect('second-owner');await f.flush();
  assert.equal(current.session.getSnapshot().features.composerRebind,true);assert.equal(N.roots(),0);
});

test('transcripts share discovery/history/listener, preserve roots and scroll on flags, and retire late work', async t => {
  const f = fixture(t), N = native(f), owner = f.connect(), conversations = new Map(), callbacks = new Set();
  let discoveries = 0, loads = 0, interests = 0;
  N.manager = { getConversation: id => conversations.get(id), async loadBackgroundThreadHistoryPage(id) { loads++; await tick(); conversations.set(id, { resumeState: 'resumed' }); }, addConversationStateCallback(fn) { callbacks.add(fn); return () => callbacks.delete(fn); } };
  N.Scope = ({ children }) => children; N.composerScope = {}; N.composerValue = route => ({ id: route.conversationId });
  N.ThreadSubscription = () => null;
  N.Content = ({ conversationId }) => { N.React.useEffect(() => { interests++; return () => interests--; }, [conversationId]); return N.React.createElement('div', { className: 'thread-scroll-container' }, N.React.createElement('div', { 'data-thread-find-target': 'conversation' }, 'native content ' + conversationId)); };
  f.discovery.transcript = async () => { discoveries++; return N; };
  const states = [], handles = Array.from({ length: 12 }, (_, index) => { const box = f.document.createElement('div'); f.document.body.append(box); return owner.session.mountTranscript(box, { threadId: 'thread-a', onState: state => { if (index === 0) states.push(state.phase); } }); });
  await Promise.all(handles.map(handle => handle.ready)); await tick();
  assert.equal(discoveries, 1); assert.equal(loads, 1); assert.equal(callbacks.size, 1); assert.equal(N.roots(), 12); assert.equal(interests, 12);
  handles[0].setScrollPosition({ top: 123, left: 9 }); handles[0].update({ readOnly: false, trackReadState: true }); await tick();
  assert.deepEqual(plain(handles[0].getScrollPosition()), { top: 123, left: 9 }); assert.equal(N.roots(), 12); assert.equal(loads, 1); assert.equal(interests, 12);
  assert.deepEqual(states, ['loading', 'ready']);
  handles[0].setScrollPosition({ top: -41, left: -9 }); assert.deepEqual(plain(handles[0].getScrollPosition()), { top: -41, left: -9 });
  handles[0].update({ threadId: 'thread-b' }); await tick(); await tick(); assert.equal(loads, 2); assert.equal(N.roots(), 12);
  owner.ctx.retire(); assert.equal(callbacks.size, 0); assert.equal(interests, 0); assert.equal(f.document.querySelectorAll('[data-codlet-workspace-owned]').length, 0);
  assert.throws(() => handles[0].getScrollPosition(), { code: 'workspace_retired' });
});

test('more than 32 transcripts per owner and Target render, reuse containers and retire independently',async t=>{
  const f=fixture(t),N=native(f),first=f.connect('many-first'),second=f.connect('many-second'),callbacks=new Set(),active=new Map();let discoveries=0,loads=0;
  N.manager={getConversation:()=>({resumeState:'resumed',turns:[{}]}),loadBackgroundThreadHistoryPage(){loads++;},addConversationStateCallback(fn){callbacks.add(fn);return()=>callbacks.delete(fn);}};
  N.Scope=({children})=>children;N.composerScope={};N.composerValue=route=>({id:route.conversationId});N.ThreadSubscription=()=>null;
  N.Content=({conversationId})=>{N.React.useEffect(()=>{active.set(conversationId,(active.get(conversationId)??0)+1);return()=>{const next=active.get(conversationId)-1;next?active.set(conversationId,next):active.delete(conversationId);};},[conversationId]);return N.React.createElement('div',{className:'thread-scroll-container'},N.React.createElement('div',{'data-thread-find-target':'conversation'},'body '+conversationId));};
  f.discovery.transcript=async()=>{discoveries++;return N;};
  const mount=(owner,count,prefix)=>Array.from({length:count},(_,index)=>{const box=f.document.createElement('div');f.document.body.append(box);const id=prefix+index;return{box,id,handle:owner.session.mountTranscript(box,{threadId:id})};});
  const a=mount(first,48,'many-first-'),b=mount(second,40,'many-second-'),all=[...a,...b];await Promise.all(all.map(view=>view.handle.ready));await tick();
  assert.equal(N.roots(),88);assert.equal(active.size,88);assert.equal(discoveries,1);assert.equal(callbacks.size,1);assert.equal(loads,0);
  for(const view of all)assert.equal(view.box.querySelector('[data-thread-find-target]').textContent,'body '+view.id);
  const bodies=all.map(view=>view.box.querySelector('[data-thread-find-target]'));
  for(const view of all){view.handle.setScrollPosition({top:61,left:-5});view.handle.update({readOnly:false,trackReadState:true});}await tick();
  for(let index=0;index<all.length;index++){assert.equal(all[index].box.querySelector('[data-thread-find-target]'),bodies[index]);assert.deepEqual(plain(all[index].handle.getScrollPosition()),{top:61,left:-5});}
  assert.equal(N.roots(),88);assert.equal(active.size,88);
  assert.throws(()=>first.session.mountTranscript(a[0].box,{threadId:'duplicate-thread'}),{code:'invalid_argument'});
  const reused=a[32];reused.handle.dispose();assert.equal(reused.box.childNodes.length,0);reused.handle=first.session.mountTranscript(reused.box,{threadId:'many-reused-container'});await reused.handle.ready;
  assert.equal(reused.box.querySelector('[data-thread-find-target]').textContent,'body many-reused-container');assert.equal(active.size,88);assert.equal(N.roots(),89);
  first.ctx.retire();assert.equal(active.size,40);assert.equal(callbacks.size,1);for(const view of a)assert.equal(view.box.childNodes.length,0);assert.throws(()=>first.session.mountTranscript(a[0].box,{threadId:'after-owner-retirement'}),{code:'workspace_retired'});
  for(const view of b)assert.equal(view.box.querySelector('[data-thread-find-target]'),bodies[48+b.indexOf(view)]);
  second.ctx.retire();assert.equal(active.size,0);assert.equal(callbacks.size,0);for(const view of all)assert.equal(view.box.childNodes.length,0);assert.equal(f.document.querySelectorAll('[data-codlet-workspace-owned]').length,0);
});

test('retiring more than 32 pending transcripts cancels queued history without late roots',async t=>{
  const f=fixture(t),N=native(f),owner=f.connect(),callbacks=new Set(),finishes=[];let loads=0;
  N.manager={getConversation:()=>({resumeState:'needs_resume'}),loadBackgroundThreadHistoryPage(){loads++;return new Promise(resolve=>finishes.push(resolve));},loadRemainingTurnItems(){assert.fail('retired reads must not hydrate further items');},addConversationStateCallback(fn){callbacks.add(fn);return()=>callbacks.delete(fn);}};
  f.discovery.transcript=async()=>N;
  const views=Array.from({length:40},(_,index)=>{const box=f.document.createElement('div');f.document.body.append(box);return{box,handle:owner.session.mountTranscript(box,{threadId:'queued-many-'+index})};});
  const settled=Promise.allSettled(views.map(view=>view.handle.ready));await tick();assert.equal(loads,2);assert.equal(N.roots(),0);
  owner.ctx.retire();for(const finish of finishes)finish();const result=await settled;await tick();
  assert.ok(result.every(value=>value.status==='rejected'&&value.reason.code==='workspace_retired'));assert.equal(loads,2);assert.equal(N.roots(),0);assert.equal(callbacks.size,0);for(const view of views)assert.equal(view.box.childNodes.length,0);
});

test('different cold read-only transcripts hydrate full turn items without resume, navigation or active stream interests',async t=>{
  const f=fixture(t),N=native(f),owner=f.connect(),callbacks=new Set(),threads=new Map(),requests=[],interests=[];
  let running=0,peak=0;
  for(const id of ['cold-one','cold-two','cold-three','cold-empty'])threads.set(id,{id,resumeState:'needs_resume',turns:[],streamRole:'none'});
  N.manager={getConversation:id=>threads.get(id),getStreamRole:id=>({role:threads.get(id).streamRole}),
    async loadBackgroundThreadHistoryPage(id){running++;peak=Math.max(peak,running);requests.push(['history',id]);await tick();const thread=threads.get(id);thread.turns=id==='cold-empty'?[]:[{items:[{type:'fileChange'}],itemsPagination:{hasLoadedOldest:false}}];return 'more';},
    async loadRemainingTurnItems(id){requests.push(['items',id]);await tick();threads.get(id).body=id==='cold-empty'?'':'full native body '+id;running--;for(const callback of callbacks)callback(id);},
    resumeConversation(){assert.fail('read-only mounting must not resume a task');},sendRequest(){assert.fail('read-only mounting must use the existing history read APIs');},
    addConversationStateCallback(fn){callbacks.add(fn);return()=>callbacks.delete(fn);}};
  N.Scope=({children})=>children;N.composerScope={};N.composerValue=route=>({id:route.conversationId});N.ThreadSubscription=()=>null;
  N.Content=({conversationId,retainActiveInterest})=>{interests.push([conversationId,retainActiveInterest]);return N.React.createElement('div',{className:'thread-scroll-container'},N.React.createElement('div',{'data-thread-find-target':'conversation'},threads.get(conversationId).body));};
  f.discovery.transcript=async()=>N;
  const states=[],handles=[...threads.keys()].map(id=>{const box=f.document.createElement('div');f.document.body.append(box);return owner.session.mountTranscript(box,{threadId:id,onState:state=>states.push([id,state.phase])});});
  await Promise.all(handles.map(handle=>handle.ready));assert.equal(peak,2);assert.equal(requests.length,8);assert.equal(f.navigator.location.pathname,'/local/thread-a');
  assert.deepEqual([...threads.values()].map(thread=>[thread.resumeState,thread.streamRole]),Array.from({length:4},()=>['needs_resume','none']));
  assert.ok(interests.every(([,active])=>active===false));assert.equal(states.filter(([,phase])=>phase==='ready').length,4);
  assert.equal(callbacks.size,1);assert.equal(N.roots(),4);owner.ctx.retire();assert.equal(callbacks.size,0);
});

test('main route switches retain ready transcript roots, providers, subscriptions, body and scroll',async t=>{
  const f=fixture(t),N=native(f),owner=f.connect();let mounts=0,unmounts=0,loads=0;const phases=[];
  N.manager={getConversation:()=>({resumeState:'resumed',turns:[{}]}),loadBackgroundThreadHistoryPage(){loads++;},addConversationStateCallback:()=>()=>{}};
  N.Scope=({children})=>children;N.composerScope={};N.composerValue=route=>({id:route.conversationId});N.ThreadSubscription=()=>null;
  N.Content=({conversationId})=>{N.React.useEffect(()=>{mounts++;return()=>unmounts++;},[]);return N.React.createElement('div',{className:'thread-scroll-container'},N.React.createElement('div',{'data-thread-find-target':'conversation'},'preserved '+conversationId));};f.discovery.transcript=async()=>N;
  const slot=owner.session.createSlot('workspace.overlay'),box=f.document.createElement('div');slot.container.append(box);const handle=owner.session.mountTranscript(box,{threadId:'cached-one',onState:value=>phases.push(value.phase)});await handle.ready;await tick();
  const scroller=box.querySelector('.thread-scroll-container'),body=box.querySelector('[data-thread-find-target]');handle.setScrollPosition({top:-37,left:4});
  for(const id of ['thread-b','thread-c','thread-a']){f.navigator.location.pathname='/local/'+id;f.document.querySelector('nav').append(f.document.createElement('span'));await f.flush();}
  assert.equal(N.roots(),1);assert.equal(mounts,1);assert.equal(unmounts,0);assert.equal(loads,0);assert.equal(box.querySelector('.thread-scroll-container'),scroller);assert.equal(box.querySelector('[data-thread-find-target]'),body);assert.deepEqual(plain(handle.getScrollPosition()),{top:-37,left:4});assert.deepEqual(phases,['loading','ready']);
  const lease=owner.session.acquireSurface({hideBody:true});assert.equal(slot.container.isConnected,true);assert.equal(slot.container.closest('[inert]'),null);lease.dispose();
});

test('transcript identities override captured thread, route and composer scopes and stay stable across main navigation',async t=>{
  const f=fixture(t),N=native(f),R=N.React,h=R.createElement,owner=f.connect();
  const thread=R.createContext({clientThreadId:'local:original-primary'}),route=R.createContext({conversationId:'original-primary'}),composer=R.createContext(null);
  N.ThreadScope={};N.RouteScope={};N.composerScope={};
  N.Scope=({scope,value,children})=>h((scope===N.ThreadScope?thread:scope===N.RouteScope?route:composer).Provider,{value},children);
  N.routeDescription=({pathname,search})=>({pathname,search,routeKind:'local-thread',conversationId:pathname.slice('/local/'.length)});
  N.composerValue=value=>({conversationId:value.conversationId,clientThreadId:'local:'+value.conversationId});
  N.ThreadSubscription=()=>null;N.manager={getConversation:()=>({resumeState:'resumed',turns:[{}]}),addConversationStateCallback:()=>()=>{}};
  N.Content=({conversationId})=>h('div',{className:'thread-scroll-container'},h('div',{'data-thread-find-target':'conversation','data-context':JSON.stringify([R.useContext(thread).clientThreadId,R.useContext(route).conversationId,R.useContext(composer).conversationId])},'body '+conversationId));
  f.discovery.transcript=async()=>N;
  const views=['scope-first','scope-second'].map(id=>{const box=f.document.createElement('div');f.document.body.append(box);return{id,box,handle:owner.session.mountTranscript(box,{threadId:id})};});
  await Promise.all(views.map(view=>view.handle.ready));const bodies=views.map(view=>view.box.querySelector('[data-context]'));
  for(const view of views)assert.deepEqual(JSON.parse(view.box.querySelector('[data-context]').dataset.context),['local:'+view.id,view.id,view.id]);
  f.navigator.location.pathname='/local/another-primary';f.document.querySelector('nav').append(f.document.createElement('span'));await f.flush();
  for(let i=0;i<views.length;i++){assert.equal(views[i].box.querySelector('[data-context]'),bodies[i]);assert.deepEqual(JSON.parse(bodies[i].dataset.context),['local:'+views[i].id,views[i].id,views[i].id]);}
});

test('shadow transcripts reuse Native styles, stream within their root, retain scroll and retire their resources',async t=>{
  const f=fixture(t,{transcriptIsolation:true}),N=native(f),owner=f.connect(),sheet=f.document.createElement('link');sheet.rel='stylesheet';sheet.href='app://-/assets/native-fixture.css';f.document.head.append(sheet);
  const callbacks=new Set(),listeners=new Set();let text='initial native token',effects=0;
  N.manager={getConversation:()=>({resumeState:'resumed',turns:[{}]}),addConversationStateCallback:fn=>{callbacks.add(fn);return()=>callbacks.delete(fn);}};
  N.Scope=({children})=>children;N.composerScope={};N.composerValue=()=>({});N.ThreadSubscription=()=>null;
  N.Content=()=>{const body=N.React.useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn);},()=>text);N.React.useEffect(()=>{effects++;return()=>effects--;},[]);return N.React.createElement('div',{className:'thread-scroll-container'},N.React.createElement('div',{'data-thread-find-target':'conversation'},body));};f.discovery.transcript=async()=>N;
  const box=f.document.createElement('div');f.document.body.append(box);const states=[],handle=owner.session.mountTranscript(box,{threadId:'shadow-thread',onState:value=>states.push(value.phase)});await tick();
  const host=box.firstElementChild,root=host.shadowRoot;assert.ok(root);root.querySelector('link').dispatchEvent(new f.window.Event('load'));await handle.ready;await tick();
  assert.equal(box.querySelector('.thread-scroll-container'),null);const scroller=root.querySelector('.thread-scroll-container'),body=root.querySelector('[data-thread-find-target]');handle.setScrollPosition({top:-43,left:7});let outside=0;const observer=new f.window.MutationObserver(records=>outside+=records.length);observer.observe(f.document.body,{childList:true,subtree:true,characterData:true});
  text='streamed native token';for(const fn of listeners)fn();await tick();await tick();assert.equal(body.textContent,text);assert.equal(outside,0);
  handle.update({readOnly:false});await tick();assert.equal(root.querySelector('.thread-scroll-container'),scroller);assert.equal(root.querySelector('[data-thread-find-target]'),body);assert.deepEqual(plain(handle.getScrollPosition()),{top:-43,left:7});assert.deepEqual(states,['loading','ready']);assert.equal(N.roots(),1);
  sheet.media='print';await tick();assert.equal(root.querySelector('link').media,'print');const consumerSheet=f.document.createElement('link');consumerSheet.rel='stylesheet';consumerSheet.href='codlet://consumer/theme.css';f.document.head.append(consumerSheet);await tick();assert.equal(root.querySelectorAll('link').length,1);
  observer.disconnect();owner.ctx.retire();assert.equal(effects,0);assert.equal(callbacks.size,0);assert.equal(listeners.size,0);assert.equal(root.querySelectorAll('link').length,0);assert.equal(host.isConnected,false);
});

test('retiring a shadow transcript before styles load cancels readiness before creating a Native root',async t=>{
  const f=fixture(t,{transcriptIsolation:true}),N=native(f),owner=f.connect(),sheet=f.document.createElement('link');sheet.rel='stylesheet';sheet.href='app://-/assets/native-fixture.css';f.document.head.append(sheet);
  N.manager={getConversation:()=>({resumeState:'resumed'}),addConversationStateCallback:()=>()=>{}};f.discovery.transcript=async()=>N;
  const box=f.document.createElement('div');f.document.body.append(box);const handle=owner.session.mountTranscript(box,{threadId:'shadow-thread'});await tick();const root=box.firstElementChild.shadowRoot;assert.equal(root.querySelectorAll('link').length,1);owner.ctx.retire();await assert.rejects(handle.ready,{code:'workspace_retired'});await tick();assert.equal(N.roots(),0);assert.equal(root.querySelectorAll('link').length,0);
});

test('shadow style discovery fails closed when Native resources are absent',t=>{
  const f=fixture(t),wrapper=f.document.createElement('div');f.document.body.append(wrapper);const isolation=createTranscriptIsolation({document:f.document,report(){}});assert.throws(()=>isolation.create(wrapper),{code:'workspace_transcript_styles_unavailable'});isolation.dispose();
});

test('activity slots and native actions live outside the native tooltip trigger, preserve controls and retire with the owner',async t=>{
  const f=fixture(t),N=native(f),owner=f.connect(),button=f.document.getElementById('activity'),toolbar=button.parentElement,group=f.document.createElement('div'),trigger=f.document.createElement('span');
  toolbar.insertBefore(group,button);group.append(trigger);trigger.append(button);
  const ownerFiber=button.__reactFiber$fixture;
  f.attach(button,{},f.attach(trigger,{},f.attach(group,{},ownerFiber)));
  const slot=owner.session.createSlot('activity.before');assert.equal(slot.container.parentElement,toolbar);assert.equal(slot.container.nextElementSibling,group);assert.equal(trigger.contains(slot.container),false);
  N.Button=props=>N.React.createElement('button',props);N.Tooltip=({tooltipContent,shortcut,children})=>N.React.createElement('span',{'data-native-tooltip':tooltipContent,'data-native-shortcut':shortcut},children);f.discovery.action=async()=>N;
  let invoked=0;const action=owner.session.registerAction({id:'generic-action',label:'Generic action',icon:{paths:['M0 0 H24 V24 H0 Z']},shortcut:'Ctrl+K',onInvoke(){invoked++;}});await action.ready;
  const actionButton=f.document.querySelector('[data-codlet-workspace-action]');assert.equal(trigger.contains(actionButton),false);assert.equal(actionButton.getAttribute('aria-label'),'Generic action');assert.equal(actionButton.querySelector('svg').getAttribute('fill'),'currentColor');actionButton.click();assert.equal(invoked,1);
  await new Promise(resolve=>{const observer=new f.window.MutationObserver(()=>{if(actionButton.getAttribute('aria-pressed')==='true'){observer.disconnect();resolve();}});observer.observe(actionButton,{attributes:true});action.update({pressed:true,disabled:true});});assert.equal(actionButton.getAttribute('aria-pressed'),'true');actionButton.click();assert.equal(invoked,1);assert.equal(trigger.querySelectorAll('button').length,1);
  owner.ctx.retire();assert.equal(f.document.querySelector('[data-codlet-workspace-action]'),null);assert.throws(()=>action.update({pressed:false}),{code:'workspace_retired'});
});

test('independent action registrations retry preparation and keep each successful handle on its original components',async t=>{
  const f=fixture(t),N=native(f),owner=f.connect();let mode=0,loads=0,invoked=0;
  const button=label=>props=>N.React.createElement('button',{...props,'data-component-owner':label});
  const firstButton=button('first'),secondButton=button('second'),Tooltip=({children})=>children;
  f.discovery.action=async()=>{loads++;if(!mode)throw Object.assign(new Error('No rail in current layout'),{code:'workspace_action_unavailable'});return{...N,Button:mode===1?firstButton:secondButton,Tooltip};};
  const create=id=>owner.session.registerAction({id,label:id,icon:{paths:['M0 0 H24 V24 H0 Z']},onInvoke(){invoked++;}});
  const failed=create('failed-before-rail');await assert.rejects(failed.ready,{code:'workspace_action_unavailable'});
  mode=1;const first=create('first-action');await first.ready;
  mode=2;const second=create('second-action');await second.ready;
  first.update({pressed:true});await f.flush();
  const firstControl=f.document.querySelector('[data-codlet-workspace-action="first-action"]'),secondControl=f.document.querySelector('[data-codlet-workspace-action="second-action"]');
  assert.equal(firstControl.dataset.componentOwner,'first');assert.equal(secondControl.dataset.componentOwner,'second');
  assert.equal(f.document.querySelector('[data-codlet-workspace-action="failed-before-rail"]'),null);
  assert.equal(loads,3);assert.equal(invoked,0);firstControl.click();secondControl.click();assert.equal(invoked,2);
  await assert.rejects(failed.ready,{code:'workspace_action_unavailable'});
  owner.ctx.retire();assert.equal(f.document.querySelector('[data-codlet-workspace-action]'),null);
});

test('native actions wait for a missing activity toolbar, reuse their root after returning, and cancel pending readiness',async t=>{
  const f=fixture(t),N=native(f),owner=f.connect(),button=f.document.getElementById('activity'),toolbar=button.parentElement;
  N.Button=props=>N.React.createElement('button',props);N.Tooltip=({children})=>children;f.discovery.action=async()=>N;
  button.remove();await f.flush();let settled=false;
  const action=owner.session.registerAction({id:'late-action',label:'Late action',icon:{paths:['M0 0 H24 V24 H0 Z']},onInvoke(){}});action.ready.then(()=>{settled=true;});await tick();await f.flush();assert.equal(settled,false);assert.equal(N.roots(),0);
  toolbar.append(button);await f.flush();await action.ready;const control=f.document.querySelector('[data-codlet-workspace-action="late-action"]');assert.ok(control);assert.equal(N.roots(),1);
  button.remove();await f.flush();toolbar.append(button);await f.flush();assert.equal(f.document.querySelector('[data-codlet-workspace-action="late-action"]'),control);assert.equal(f.document.querySelectorAll('[data-codlet-workspace-action="late-action"]').length,1);assert.equal(N.roots(),1);
  button.remove();await f.flush();const pending=owner.session.registerAction({id:'cancelled-action',label:'Cancelled action',icon:{paths:['M0 0 H24 V24 H0 Z']},onInvoke(){}});await tick();pending.dispose();await assert.rejects(pending.ready,{code:'workspace_retired'});toolbar.append(button);await f.flush();assert.equal(f.document.querySelector('[data-codlet-workspace-action="cancelled-action"]'),null);assert.equal(N.roots(),1);
});

test('a workspace action reflects its own state without inheriting the activity filter color',async t=>{
  const f=fixture(t),N=native(f),owner=f.connect(),activity=f.document.getElementById('activity');
  activity.dataset.color='info';activity.setAttribute('aria-pressed','true');
  N.Button=({color,selected,...props})=>N.React.createElement('button',{...props,'data-color':color,'data-selected':String(selected)});
  N.Tooltip=({children})=>children;f.discovery.action=async()=>N;
  const action=owner.session.registerAction({id:'independent-action',label:'Independent',icon:{paths:['M0 0 H24 V24 H0 Z']},onInvoke(){}});await action.ready;
  const control=f.document.querySelector('[data-codlet-workspace-action]');
  assert.equal(control.dataset.color,'secondary');assert.equal(control.dataset.selected,'false');
  action.update({pressed:true});await f.flush();
  assert.equal(control.dataset.color,'secondary');assert.equal(control.dataset.selected,'true');
  assert.equal(activity.dataset.color,'info');assert.equal(activity.getAttribute('aria-pressed'),'true');
});

test('Native removal of only an owned action span restores its placement without creating another root',async t=>{
  const f=fixture(t),N=native(f),owner=f.connect();N.Button=props=>N.React.createElement('button',props);N.Tooltip=({children})=>children;f.discovery.action=async()=>N;
  let invoked=0;const action=owner.session.registerAction({id:'rebuilt-action',label:'Rebuilt action',icon:{paths:['M0 0 H24 V24 H0 Z']},onInvoke(){invoked++;}});await action.ready;
  const button=f.document.querySelector('[data-codlet-workspace-action]'),container=button.closest('[data-codlet-workspace-owned]');container.remove();await tick();
  assert.equal(container.isConnected,true);assert.equal(f.document.querySelector('[data-codlet-workspace-action]'),button);assert.equal(N.roots(),1);button.click();assert.equal(invoked,1);
});

test('action placement rebinds Native provider values after its anchor is replaced',async t=>{
  const f=fixture(t),N=native(f),owner=f.connect(),old=f.document.getElementById('activity'),Context=N.React.createContext('missing');
  old.__reactFiber$fixture.dependencies={firstContext:{context:Context,memoizedValue:'old-context'}};
  N.Button=props=>N.React.createElement('button',{...props,'data-context':N.React.useContext(Context)});N.Tooltip=({children})=>children;f.discovery.action=async()=>N;
  const action=owner.session.registerAction({id:'rebound-action',label:'Rebound action',icon:{paths:['M0 0 H24 V24 H0 Z']},onInvoke(){}});await action.ready;
  const control=f.document.querySelector('[data-codlet-workspace-action]');assert.equal(control.dataset.context,'old-context');
  const next=old.cloneNode(true);f.attach(next,{...old.__reactFiber$fixture,dependencies:{firstContext:{context:Context,memoizedValue:'new-context'}}},old.__reactFiber$fixture.return);old.replaceWith(next);await f.flush();await tick();
  assert.equal(f.document.querySelector('[data-codlet-workspace-action]'),control);assert.equal(control.dataset.context,'new-context');assert.equal(N.roots(),1);
});

test('direct navigation separates same-renderer execution from confirmed input ownership and never bypasses cancellation',async t=>{
  let binding={threadId:'thread-a',hostId:'local',submitDisabled:false};const f=fixture(t,{navigationBinding:()=>binding}),owner=f.connect(),calls=[];
  f.navigator.push=path=>{calls.push(path);f.navigator.location.pathname=path;};
  f.discovery.navigation=async()=>({manager:{getConversation:id=>({id,hostId:'local',resumeState:'resumed'}),getStreamRole:()=>({role:'owner'}),sendRequest(){assert.fail('cached direct navigation must not make a Core or metadata request');}}});
  const navigation=owner.session.createNavigation();await navigation.ready;const signal=new f.window.AbortController(),first=navigation.open({threadId:'thread-b'},{signal:signal.signal});
  assert.deepEqual(calls,['/local/thread-b'],'execute the cached route before returning to the caller');assert.equal((await first.executed).threadId,'thread-b');assert.equal(owner.session.getSnapshot().threadId,'thread-b');let committed=false;first.committed.then(()=>committed=true,()=>{});await tick();assert.equal(committed,false);
  assert.throws(()=>navigation.open({threadId:42}),{code:'invalid_argument'});assert.throws(()=>navigation.open({threadId:'thread-c'},{signal:{}}),{code:'invalid_argument'});
  const cancelled=new f.window.AbortController();cancelled.abort();const invalid=navigation.open({threadId:'thread-c'},{signal:cancelled.signal});await assert.rejects(invalid.executed,{code:'invocation_cancelled'});assert.equal(calls.length,1);
  binding={threadId:'thread-b',hostId:'local',submitDisabled:false};f.document.querySelector('main').append(f.document.createElement('span'));await f.flush();assert.equal((await first.committed).threadId,'thread-b');
  const second=navigation.open({threadId:'thread-c'});await second.executed;const third=navigation.open({threadId:'thread-d'});await assert.rejects(second.committed,{code:'workspace_navigation_superseded'});await third.executed;owner.ctx.retire();await assert.rejects(third.committed,{code:'workspace_retired'});assert.throws(()=>navigation.open({threadId:'thread-e'}),{code:'workspace_retired'});
});

test('a cancelled cold read cannot navigate after a newer operation stays on the current task',async t=>{
  const f=fixture(t,{navigationBinding:()=>({threadId:'thread-a',hostId:'local',submitDisabled:false})}),owner=f.connect(),calls=[];let release;
  f.navigator.push=path=>{calls.push(path);f.navigator.location.pathname=path;};
  f.discovery.navigation=async()=>({manager:{getConversation:id=>id==='thread-a'?{id,hostId:'local',resumeState:'resumed'}:null,sendRequest:()=>new Promise(resolve=>{release=resolve;})}});
  const navigation=owner.session.createNavigation();await navigation.ready;const old=navigation.open({threadId:'uncached-cold'});assert.equal(typeof release,'function');
  const current=navigation.open({threadId:'thread-a'});await assert.rejects(old.executed,{code:'workspace_navigation_superseded'});assert.equal((await current.executed).threadId,'thread-a');await current.committed;
  release({thread:{id:'uncached-cold'}});await tick();await tick();assert.deepEqual(calls,[]);assert.equal(f.navigator.location.pathname,'/local/thread-a');
});

test('navigation queues one frame, cancels all pending work and observes mutations only while confirmation is pending',async t=>{
  let bindings=0;const f=fixture(t,{navigationBinding:()=>{bindings++;return{threadId:'thread-a',hostId:'local',submitDisabled:false};}}),owner=f.connect(),frames=new Map(),active=new Set(),original=f.window.MutationObserver;let next=0;
  f.window.requestAnimationFrame=callback=>{frames.set(++next,callback);return next;};f.window.cancelAnimationFrame=id=>frames.delete(id);
  f.window.MutationObserver=class{constructor(callback){this.inner=new original(callback);}observe(...args){active.add(this);this.inner.observe(...args);}disconnect(){active.delete(this);this.inner.disconnect();}};
  f.navigator.push=path=>{f.navigator.location.pathname=path;};f.discovery.navigation=async()=>({manager:{getConversation:id=>({id,resumeState:'resumed'})}});
  const navigation=owner.session.createNavigation();await navigation.ready;assert.equal(active.size,0);const signal=new f.window.AbortController(),op=navigation.open({threadId:'thread-b'},{signal:signal.signal});await op.executed;await tick();assert.equal(active.size,1);
  for(let i=0;i<100;i++)f.document.getElementById('body').append(f.document.createElement('span'));await tick();assert.equal(frames.size,1);
  signal.abort();await assert.rejects(op.committed,{code:'invocation_cancelled'});assert.equal(active.size,0);assert.equal(frames.size,0);const count=bindings;
  for(let i=0;i<100;i++)f.document.getElementById('body').append(f.document.createElement('span'));await tick();assert.equal(bindings,count);
});

test('cold item hydration errors reject readiness; retirement after background hydration cancels further reads',async t=>{
  for(const mode of ['error','retire']){
    const f=fixture(t),N=native(f),owner=f.connect(),thread={resumeState:'needs_resume',turns:[{}]};let release,items=0;
    N.manager={getConversation:()=>thread,loadBackgroundThreadHistoryPage:()=>new Promise(resolve=>{release=resolve;}),
      async loadRemainingTurnItems(){items++;throw Object.assign(Error('native item read failed'),{code:'history_read_failed'});},addConversationStateCallback:()=>()=>{}};
    N.Scope=({children})=>children;N.composerScope={};N.composerValue=()=>({});N.ThreadSubscription=()=>null;N.Content=()=>null;f.discovery.transcript=async()=>N;
    const box=f.document.createElement('div');f.document.body.append(box);const handle=owner.session.mountTranscript(box,{threadId:'cold-failure'});await tick();
    if(mode==='retire')owner.ctx.retire();release('more');await assert.rejects(handle.ready,{code:mode==='retire'?'workspace_retired':'history_read_failed'});await tick();
    assert.equal(items,mode==='retire'?0:1);assert.equal(N.roots(),0);
  }
});

test('native shortcut capture/clear/restore/search and programmatic conflicts retain consumer ownership', async t => {
  const f = fixture(t), N = native(f), owner = f.connect(), changes = [], commands = new Map(); let invocations = 0;
  N.platform = 'windows'; N.keymap = () => ({ bindings: [] }); N.commands = [{ id: 'native.command', electron: { menuTitle: 'Native action' } }]; N.bindings = () => [{ accelerator: 'Ctrl+K' }];
  N.eventAccelerator = event => [...event.ctrlKey ? ['Ctrl'] : [], ...event.altKey ? ['Alt'] : [], ...event.shiftKey ? ['Shift'] : [], event.key].join('+');
  N.useCommand = (id, handler) => N.React.useEffect(() => { commands.set(id, handler); return () => commands.delete(id); }, [id, handler]);
  N.dispatchKeyboard = id => { commands.get(id)?.(); return commands.has(id); };
  N.Row = ({ label, control }) => N.React.createElement('section', null, label, control);
  N.Capture = props => N.React.createElement('div', null,
    N.React.createElement('button', { 'data-test-edit': '', onClick: () => props.onCapture('Ctrl+Alt+Shift+F10') }, 'edit'),
    N.React.createElement('button', { 'data-test-conflict': '', onClick: () => props.onCapture('Ctrl+K') }, 'conflict'),
    N.React.createElement('button', { 'data-test-clear': '', onClick: props.onClear }, 'clear'),
    N.React.createElement('button', { 'data-test-restore': '', disabled: !props.onReset, onClick: props.onReset }, 'restore'),
    props.conflict ? N.React.createElement('span', { role: 'alert' }, props.conflict) : null);
  const settings = f.document.createElement('div'); settings.className = '@container/keyboard-shortcuts'; const input = f.document.createElement('input'); settings.append(input); f.document.getElementById('root').append(settings);
  f.attach(input, { type: function Search() { return 'settings.keyboardShortcuts.search.placeholder'; } }, f.document.querySelector('[data-includes-composer]').__reactFiber$providers, 'settings');
  f.discovery.shortcuts = async () => N;
  const handle = owner.session.registerShortcut({ id: 'toggle', label: 'Toggle workspace', accelerator: 'Ctrl+Alt+Shift+F12', onInvoke() { invocations++; }, onChange(value) { changes.push(value); } }); await handle.ready; await tick();
  assert.equal(commands.size, 1); settings.querySelector('[data-test-conflict]').click(); await tick(); assert.equal(settings.querySelector('[role=alert]').textContent, 'Native action'); assert.equal(changes.length, 0);
  settings.querySelector('[data-test-edit]').click(); await tick(); assert.equal(handle.getSnapshot().accelerator, 'Ctrl+Alt+Shift+F10');
  settings.querySelector('[data-test-clear]').click(); await tick(); assert.equal(handle.getSnapshot().accelerator, null);
  f.document.body.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Control', ctrlKey: true, bubbles: true, cancelable: true }));
  assert.equal(invocations, 0, 'a modifier-only event cannot invoke a cleared shortcut');
  settings.querySelector('[data-test-restore]').click(); await tick(); assert.equal(handle.getSnapshot().accelerator, 'Ctrl+Alt+Shift+F12'); assert.deepEqual(changes, ['Ctrl+Alt+Shift+F10', null, 'Ctrl+Alt+Shift+F12']);
  assert.throws(() => handle.update({ accelerator: 'Ctrl+K' }), { code: 'shortcut_conflict' });
  f.document.body.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'F12', ctrlKey: true, altKey: true, shiftKey: true, bubbles: true, cancelable: true })); assert.equal(invocations, 1);
  input.value = 'no match'; input.dispatchEvent(new f.window.Event('input', { bubbles: true })); await tick(); assert.equal(settings.querySelector('[data-test-edit]'), null);
  owner.ctx.retire(); assert.equal(commands.size, 0); assert.equal(f.document.querySelectorAll('[data-codlet-workspace-owned]').length, 0);
});

test('lazy keymap discovery parses the original bounded declaration after Native memoizes its initializer, without evaluating source', () => {
  const source = 'function renamedInitializer(){return renamedInitializer=lazy(()=>{query=create(scope,"codex-command-keymap-state");derived=signal(scope,({get})=>{let {data:value}=get(query);return value?{...value,primaryNumberShortcutTarget:void 0}:value;});})();}export{derived as differentlyNamedKeymap}';
  assert.equal(keymapExport({ anything: () => {} }, source), 'differentlyNamedKeymap');
  assert.equal(keymapExport({}, source + '"codex-command-keymap-state"'), 'differentlyNamedKeymap');
  assert.deepEqual(assetReferences('import("./local-conversation-thread-NEW_HASH.js");"./local-conversation-thread-NEW_HASH.js";', 'app://-/assets/app-initial-anotherHash.js', 'local-conversation-thread'), ['app://-/assets/local-conversation-thread-NEW_HASH.js']);
});

test('opaque native source proxies fail closed and are inspected only once', () => {
  let reads = 0; const value = { get render() { reads++; throw Error('Opaque UIKit proxy'); } };
  assert.equal(componentSource(value), ''); assert.equal(componentSource(value), ''); assert.equal(reads, 1);
});

test('consumer retirement before native discovery resolves prevents late roots, listeners and history requests', async t => {
  const f = fixture(t), N = native(f), owner = f.connect(); let resolve, histories = 0, listeners = 0;
  N.manager = { getConversation() {}, loadBackgroundThreadHistoryPage() { histories++; }, addConversationStateCallback() { listeners++; return () => listeners--; } };
  f.discovery.transcript = () => new Promise(done => { resolve = done; });
  const box = f.document.createElement('div'); f.document.body.append(box);
  const handle = owner.session.mountTranscript(box, { threadId: 'thread-a' }); await tick(); owner.ctx.retire();
  await assert.rejects(handle.ready, { code: 'workspace_retired' }); resolve(N); await tick();
  assert.equal(N.roots(), 0); assert.equal(histories, 0); assert.equal(listeners, 0); assert.equal(box.childNodes.length, 0);
});

test('hidden native documents reconcile event bursts without animation-frame throttling or periodic timers', async t => {
  const f = fixture(t), owner = f.connect(); Object.defineProperty(f.document, 'visibilityState', { value: 'hidden', configurable: true });
  let changes = 0; owner.session.subscribe(() => changes++);
  f.navigator.location.pathname = '/local/thread-b';
  for (let i = 0; i < 40; i++) f.document.querySelector('nav').append(f.document.createElement('span'));
  await tick(); assert.equal(owner.session.getSnapshot().threadId, 'thread-b'); assert.equal(f.stats().frameCount, 0); assert.equal(changes, 2);
  owner.ctx.retire(); await tick(); assert.equal(f.frames.size, 0);
});
