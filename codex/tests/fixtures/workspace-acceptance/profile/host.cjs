'use strict';
const fs = require('node:fs'), path = require('node:path');
let timer;
module.exports = { activate(context) { timer = setTimeout(async () => {
  let sessionId, tracing = false, subscription, streamReady;
  const report = { warnings: [] }, output = path.join(context.root, 'report.json');
  const mode = fs.existsSync(path.join(context.root,'mode.json')) ? JSON.parse(fs.readFileSync(path.join(context.root,'mode.json'),'utf8')) : {};
  const request = (method, params = {}) => context.cdp.request(method, params, { sessionId });
  try {
    const { targetInfos } = await context.cdp.request('Target.getTargets');
    for (const candidate of targetInfos.filter(t => t.type === 'page' && t.url === 'app://-/index.html')) {
      ({ sessionId } = await context.cdp.request('Target.attachToTarget', { targetId: candidate.targetId, flatten: true }));
      const state = await request('Runtime.evaluate', { expression: 'globalThis[Symbol.for("codlet.workspace.navigation.profile")]?.inspect()??null', returnByValue: true });
      if (state.result?.value?.available) { report.targetId = candidate.targetId; break; }
      await context.cdp.request('Target.detachFromTarget', { sessionId }); sessionId = null;
    }
    if (!sessionId) throw Error('An initialized main-window probe is required');
    if(mode.enterSplit){const opened=await request('Runtime.evaluate',{expression:'(async()=>{const button=document.querySelector("[data-codlet-workspace-action=toggle][aria-label=分屏工作台]");if(!button)throw Error("The native workbench action is unavailable");if(button.getAttribute("aria-pressed")!=="true")button.click();const start=performance.now();for(;;){const assigned=[...document.querySelectorAll("[data-codlet-workspace-owned]")].filter(node=>node.shadowRoot);const ready=assigned.filter(node=>node.shadowRoot.querySelector("[data-thread-find-target=conversation]"));if(ready.length>=5||performance.now()-start>8000)return{assigned:assigned.length,ready:ready.length,pressed:button.getAttribute("aria-pressed")};await new Promise(resolve=>setTimeout(resolve,100));}})()',awaitPromise:true,returnByValue:true});report.entered=opened.result?.value;report.enterException=opened.exceptionDetails;}
    const roots=await request('Runtime.evaluate',{expression:'(()=>{const roots=[...document.querySelectorAll("[data-codlet-workspace-owned]")].filter(node=>node.shadowRoot?.querySelector(".thread-scroll-container"));return{shadowRoots:roots.map(node=>({owner:node.dataset.codletWorkspaceOwned,bodyLength:node.shadowRoot.querySelector("[data-thread-find-target=conversation]")?.textContent.trim().length??0,styles:node.shadowRoot.querySelectorAll("link").length})),lightBodies:document.querySelectorAll("[data-thread-find-target=conversation]").length};})()',returnByValue:true});report.roots=roots.result?.value;
    if(mode.run===false){const handlers=await request('Runtime.evaluate',{expression:`(()=>{return[...document.querySelectorAll('[data-thread-title]')].filter(node=>!node.closest('[data-codlet-workspace-owned]')).slice(0,5).map(title=>{const node=title.closest('button')??title.closest('[data-app-action-sidebar-thread-id]')??title,key=Object.keys(node).find(k=>k.startsWith('__reactProps$')),fiberKey=Object.keys(node).find(k=>k.startsWith('__reactFiber$'));let fiber=node[fiberKey],chain=[];for(let i=0;fiber&&i<24;i++,fiber=fiber.return){const p=fiber.memoizedProps??{},callbacks=Object.entries(p).filter(([k,v])=>/^on.*(Click|Activate|Open)/.test(k)&&typeof v==='function').map(([name,fn])=>({name,source:Function.prototype.toString.call(fn).slice(0,1600)}));if(callbacks.length)chain.push({type:typeof fiber.type==='function'?fiber.type.name:typeof fiber.type==='string'?fiber.type:'other',threadId:p.threadId??p.conversationId??p.thread?.id,callbacks});}return{tag:node.tagName,id:node.getAttribute('data-app-action-sidebar-thread-id'),title:title.getAttribute('data-thread-title'),click:typeof node[key]?.onClick==='function'?Function.prototype.toString.call(node[key].onClick).slice(0,1600):null,chain};});})()`,returnByValue:true});report.sidebarHandlers=handlers.result?.value;return;}
    try { await request('Performance.enable'); report.metricsBefore = (await request('Performance.getMetrics')).metrics; } catch (e) { report.warnings.push(e.message); }
    try {
      streamReady = new Promise(resolve => { report.resolveStream = resolve; });
      subscription = await context.cdp.subscribe({ scope: 'session', sessionId, methods: ['Tracing.tracingComplete'] }, event => report.resolveStream(event.params.stream));
      await request('Tracing.start', { transferMode: 'ReturnAsStream', streamFormat: 'json', categories: 'devtools.timeline,blink.user_timing,disabled-by-default-v8.cpu_profiler' }); tracing = true;
    } catch (e) { report.warnings.push(e.message); }
    const runArgs={limit:mode.limit??2,containBody:mode.containBody??false,transport:mode.transport??'direct'};
    const running=request('Runtime.evaluate', { expression: 'globalThis[Symbol.for("codlet.workspace.navigation.profile")].run('+JSON.stringify(runArgs)+')', awaitPromise: true, returnByValue: true });
    if(runArgs.transport==='trusted'){
      let done=false,last;running.then(()=>done=true,()=>done=true);const start=Date.now();report.inputs=[];
      while(!done&&Date.now()-start<45000){const state=await request('Runtime.evaluate',{expression:'globalThis[Symbol.for("codlet.workspace.navigation.profile")]?.inspect()',returnByValue:true}),click=state.result?.value?.pendingClick;
        if(click&&click.threadId!==last){last=click.threadId;await request('Input.dispatchMouseEvent',{type:'mouseMoved',x:click.x,y:click.y});await request('Input.dispatchMouseEvent',{type:'mousePressed',x:click.x,y:click.y,button:'left',clickCount:1});await request('Input.dispatchMouseEvent',{type:'mouseReleased',x:click.x,y:click.y,button:'left',clickCount:1});report.inputs.push(click);}
        if(!done)await new Promise(resolve=>setTimeout(resolve,100));
      }
    }
    const result=await running;
    report.result = result.result?.value; report.exception = result.exceptionDetails;
    try { report.metricsAfter = (await request('Performance.getMetrics')).metrics; await request('Performance.disable'); } catch (e) { report.warnings.push(e.message); }
    if (tracing) {
      await request('Tracing.end'); tracing = false;
      const stream = await Promise.race([streamReady, new Promise((_,reject) => setTimeout(() => reject(Error('Trace stream timeout')), 5000))]);
      const file = fs.openSync(path.join(context.root, 'trace.json'), 'w'); let bytes = 0;
      try { for (;;) { const part = await request('IO.read', { handle: stream, size: 65536 }); const data = Buffer.from(part.data, part.base64Encoded ? 'base64' : 'utf8'); bytes += data.length; if (bytes > 64 * 1024 * 1024) throw Error('Bounded trace exceeded 64 MiB'); fs.writeSync(file, data); if (part.eof) break; } }
      finally { fs.closeSync(file); await request('IO.close', { handle: stream }); }
      report.traceBytes = bytes;
    }
  } catch (error) { report.error = error.message; }
  finally {
    if (tracing) try { await request('Tracing.end'); } catch {}
    await subscription?.unsubscribe(); delete report.resolveStream;
    if (sessionId) try { await context.cdp.request('Target.detachFromTarget', { sessionId }); } catch {}
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
  }
}, 900); }, deactivate() { clearTimeout(timer); } };
