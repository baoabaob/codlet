import { deferredNavigation } from '../../../../frontend/src/adapter/navigation.js';
import { createWorkspaceDiscovery, readWorkspaceAsset, assetReferences } from '../../../../frontend/src/adapter/workspace-discovery.js';
import { providersFor, wrapProviders, findWorkspaceSurface } from '../../../../frontend/src/adapter/workspace-dom.js';
import { uniqueExport, componentSource, currentAncestry } from '../../../../frontend/src/host-discovery.js';

const symbol = Symbol.for('codlet.workspace.composer.profile');
const capability = { name: 'codex.ui.workspace', api: 1, scope: 'target' };
let audit, workspace, discovery, base, slot, native;
const roots = new Set();
const pendingViews=new Set();
export function activate(context) {
  audit = { phase: 'connecting', inspect: () => ({ available: !!workspace && !workspace.getSnapshot().auxiliary, phase: audit.phase,result:audit.result }),run:async()=>audit.result=await run() };
  globalThis[symbol] = audit;
  context.rpc.request(capability, 'getApi', {}).then(access => {
    workspace = globalThis[Symbol.for(access.symbol)].connect(context, access.ticket);
    audit.phase = 'idle';
  }, error => { audit.phase = 'failed'; audit.error = error.message; });
  async function run() {
    audit.phase = 'preparing';
    const original = workspace.getSnapshot().threadId,originalInput=workspace.getSurface().composer?.element,originalEditable=workspace.getSurface().composer?.element.querySelector('[contenteditable="true"]'), samples = [], switches = [];
    try {
      const action=document.querySelector('[data-codlet-workspace-action="toggle"][aria-label="分屏工作台"]');if(action&&action.getAttribute('aria-pressed')!=='true')action.click();
      const panesStarted=performance.now();while(document.querySelectorAll('[data-codlet-workspace-owned] [data-thread-find-target="conversation"]').length<5&&performance.now()-panesStarted<10000)await new Promise(resolve=>setTimeout(resolve,100));
      base = deferredNavigation(context); discovery = createWorkspaceDiscovery(base.native); native = await discovery.transcript();
      const urls = assetReferences(await readWorkspaceAsset(native.initialUrl), native.initialUrl, 'local-conversation-thread');
      const candidates = await Promise.all(urls.map(async url => ({ url, source: await readWorkspaceAsset(url) })));
      const implementation = candidates.filter(x => x.source.includes('trackReadState') && x.source.includes('retainActiveInterest'));
      if (implementation.length !== 1) throw Error('A unique native conversation implementation is required');
      const module = await import(implementation[0].url);
      const Frame = uniqueExport(module, value => ['hideThreadContent', 'canInteract', 'shouldResume', 'threadAccess', 'hostMcpApps'].every(marker => componentSource(value).includes(marker)), 'independent native composer frame');
      const ThreadScope=uniqueExport(native.shared,value=>value?.__scopeBrand==='ThreadScope','thread scope'),RouteScope=uniqueExport(native.shared,value=>value?.__scopeBrand==='RouteScope','route scope');
      const routeDescription=uniqueExport(native.shared,value=>typeof value==='function'&&value.length===1&&['pathname','routeTemplate','local-thread','client-local-thread','routeKind','/extension/panel/new','new URLSearchParams'].every(marker=>componentSource(value).includes(marker)),'route description');
      const ids = ['01a11452-8e10-7570-9367-4e92d732bc28', '01a11452-7a06-76b3-af6c-062863252133',original].filter(id => native.manager.getConversation(id)?.resumeState === 'resumed');
      if (ids.length !== 3) throw Error('Three resumed local conversations are required');
      const surface = findWorkspaceSurface(document), providers = providersFor(surface.content);
      slot = workspace.createSlot('workspace.overlay');
      const holder = document.createElement('div'); holder.style.cssText = 'position:fixed;left:-17000px;top:0;width:600px;height:300px;'; holder.setAttribute('inert', ''); slot.container.append(holder);
      const views = [];
      for (const threadId of ids) {
        const wrapper = document.createElement('div'); wrapper.dataset.codletWorkspaceOwned = context.pluginId + ':' + context.generation;
        wrapper.style.cssText = 'width:600px;height:300px;display:flex;flex-direction:column;'; wrapper.setAttribute('inert', ''); holder.append(wrapper);
        const start = performance.now(), R = native.React, h = R.createElement;
        const view={threadId,wrapper,epoch:0,enabled:false};pendingViews.add(view);
        const root = native.Client.createRoot(wrapper, { onUncaughtError:error=>view.reject?.(error), onCaughtError:error=>view.reject?.(error) }); roots.add(root);
        view.stop=()=>{view.observer?.disconnect();view.observer=null;if(view.frame!=null)cancelAnimationFrame(view.frame);view.frame=null;};
        view.confirm=()=>{const binding=inspectBinding(wrapper);if(!binding)return;if(binding.threadId!==threadId){view.stop();view.reject(Object.assign(Error('Native composer activation binding mismatch'),{details:{binding,enabled:view.enabled,debug:debugBinding(wrapper,root)}}));return;}if(binding.disabled===view.enabled)return;view.stop();view.resolve(binding);};
        function Commit({epoch}) { R.useLayoutEffect(() => {if(epoch===view.epoch)view.confirm();}); return null; }
        const routeValue=routeDescription({pathname:'/local/'+threadId,search:'?codletComposer='+encodeURIComponent(context.pluginId+':'+context.generation+':'+threadId)});
        if(routeValue?.routeKind!=='local-thread'||routeValue.conversationId!==threadId)throw Error('Native rejected the isolated local route description');
        const threadValue={clientThreadId:native.composerValue(routeValue).clientThreadId};
        view.render=enabled=>{view.stop();view.enabled=enabled;const epoch=++view.epoch,ready=new Promise((resolve,reject)=>{view.resolve=resolve;view.reject=reject;});ready.catch(()=>{});view.observer=new MutationObserver(view.confirm);view.observer.observe(wrapper,{childList:true,subtree:true,attributes:true});const frame=()=>{view.frame=null;view.confirm();if(view.observer)view.frame=requestAnimationFrame(frame);};view.frame=requestAnimationFrame(frame);root.render(wrapProviders(native, providers, h(R.Suspense, { fallback: null }, h(native.Scope, { scope: ThreadScope, value:threadValue },h(native.Scope,{scope:RouteScope,value:routeValue}, h(Frame, {
          conversationId: threadId, hostId: 'local', canInteract: true, shouldResume: false,composerSubmitDisabled:!enabled, hideThreadContent: true, hostMcpApps: false, disableScrollToTop: true,
        }), h(Commit,{epoch}))))));return ready;};
        const ready=view.render(true);
        let timer;
        try { await Promise.race([ready, new Promise((_,fail) => { timer = setTimeout(() => fail(Object.assign(Error('Native independent composer commit timeout'),{details:debugBinding(wrapper,root)})), 10000); })]); }
        finally { clearTimeout(timer); }
        const binding = inspectBinding(wrapper), input = wrapper.querySelector('[data-codex-composer-root]'), editable = input?.querySelector('[contenteditable="true"]');
        const footer=input?.closest('[data-thread-scroll-footer]')??input?.closest('[data-thread-find-composer]')??input?.parentElement;wrapper.style.height='auto';holder.style.height='auto';const autoHeight=wrapper.getBoundingClientRect().height,footerHeight=footer?.getBoundingClientRect().height;
        samples.push({ threadId, readyMs: performance.now() - start, binding, input: !!input, editable: !!editable, bodyLength: wrapper.querySelector('[data-thread-find-target="conversation"]')?.textContent?.trim().length ?? 0,resumeState:native.manager.getConversation(threadId)?.resumeState,streamRole:native.manager.getStreamRole(threadId)?.role,autoHeight,footerHeight,originalEditorRetained:originalInput.contains(originalEditable),ownEditorDistinct:editable!==originalEditable });
        if (!input || !editable || binding?.threadId !== threadId) throw Error('The new native root did not bind its requested composer');
        Object.assign(view,{input,editable});views.push(view);
      }
      audit.phase = 'switching';
      holder.removeAttribute('inert');
      for (let repeat = 0; repeat < 3; repeat++) for (const selected of views) {
        const start = performance.now();
        for (const view of views) { view.wrapper.hidden = view !== selected; if (view === selected) view.wrapper.removeAttribute('inert'); else view.wrapper.setAttribute('inert', ''); }
        const binding = inspectBinding(selected.wrapper);
        const committedMs=performance.now()-start;selected.editable.focus({preventScroll:true});
        switches.push({ threadId: selected.threadId, durationMs: performance.now() - start,committedMs,focused:document.activeElement===selected.editable, retained: selected.wrapper.querySelector('[data-codex-composer-root]') === selected.input, binding,route:workspace.getSnapshot().threadId });
      }
      return { status: 'passed', original, samples, switches, routeUnchanged: workspace.getSnapshot().threadId === original,originalInputRetained:workspace.getSurface().composer?.element===originalInput,originalEditorRetained:originalInput.contains(originalEditable),distinctEditors:new Set(views.map(view=>view.editable)).size===views.length };
    } catch (error) { return { status: 'failed', phase: audit.phase, code: error.code, message: error.message,details:error.details, samples, switches, original, routeUnchanged: workspace.getSnapshot().threadId === original }; }
    finally { cleanup();originalInput?.querySelector('[contenteditable="true"]')?.focus({preventScroll:true}); audit.phase = 'done'; }
  }
}
function inspectBinding(wrapper) {
  const input = wrapper.querySelector('[data-codex-composer-root]');
  const containerKey = Object.keys(wrapper).find(key => key.startsWith('__reactContainer$')), container = wrapper[containerKey], current = container?.stateNode?.current ?? container;
  const key = input && Object.keys(input).find(key => key.startsWith('__reactFiber$')), attached = input?.[key];
  for (const fiber of [attached, attached?.alternate]) {
    if (fiber?.stateNode !== input) continue;
    const path = currentAncestry(fiber, current); if (!path) continue;
    for (const item of [...path].reverse()) {
      const props = item.memoizedProps ?? {}, source = componentSource(item.type);
      if (Object.hasOwn(props, 'composerSubmitDisabled') && Object.hasOwn(props, 'composerPresentation') && source.includes('composerSubmitDisabled') && source.includes('isThreadHistoryLoading'))
        return { threadId: props.conversationId, hostId: props.hostId, disabled: !!props.composerSubmitDisabled || !!props.isResuming || !!props.isThreadHistoryLoading };
    }
  }
  return null;
}
function debugBinding(wrapper,root){const input=wrapper.querySelector('[data-codex-composer-root]'),containerKey=Object.keys(wrapper).find(key=>key.startsWith('__reactContainer$')),container=wrapper[containerKey],current=container?.stateNode?.current??container,key=input&&Object.keys(input).find(key=>key.startsWith('__reactFiber$')),attached=input?.[key],raw=[];for(let item=attached,depth=0;item&&depth<90;item=item.return,depth++){const p=item.memoizedProps??{},source=componentSource(item.type);if(p.conversationId||Object.hasOwn(p,'composerSubmitDisabled')||source.includes('addSubmitHandler'))raw.push({depth,type:typeof item.type==='function'?item.type.name:item.type,threadId:p.conversationId,hostId:p.hostId,disabled:p.composerSubmitDisabled,presentation:Object.hasOwn(p,'composerPresentation'),history:p.isThreadHistoryLoading,keys:Object.keys(p).slice(0,25)});}return{inputs:wrapper.querySelectorAll('[data-codex-composer-root]').length,editable:wrapper.querySelectorAll('[contenteditable="true"]').length,containerKey,currentTag:current?.tag,sameRoot:current===root._internalRoot?.current,attached:!!attached,proved:currentAncestry(attached,current)?.size??0,raw};}
function cleanup() { for(const view of pendingViews)view.stop?.();pendingViews.clear();for (const root of roots) try { native.DOM.flushSync(() => root.unmount()); } catch {} roots.clear(); slot?.dispose(); slot = null; discovery?.dispose(); base?.dispose(); }
export function deactivate() { cleanup(); workspace?.dispose(); if (globalThis[symbol] === audit) delete globalThis[symbol]; }
