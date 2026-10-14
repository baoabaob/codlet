import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here=dirname(fileURLToPath(import.meta.url)),repo=resolve(here,'../../..');
const output=resolve(repo,'.artifacts/workspace-discovery-probe');
await mkdir(output,{recursive:true});
const desktop=await readFile(resolve(repo,'bundled/codex-desktop-adapter/renderer.js'),'utf8');
// Definitions only: neither activate nor createAdapter is called. The current
// installed API, request transport, route and renderer roots are never patched.
const expression=`(async()=>{
  const module={exports:{}};
  ${desktop}
  const root=document.getElementById('root'),key=root&&Object.keys(root).find(key=>key.startsWith('__reactContainer$'));
  const container=key&&root[key],current=container?.stateNode?.current??container;
  const pending=[current],seen=new Set();
  while(pending.length&&seen.size<=20000){const fiber=pending.pop();if(!fiber||seen.has(fiber))continue;seen.add(fiber);if(fiber.sibling)pending.push(fiber.sibling);if(fiber.child)pending.push(fiber.child);}
  const rail=root?.querySelector('nav[data-app-navigation-rail="true"]'),railKey=rail&&Object.keys(rail).find(key=>key.startsWith('__reactFiber$')),attached=railKey&&rail[railKey];
  function ancestry(start){const seen=new Set();let fiber=start;while(fiber&&!seen.has(fiber)&&seen.size<256){seen.add(fiber);if(fiber===current)break;fiber=fiber.return;}return {depth:seen.size,reachesCurrent:seen.has(current),provenDepth:currentAncestry(start,current)?.size??null,stateNodeMatches:start?.stateNode===rail};}
  const branches={attached:ancestry(attached),alternate:ancestry(attached?.alternate)};
  const start=performance.now(),shell=hostFibers(),connection=await probeDesktop(undefined,0),discoveryMs=performance.now()-start;
  const checks=performance.now();for(let i=0;i<1000;i++)connection.check();const check1000Ms=performance.now()-checks;
  let navigation;try{const router=locateNavigator();navigation={available:true,path:router.location.pathname};}catch(error){navigation={available:false,code:error.code,message:error.message};}
  return {status:'passed',visibilityState:document.visibilityState,build:connection.build,
    previousWholeTreeProbe:{limit:20000,visited:seen.size,exceeded:seen.size>20000},shellFibers:shell.size,
    discoveryMs,check1000Ms,navigation,branches,existingConnection:connection.manager.requestClient===connection.client,
    cachedThreads:(connection.manager.getCachedConversations?.()??[]).map(thread=>({id:thread.id,resumeState:thread.resumeState,
      turns:thread.turns?.length??0,historyKind:thread.turnHistory?.kind??null,historyComplete:thread.turnHistory?.history?.isComplete??null,
      source:thread.turnsPagination?.source??null,olderCursor:!!thread.turnsPagination?.olderCursor,
      incompleteTurnItems:thread.turns?.filter(turn=>turn.itemsPagination?.hasLoadedOldest===false).length??0,
      streamRole:connection.manager.getStreamRole(thread.id)?.role??'none'})),
    nativeRailCount:root?.querySelectorAll('nav[data-app-navigation-rail="true"]').length??0,
    ownedContainerCount:document.querySelectorAll('[data-codlet-workspace-owned]').length};
})()`;
await writeFile(resolve(output,'probe.js'),expression);
await writeFile(resolve(output,'codlet.json'),JSON.stringify({schema:1,id:'dev.workspace.discovery-probe',name:'Bounded workspace discovery probe',version:'0.0.1',host:{entry:'host.cjs'},permissions:['host.process','cdp.raw']},null,2)+'\n');
await copyFile(resolve(here,'discovery-probe-host.cjs'),resolve(output,'host.cjs'));
console.log(output);
