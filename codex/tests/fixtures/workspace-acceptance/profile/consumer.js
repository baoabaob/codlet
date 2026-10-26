import { composerBinding, findWorkspaceSurface, OWNED } from '../../../../frontend/src/adapter/workspace-dom.js';
import { localConnection } from '../../../../frontend/src/host-discovery.js';
import { deferredNavigation, locateHost } from '../../../../frontend/src/adapter/navigation.js';

const symbol = Symbol.for('codlet.workspace.navigation.profile');
const capability = { name: 'codex.ui.workspace', api: 1, scope: 'target' };
let audit, workspace, navigation, lease, base,restoreTransport;
export function activate(context) {
  audit = { phase: 'connecting', inspect: () => ({ available: !!navigation && !workspace.getSnapshot().auxiliary, phase: audit.phase, pendingClick:audit.pendingClick }), run };
  globalThis[symbol] = audit;
  context.rpc.request(capability, 'getApi', {}).then(access => {
    workspace = globalThis[Symbol.for(access.symbol)].connect(context, access.ticket);
    navigation = workspace.createNavigation();
    return navigation.ready;
  }).then(() => { audit.phase = 'idle'; }, error => { audit.phase = 'failed'; audit.error = error.message; });

  async function run({ threadIds = [], limit = 2, containBody = false, transport = 'direct' } = {}) {
    if (audit.phase !== 'idle') throw Error('Probe is not idle');
    audit.phase = 'running';
    const original = workspace.getSnapshot().threadId;
    if (!threadIds.length || threadIds.some(id => !/^[-\w]{8,256}$/u.test(id)) || new Set(threadIds).size !== threadIds.length) throw Error('Explicit owned synthetic threadIds required');
    const known = threadIds;
    const connection=localConnection(),manager=connection.manager,host=locateHost();
    const ids = known.filter(id => id !== original && manager.getConversation(id)).slice(0, limit);
    const samples = [], longTasks = [], requests=[],methodCounts={};
    const state=id=>({resumeState:manager.getConversation(id)?.resumeState??null,streamRole:manager.getStreamRole?.(id)?.role??'none'});
    const originalSend=connection.client.sendRequest;
    const captureSend=function(method,params,...rest){methodCounts[method]=(methodCounts[method]??0)+1;const entry=method==='thread/resume'?{method,threadId:params?.threadId??params?.conversationId,at:performance.now(),keys:Object.keys(params??{})}:null;if(entry)requests.push(entry);const result=Reflect.apply(originalSend,this,[method,params,...rest]);if(entry)Promise.resolve(result).then(()=>entry.completedAt=performance.now(),error=>{entry.failedAt=performance.now();entry.code=error?.code;});return result;};
    let native;
    if(transport==='flushSync'){base=deferredNavigation(context);native=await base.native();}
    workspace.getSnapshot();connection.client.sendRequest=captureSend;restoreTransport=()=>{if(connection.client.sendRequest===captureSend)connection.client.sendRequest=originalSend;};
    const bodyJournal = new Map();
    function contain() {
      const s = findWorkspaceSurface(document);
      if (!s?.composer) return;
      for (const node of s.scroller.children) {
        if (node === s.footer || node.contains(s.composer) || node.matches(OWNED) || bodyJournal.has(node)) continue;
        const rect = node.getBoundingClientRect();
        const properties = ['content-visibility', 'contain-intrinsic-size'];
        bodyJournal.set(node, properties.map(key => [key, node.style.getPropertyValue(key), node.style.getPropertyPriority(key)]));
        node.style.setProperty('contain-intrinsic-size', `auto ${rect.width}px auto ${rect.height}px`, 'important');
        node.style.setProperty('content-visibility', 'hidden', 'important');
      }
    }
    const containmentObserver = containBody ? new MutationObserver(contain) : null;
    if (containBody) { contain(); containmentObserver.observe(document.documentElement, { childList: true, subtree: true }); }
    const longObserver = new PerformanceObserver(list => { for (const e of list.getEntries()) longTasks.push({ start: e.startTime, duration: e.duration }); });
    try { longObserver.observe({ type: 'longtask', buffered: false }); } catch {}
    lease = workspace.acquireSurface({ composerEnabled: false });
    try {
      for (const id of [...ids, original]) samples.push(await sample(id));
      let control;try{const count=methodCounts['thread/read']??0;await context.rpc.request({name:'codex.backend.read',api:1,scope:'target'},'threads.get',{threadId:original});control={method:'thread/read',observed:(methodCounts['thread/read']??0)>count};}catch(error){control={error:error.message};}
      for (const e of longObserver.takeRecords()) longTasks.push({ start: e.startTime, duration: e.duration });
      return { status: samples.every(sample=>!sample.message)?'passed':'failed', samples, longTasks, requests,methodCounts,control,transport, containBody, containedNodes: bodyJournal.size, visibility: document.visibilityState, restored: host.navigator.location.pathname==='/local/'+original, snapshotThreadId:workspace.getSnapshot().threadId };
    } finally {
      longObserver.disconnect(); containmentObserver?.disconnect();
      for (const [node, fields] of bodyJournal) for (const [key, value, priority] of fields) { if (value) node.style.setProperty(key, value, priority); else node.style.removeProperty(key); }
      restoreTransport?.();restoreTransport=null;
      base?.dispose();base=null;lease?.dispose(); lease = null; audit.phase = 'idle';audit.pendingClick=null;
    }

    async function sample(threadId) {
      const start = performance.now(), events = [], costs = [];
      const before=state(threadId),requestStart=requests.length;
      const clickController=new AbortController();
      performance.mark('workspace-profile-open:' + threadId);
      let frame, timer, nativeTimer,frames = 0, timerChecks = 0, stopped = false, firstBindingMs = null, lastBinding,resolveNative,clickAt,trusted;
      function inspect(kind) {
        const at = performance.now();
        const surface = findWorkspaceSurface(document);
        const binding = composerBinding(document, surface?.composer), cost = performance.now() - at;
        costs.push(cost);
        const id = binding?.threadId ?? null;
        if (id === threadId && firstBindingMs == null) firstBindingMs = performance.now() - start;
        if(id===threadId&&host.navigator.location.pathname==='/local/'+threadId)resolveNative?.({threadId,hostId:'local',inputConfirmed:true});
        if (id !== lastBinding || events.length < 3) { events.push({ kind, ms: performance.now() - start, binding: id, disabled: binding?.submitDisabled }); lastBinding = id; }
      }
      function tick() { if (stopped) return; frames++; inspect('frame'); if (performance.now() - start < 5500 && frames < 340) frame = requestAnimationFrame(tick); }
      function timedTick() { if (stopped) return; timerChecks++; inspect('timer'); if (performance.now() - start < 5500 && timerChecks < 280) timer = setTimeout(timedTick, 20); }
      const mutations = { callbacks: 0, childList: 0, attributes: 0, characterData: 0 };
      const observer = new MutationObserver(records => { mutations.callbacks++; for (const r of records) mutations[r.type]++; inspect('mutation'); });
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-codex-composer-root', 'data-app-shell-active-page'] });
      let op;
      try {
        inspect('before');
        if(transport==='flushSync')native.DOM.flushSync(()=>{op=navigation.open({threadId});});
        else if(transport==='nativeClick'||transport==='trusted'){
          const row=[...document.querySelectorAll('[data-app-action-sidebar-thread-id]')].find(node=>node.getAttribute('data-app-action-sidebar-thread-id')==='local:'+threadId);
          if(!row)throw Error('The requested Native sidebar row is not mounted');
          const committed=new Promise((resolve,reject)=>{resolveNative=resolve;nativeTimer=setTimeout(()=>reject(Error('Native clicked composer confirmation timeout')),10000);});committed.catch(()=>{});
          row.addEventListener('click',event=>{clickAt=performance.now();trusted=event.isTrusted;audit.pendingClick=null;},{capture:true,once:true,signal:clickController.signal});
          if(transport==='trusted'){row.scrollIntoView({block:'nearest'});const rect=row.getBoundingClientRect();audit.pendingClick={threadId,x:rect.x+Math.min(rect.width/2,120),y:rect.y+rect.height/2};}
          else row.click();
          op={executed:Promise.resolve({threadId,status:state(threadId).resumeState==='resumed'?'opened':'opening',...state(threadId),synchronousMs:performance.now()-start}),committed,dispose(){clearTimeout(nativeTimer);}};
        }else op = navigation.open({ threadId });
        const syncMs = performance.now() - start;
        inspect('sync'); queueMicrotask(() => { if (!stopped) inspect('microtask'); });
        frame = requestAnimationFrame(tick);
        if (document.visibilityState === 'hidden') timer = setTimeout(timedTick, 20);
        const executed = await op.executed, executedMs = performance.now() - start;
        inspect('executed');
        const committed = await op.committed, committedMs = performance.now() - start;
        performance.mark('workspace-profile-committed:' + threadId);
        inspect('committed');
        return { threadId,before,after:state(threadId),requests:requests.slice(requestStart),executed,transport,trusted,clickDelayMs:clickAt==null?null:clickAt-start,fromClickMs:clickAt==null?null:performance.now()-clickAt, syncMs, executedMs, firstBindingMs, committedMs, discoveryDelayMs: firstBindingMs == null ? null : committedMs - firstBindingMs, frames, timerChecks, checks: costs.length, bindingCostTotalMs: costs.reduce((a,b) => a+b,0), bindingCostMaxMs: Math.max(...costs), events, mutations, receipt: committed, nativeSynchronousMs: executed.synchronousMs };
      } catch (error) { return { threadId, code: error.code, message: error.message, firstBindingMs, totalMs: performance.now() - start, frames, events, mutations }; }
      finally { stopped = true;audit.pendingClick=null;clickController.abort(); cancelAnimationFrame(frame); clearTimeout(timer); observer.disconnect(); op?.dispose(); }
    }
  }
}
export function deactivate() { restoreTransport?.();restoreTransport=null;base?.dispose();lease?.dispose(); navigation?.dispose(); workspace?.dispose(); if (globalThis[symbol] === audit) delete globalThis[symbol]; }
