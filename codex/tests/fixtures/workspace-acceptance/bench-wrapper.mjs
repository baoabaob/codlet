// Offline only. This measures Adapter + synthetic React/jsdom work, not Native
// Chromium layout, screen presentation, backend activity or real draft saves.
import { build } from '../../../frontend/node_modules/esbuild/lib/main.js';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { createComposerBinding } from '../../../frontend/src/adapter/workspace-composer-binding.js';
const frontend=fileURLToPath(new URL('../../../frontend/',import.meta.url));
const require=createRequire(new URL('../../../frontend/package.json',import.meta.url)),{JSDOM}=require('jsdom');
const bundle=async(entry,globalName)=>(await build({entryPoints:[fileURLToPath(entry)],absWorkingDir:frontend,bundle:true,write:false,format:'iife',globalName,platform:'browser',define:{'process.env.NODE_ENV':'"production"'}})).outputFiles[0].text;
const workspaceSource=await bundle(new URL('../../../frontend/src/adapter/workspace.js',import.meta.url),'Workspace');
const nativeSource=(await build({absWorkingDir:frontend,stdin:{contents:await readFile(new URL('../../support/native-shell.js',import.meta.url),'utf8'),resolveDir:frontend},bundle:true,write:false,format:'iife',globalName:'NativeFixture',platform:'browser',define:{'process.env.NODE_ENV':'"production"'}})).outputFiles[0].text;
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const quantiles=values=>{const a=[...values].sort((x,y)=>x-y),at=p=>a[Math.min(a.length-1,Math.ceil(a.length*p)-1)];return{samples:a.length,p50:at(.5),p95:at(.95),p99:at(.99),max:a.at(-1)};};

async function surfaceCase(panes){
  const dom=new JSDOM('<body><div id="root"><nav></nav><header data-app-shell-main-titlebar></header><main data-app-shell-main-surface><div data-includes-composer><div class="thread-scroll-container"><section id="body">synthetic baseline</section><footer data-thread-scroll-footer><div data-codex-composer-root></div></footer></div></div></main><aside data-app-shell-focus-area="right-panel"></aside></div></body>',{url:'app://-/index.html',runScripts:'outside-only'});
  const{window}=dom,{document}=window;window.eval(workspaceSource);const N={...window.eval(nativeSource+';NativeFixture;')},R=N.React,h=R.createElement,context=R.createContext(null);
  document.querySelector('[data-includes-composer]').__reactFiber$fixture={dependencies:{firstContext:{context,memoizedValue:'synthetic-app'}}};
  let observeCalls=0,unobserveCalls=0,disconnects=0,created=0,disposed=0,token=0;
  const listeners=new Set(),frames=new Map();let frame=0;
  window.ResizeObserver=class{observe(){observeCalls++;}unobserve(){unobserveCalls++;}disconnect(){disconnects++;}};
  const createRoot=N.Client.createRoot;N.Client={createRoot(...args){created++;const root=createRoot(...args),unmount=root.unmount.bind(root);root.unmount=()=>{disposed++;unmount();};return root;}};
  N.Scope=({children})=>children;N.composerScope={};N.composerValue=()=>({});N.ThreadSubscription=()=>null;
  N.manager={getConversation:()=>({resumeState:'resumed',turns:[{}]}),addConversationStateCallback:()=>()=>{}};
  N.Content=({conversationId})=>{const value=R.useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn);},()=>token);return h('div',{className:'thread-scroll-container'},h('div',{'data-thread-find-target':'conversation'},'synthetic '+conversationId+' '+value));};
  const workspace=window.Workspace.createWorkspace({onDeactivate:()=>()=>{},rpc:{provide(){}},reportDiagnostic(error){throw Error(error.message);}},{document,locate:()=>({rootNode:document.getElementById('root'),navigator:{location:{pathname:'/local/synthetic-main',search:'',hash:''}}}),validateDocument(){},discovery:{transcript:async()=>N,dispose(){}},requestFrame(fn){frames.set(++frame,fn);return frame;},cancelFrame:id=>frames.delete(id),testPoints:{enabled:true,runId:'surface-'+panes}});
  const owner={world:'main',pluginId:'offline-fixture',generation:1,onDeactivate:()=>()=>{}},ticket=workspace.issueTicket({},{caller:owner});const session=workspace.connect(owner,ticket.ticket);
  const handles=[];for(let i=0;i<panes;i++){const box=document.createElement('div');document.body.append(box);handles.push(session.mountTranscript(box,{threadId:'synthetic-'+i}));}
  await Promise.all(handles.map(handle=>handle.ready));await tick();
  async function flush(){await tick();const pending=[...frames.values()];frames.clear();for(const fn of pending)fn();await tick();}
  await flush();const before=workspace.readTestPoints().counts;
  for(let i=0;i<200;i++){document.getElementById('body').append(document.createTextNode('x'));token++;for(const listener of listeners)listener();}
  await flush();const streamed=workspace.readTestPoints().counts;
  const geometryBefore=streamed['surface.geometry']??0,scansBefore=streamed['surface.scan']??0;
  for(let batch=0;batch<5;batch++){for(let i=0;i<40;i++)document.querySelector('nav').append(document.createElement('span'));await flush();}
  const shell=workspace.readTestPoints().counts;await flush();
  const idle=workspace.readTestPoints().counts;
  session.dispose();await tick();workspace.dispose();window.close();
  return{panes,rootsCreated:created,rootsDisposed:disposed,remainingSubscriptions:listeners.size,
    resize:{observeCalls,unobserveCalls,disconnects},
    streamed:{surfaceScans:(streamed['surface.scan']??0)-(before['surface.scan']??0),geometryReads:(streamed['surface.geometry']??0)-(before['surface.geometry']??0)},
    shellBursts:{bursts:5,mutations:200,scans:(shell['surface.scan']??0)-scansBefore,geometryReads:(shell['surface.geometry']??0)-geometryBefore},
    settledIdleNewReconciles:(idle['surface.reconcile']??0)-(shell['surface.reconcile']??0)};
}

async function bindingCase(){
  const rounds=[];
  for(let round=0;round<5;round++){
    let binding,active=false,closed=0;
    const driver={async bind(value){binding=value;},async activate(){active=true;},block(){active=false;},readBinding:()=>({...binding,inputConfirmed:true,submitDisabled:!active}),isComposing:()=>false,focus:()=>active,async close(){closed++;}};
    const handle=createComposerBinding({driver,initialIdentity:{threadId:'synthetic-first'},check(){},report(error){throw error;}});await handle.ready;
    const times=[];for(let i=0;i<120;i++){const start=performance.now(),value=await handle.bind({threadId:i%2?'synthetic-first':'synthetic-second'});await handle.activate({bindingRevision:value.bindingRevision});handle.focus({bindingRevision:value.bindingRevision});if(i>=20)times.push(performance.now()-start);}
    await handle.close();rounds.push({round,...quantiles(times),driverCloseCalls:closed});
  }
  return rounds;
}
const report={schema:1,runId:'adapter-offline-2026-10-11',scope:'Adapter wrapper and synthetic React/jsdom only',
  nativeClientTested:false,nativeDraftHandoffTested:false,node:process.version,bundleSha256:createHash('sha256').update(workspaceSource).digest('hex'),
  cases:[],bindingRounds:await bindingCase()};
for(const panes of[0,1,2,4,5,8])report.cases.push(await surfaceCase(panes));
const output=resolve(process.argv[2]??'.artifacts/workspace-wrapper-benchmark/report.json');await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2));
console.log(JSON.stringify({output,nativeClientTested:false,cases:report.cases,bindingP95Ms:report.bindingRounds.map(round=>round.p95)}));
