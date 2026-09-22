'use strict';
// Experimental owned-lab Host probe, not a production plugin execution backend.
// The caller supplies an authenticated cdp.raw context and a private output dir.
const fs = require('node:fs');
const path = require('node:path');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function installBridge(createUI) {
  // This fixed world is exclusively owned by this experimental probe.
  globalThis.__codletContainerProbe?.close();
  let sequence = 0, live = null, stale = null;
  const counts = { accepted: 0, rejected: 0, clicks: 0, heartbeats: 0 };
  const workerSource = `
    const payload = new Uint8Array(8 * 1024 * 1024);
    for(let i=0;i<payload.length;i+=4096)payload[i]=1;
    let generation=0;
    onmessage=event=>{
      if(event.data.op==='init'){
        generation=event.data.generation;
        postMessage({op:'render',generation,title:'Container '+generation,dom:typeof document,bytes:payload.length});
      } else if(event.data.op==='click')postMessage({op:'clicked',generation});
    };
    setInterval(()=>postMessage({op:'heartbeat',generation,byte:payload[4096]}),10);
  `;
  const url = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
  const ownerRoot = document.createElement('div');
  ownerRoot.dataset.codletContainerProbe = 'owned';
  Object.assign(ownerRoot.style, { position: 'fixed', left: '-10000px', top: '0', width: '500px', height: '240px', contain: 'strict' });
  document.body.appendChild(ownerRoot);
  function retire() {
    const owner = live;
    if (!owner) return;
    live = null; owner.live = false;
    owner.worker.onmessage = owner.worker.onerror = null;
    owner.worker.terminate();
    try { owner.ui?.dispose(); } finally { owner.worker = owner.ui = owner.root = null; }
  }
  async function start(withUI) {
    if (live) throw Error('Previous owner is live');
    const owner = { generation: ++sequence, live: true, worker: null, ui: null, root: null, rendered: false, clicked: false, error: null };
    live = owner;
    if (withUI) {
      owner.ui = createUI({ pluginId: 'dev.container-probe', generation: owner.generation, onDeactivate: () => () => {}, i18n: { locale: 'en', onChange: () => () => {} }, reportDiagnostic: e => { owner.error = e.message; } });
      owner.root = owner.ui.container(ownerRoot);
    }
    let ready, failed;
    const completed = new Promise((resolve,reject)=>{ready=resolve;failed=reject;});
    const timeout=setTimeout(()=>failed(Error('Worker startup timed out')),5000);
    const dispatch = data => {
      // Identity is captured by the bridge, not accepted from the payload.
      if (!owner.live || live !== owner || data.generation !== owner.generation) { counts.rejected++; return false; }
      if (data.op === 'heartbeat') { counts.heartbeats++; return true; }
      if (data.op === 'clicked') { owner.clicked = true; counts.clicks++; ready(); return true; }
      if (data.op !== 'render' || typeof data.title !== 'string' || data.title.length > 100) { counts.rejected++; return false; }
      if (data.dom !== 'undefined' || data.bytes !== 8388608) throw Error('Worker contract failed');
      counts.accepted++;
      if (withUI) {
        const { React, components } = owner.ui, h = React.createElement;
        owner.ui.mount(owner.root, h('div', null,
          h(components.Button, { onClick: () => { if(owner.live)owner.worker.postMessage({op:'click'}); } }, data.title),
          h(components.Input, { defaultValue: 'Probe input', 'aria-label': 'Probe input' }),
          h(components.Switch, { defaultChecked: true, 'aria-label': 'Probe switch' })
        ));
        const button = owner.root.querySelector('button');
        if (!button || !owner.root.querySelector('input')) throw Error('Official controls were not mounted');
        button.click();
      } else owner.worker.postMessage({op:'click'});
      owner.rendered = true;
      return true;
    };
    try {
      owner.worker = new Worker(url);
      owner.worker.onmessage = event => { try { dispatch(event.data); } catch(error) { failed(error); } };
      owner.worker.onerror = event => { failed(Error(String(event.message))); event.preventDefault(); };
      owner.worker.postMessage({op:'init',generation:owner.generation});
      await completed; if(owner.error)throw Error(owner.error);
    }
    catch(error){retire();throw error;}
    finally{clearTimeout(timeout);}
    return { generation: owner.generation, dispatch };
  }
  async function cycle(withUI, count) {
    if (!Number.isInteger(count) || count < 1 || count > 20) throw Error('Invalid batch');
    const started = performance.now();
    for(let i=0;i<count;i++) { await start(withUI); retire(); }
    return { count, elapsedMs: performance.now()-started, sequence, ...counts };
  }
  async function revocation() {
    const before = counts.heartbeats;
    const first = await start(true); stale=first.dispatch;
    await new Promise(resolve=>setTimeout(resolve,150));
    const liveHeartbeatObserved=counts.heartbeats>before;
    retire();
    const afterRetire = counts.heartbeats;
    await new Promise(resolve=>setTimeout(resolve,100));
    const noLateHeartbeat = counts.heartbeats === afterRetire;
    const second = await start(true);
    const accepted = counts.accepted;
    const rejectedForgery = stale({op:'render',generation:second.generation,title:'Old code',dom:'undefined',bytes:8388608}) === false;
    const noOldUi = accepted === counts.accepted && !ownerRoot.textContent.includes('Old code');
    stale=null; retire();
    return { liveHeartbeatObserved, noLateHeartbeat, rejectedForgery, noOldUi, ...counts };
  }
  function frameCreate(id, sandboxed=false) {
    if(document.querySelector('[data-codlet-probe-frame]'))throw Error('Previous frame still exists');
    const frame=document.createElement('iframe'); frame.name=id; frame.dataset.codletProbeFrame=id;
    if(sandboxed)frame.setAttribute('sandbox','allow-scripts');
    frame.src='about:blank'; frame.hidden=true; ownerRoot.appendChild(frame);
    return true;
  }
  const api={ cycle, revocation, frameCreate, frameRemove(){ document.querySelector('[data-codlet-probe-frame]')?.remove(); },
    state:()=>({sequence,live:!!live,...counts,frames:ownerRoot.querySelectorAll('iframe').length,ui:ownerRoot.querySelectorAll('[data-codlet-official-ui]').length}),
    close(){retire();stale=null;ownerRoot.remove();URL.revokeObjectURL(url);delete globalThis.__codletContainerProbe;}
  };
  Object.defineProperty(globalThis,'__codletContainerProbe',{value:api,configurable:true});
  return {installed:true};
}

module.exports = function createProbe(ctx, folder, coreRoot) {
  const sessions=new Map();
  let targetId, sessionId, contextId, running=false, subscription;
  const defaultContexts=new Map();
  const req=(method,params={},sid=sessionId)=>ctx.cdp.request(method,params,{sessionId:sid});
  const append=(file,value)=>fs.appendFileSync(path.join(folder,file),JSON.stringify(value)+'\n');
  async function evaluate(expression, id=contextId) {
    const result=await req('Runtime.evaluate',{expression,contextId:id,awaitPromise:true,returnByValue:true});
    if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);
    return result.result?.value;
  }
  async function connect() {
    if(sessionId)return;
    const {targetInfos}=await ctx.cdp.request('Target.getTargets');
    const candidates=[];
    for(const target of targetInfos.filter(t=>t.type==='page'&&t.url.startsWith('app://-/index.html'))){
      const attached=await ctx.cdp.request('Target.attachToTarget',{targetId:target.targetId,flatten:true});
      sessions.set(target.targetId,attached.sessionId);
      await req('Performance.enable',{},attached.sessionId);
      const meta=await req('Runtime.evaluate',{expression:'({buttons:document.querySelectorAll("button").length,width:innerWidth,height:innerHeight,title:document.title})',returnByValue:true},attached.sessionId);
      candidates.push({targetId:target.targetId,sessionId:attached.sessionId,...meta.result?.value});
    }
    candidates.sort((a,b)=>b.buttons-a.buttons);
    if(!candidates.length||candidates[0].buttons<5)throw Error('No unambiguous owned main page');
    ({targetId,sessionId}=candidates[0]);
    // Enabling on a stressed page emits all existing contexts at once. Subscribe
    // afterward: only newly created fixture frames are relevant to this probe.
    await req('Runtime.enable');
    subscription=await ctx.cdp.subscribe({scope:'session',sessionId,methods:['Runtime.executionContextCreated','Runtime.executionContextDestroyed','Runtime.executionContextsCleared']},event=>{
      if(event.method==='Runtime.executionContextCreated'){
        const context=event.params?.context;
        if(context?.auxData?.isDefault)defaultContexts.set(context.auxData.frameId,context.id);
      }else if(event.method==='Runtime.executionContextsCleared')defaultContexts.clear();
      else for(const [frame,id]of defaultContexts)if(id===event.params?.executionContextId)defaultContexts.delete(frame);
    });
    const {frameTree}=await req('Page.getFrameTree');
    ({executionContextId:contextId}=await req('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:'codlet.prototype.container.bridge'}));
    const sdk=fs.readFileSync(path.join(coreRoot,'bundled/runtime/ui.js'),'utf8');
    await evaluate(`(${installBridge.toString()})((\n${sdk}\n))`);
    fs.writeFileSync(path.join(folder,'identity.json'),JSON.stringify({browser:await ctx.cdp.request('Browser.getVersion'),targetId,candidates},null,2));
  }
  async function checkpoint(label) {
    const rows=[];
    for(const [id,sid]of sessions){
      await req('HeapProfiler.collectGarbage',{},sid);
      const [metrics,dom,isolate]=await Promise.all([req('Performance.getMetrics',{},sid),req('Memory.getDOMCounters',{},sid),req('Runtime.getIsolateId',{},sid)]);
      rows.push({targetId:id,isolate:isolate.id,metrics:Object.fromEntries(metrics.metrics.map(x=>[x.name,x.value])),dom});
    }
    const targets=await ctx.cdp.request('Target.getTargets');
    const state=await evaluate('globalThis.__codletContainerProbe.state()');
    const value={label,utc:new Date().toISOString(),rows,workerTargets:targets.targetInfos.filter(t=>t.type==='worker').length,state};
    append('checkpoints.jsonl',value);
    const heaps=rows.filter((row,i)=>rows.findIndex(p=>p.isolate===row.isolate)===i).reduce((sum,row)=>sum+row.metrics.JSHeapUsedSize,0);
    if(heaps>900*1024*1024)throw Error('Bounded memory guard exceeded');
    return value;
  }
  async function frames(mode,count,prefix) {
    const parent=await req('Page.getFrameTree');
    for(let i=0;i<count;i++){
      const name=`codlet-probe-${prefix}-${i}`;
      fs.writeFileSync(path.join(folder,'phase.txt'),prefix+'-'+i);
      const sandboxed=['opaque-frame','opaque-default','isolated-frame-only'].includes(mode);
      await evaluate(`globalThis.__codletContainerProbe.frameCreate(${JSON.stringify(name)},${sandboxed})`);
      let frame;
      for(let attempt=0;attempt<30;attempt++){
        const tree=await req('Page.getFrameTree');
        frame=tree.frameTree.childFrames?.find(child=>child.frame.name===name)?.frame;
        if(frame)break;await wait(10);
      }
      if(!frame)throw Error('Probe frame was not observed');
      let executionContextId;
      if(mode==='opaque-default'){
        for(let attempt=0;attempt<30&&!defaultContexts.has(frame.id);attempt++)await wait(10);
        executionContextId=defaultContexts.get(frame.id);
        if(!executionContextId)throw Error('Default child context was not observed');
      }else ({executionContextId}=await req('Page.createIsolatedWorld',{frameId:frame.id,worldName:mode==='shared-isolated-frame'?'codlet.prototype.reusable-frame':`codlet.prototype.${prefix}.g${i}`}));
      const result=await evaluate(['parent-dom-frame','shared-isolated-frame'].includes(mode)
        ? '(()=>{const node=parent.document.createElement("div");parent.document.body.appendChild(node);node.remove();return {parentDom:true};})()'
        : mode==='isolated-frame-only'?'(()=>{globalThis.fixture=new Uint8Array(1024*1024);globalThis.fixture[0]=1;return {parentDom:false};})()'
        : '(()=>{globalThis.fixture=new Uint8Array(1024*1024);globalThis.fixture[0]=1;let parentDom;try{parentDom=!!parent.document.body;}catch{parentDom=false;}return {parentDom};})()',executionContextId);
      if(sandboxed&&result.parentDom)throw Error('Sandbox did not block parent DOM');
      await evaluate('globalThis.__codletContainerProbe.frameRemove()');
      if((i+1)%50===0){await wait(250);await checkpoint(`${prefix}-${i+1}`);}
    }
    return {count,parentFrame:parent.frameTree.frame.id};
  }
  async function sharedFrameRevocation(prefix) {
    const worldName='codlet.prototype.reusable-frame';
    const parent=await req('Page.getFrameTree');
    const {executionContextId:parentContext}=await req('Page.createIsolatedWorld',{frameId:parent.frameTree.frame.id,worldName});
    async function create(suffix){
      const name=prefix+'-'+suffix;
      await evaluate(`globalThis.__codletContainerProbe.frameCreate(${JSON.stringify(name)})`);
      const tree=await req('Page.getFrameTree');
      const frame=tree.frameTree.childFrames?.find(child=>child.frame.name===name)?.frame;
      if(!frame)throw Error('Fixture frame unavailable');
      return (await req('Page.createIsolatedWorld',{frameId:frame.id,worldName})).executionContextId;
    }
    try{
      const old=await create('old');
      await evaluate(`(()=>{const root=parent;root.__codletOldCapture=()=>{const next=root.document.querySelector('[data-codlet-probe-frame]');const api=next?.contentWindow?.__codletToyCapability;return typeof api==='function'?api():null;};return true;})()`,old);
      await evaluate('globalThis.__codletContainerProbe.frameRemove()');
      const current=await create('new');
      await evaluate(`globalThis.__codletToyCapability=()=>({generation:2,fixtureOnly:true});true`,current);
      const borrowed=await evaluate('globalThis.__codletOldCapture()',parentContext);
      return {oldContext:old,newContext:current,borrowedNewCapability:borrowed?.generation===2&&borrowed.fixtureOnly===true};
    }finally{
      await evaluate('delete globalThis.__codletOldCapture',parentContext);
      await evaluate('globalThis.__codletContainerProbe.frameRemove()');
    }
  }
  return {
    async run(command) {
      if(running)throw Error('Probe already busy');running=true;
      try{
        await connect();
        if(command.action==='checkpoint')return checkpoint(command.id);
        if(command.action==='worker'){
          if(![1,10,50,100,200,400].includes(command.count))throw Error('Invalid iteration count');
          const batches=[];
          for(let i=0;i<command.count;i+=10){
            fs.writeFileSync(path.join(folder,'phase.txt'),command.id+'-'+i);
            batches.push(await evaluate(`globalThis.__codletContainerProbe.cycle(${!!command.ui},${Math.min(10,command.count-i)})`));
            if((i+10)%50===0||i+10>=command.count){await wait(250);await checkpoint(command.id+'-'+Math.min(i+10,command.count));}
          }
          return {batches};
        }
        if(command.action==='revocation')return evaluate('globalThis.__codletContainerProbe.revocation()');
        if(command.action==='shared-frame-revocation')return sharedFrameRevocation(command.id);
        if(command.action==='frames'){
          if(!['opaque-frame','opaque-default','isolated-frame-only','shared-isolated-frame','parent-dom-frame'].includes(command.mode)||![1,50,100,200].includes(command.count))throw Error('Invalid frame scenario');
          return frames(command.mode,command.count,command.id);
        }
        if(command.action==='worlds'){
          if(![50,100].includes(command.count))throw Error('Invalid world count');
          const {frameTree}=await req('Page.getFrameTree');
          for(let i=0;i<command.count;i++)await req('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:`codlet.prototype.${command.id}.g${i}`});
          return checkpoint(command.id);
        }
        if(command.action==='close'){await evaluate('globalThis.__codletContainerProbe.close()');return {closed:true};}
        throw Error('Unknown action');
      }finally{running=false;}
    },
    async dispose(){
      if(contextId)try{await evaluate('globalThis.__codletContainerProbe?.close()');}catch{}
      try{await subscription?.unsubscribe();}catch{}
      for(const sid of sessions.values())try{await ctx.cdp.request('Target.detachFromTarget',{sessionId:sid});}catch{}
      sessions.clear();
    }
  };
};
