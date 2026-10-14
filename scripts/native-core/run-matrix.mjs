// Only this explicitly prepared fixture/run. Never discovers a default client.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {command} from './command.mjs';
const exec=promisify(execFile),[runArg,phase='active']=process.argv.slice(2),run=path.resolve(runArg??'');
if(!['active','idle','smoke','background','background-idle','background-smoke'].includes(phase)||!/^core-[a-f0-9-]{36}$/.test(path.basename(run)))throw Error('Explicit Core run and supported phase required');
const background=phase.startsWith('background'),idlePhase=phase.endsWith('idle'),smoke=phase.endsWith('smoke');
execFileSync(process.execPath,['scripts/verify-core-native-run.mjs',run],{stdio:'inherit',windowsHide:true});
const proof=JSON.parse(fs.readFileSync(path.join(run,'owned-runtime-evidence.json'),'utf8'));
const directory=path.join(run,'benchmark-plugin'),settings=JSON.parse(fs.readFileSync(path.join(directory,'settings.json'),'utf8'));
if(settings.targetId!==proof.targetId||settings.runId!==proof.runId||!proof.authenticated)throw Error('Pinned fixture no longer matches owned live Target');
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report={schema:1,phase,buildProfile:settings.buildProfile??'unrecorded',runId:proof.runId,targetId:proof.targetId,startedAt:new Date().toISOString(),layer:'Core controlled React inside owned Native Chromium; trusted Native sidebar input measured separately',sources:Object.fromEntries(['host.cjs','renderer.js'].map(file=>[file,hash(path.join(directory,file))])),uiBundle:hash('bundled/runtime/ui.js'),labBinary:proof.labBinarySha256,fixture:'20/200/2000 fixed pre/button/aside/p elements per root; two rotating text mutations per update; SDK button portaled to separate styled control container; no message send',frameMeaning:background?'Background samples have no frame or Native input measurements. MessageChannel yields are task boundaries, not presentation.':'Two rAF callbacks in a visible document are presentation opportunities, not compositor/display timestamps',cases:[]};
const output=path.join(run,'native-core-'+phase+'.json');
const save=()=>fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
const requireClean=state=>{if(state.ownedObservers||state.ownedMediaListeners||state.ownedUiContainers||state.ownedDom)throw Error('Fixture resources not released');};
const invoke=(action,options,timeout)=>command(directory,action,{...options,background},timeout);
try{
  const initial=await invoke('inspect');
  // Do not retain native labels/account-menu text in performance reports.
  report.initial={visible:initial.visible,focused:initial.focused,viewport:initial.viewport};
  if(!background&&initial.visible!=='visible')throw Error('Visible Native window required; hidden samples are rejected');
  await invoke('gc');report.cold=await invoke('counters');
  await invoke('setup',{roots:1,items:20});await invoke('runCase',{samples:5});requireClean(await invoke('cleanup'));
  await invoke('gc');report.baseline=await invoke('counters');
  if(idlePhase){
    for(const roots of [0,1,2,4,5,8])for(const style of ['neutral-split','styled']){
      const spec={roots,items:2000,mode:'scheduled',style};
      const setup=await invoke('setup',spec);await invoke('runCase',{samples:5});await delay(3000);
      const memory=await invoke('counters');const initialVisibility=await invoke('beginIdle',{idleMs:65000});
      const file=path.join(run,`idle-${roots}-${style}.json`);
      await exec('powershell.exe',['-NoProfile','-NonInteractive','-File',path.resolve('scripts/native-core/sample-process-group.ps1'),'-Evidence',path.join(run,'owned-runtime-evidence.json'),'-Output',file],{windowsHide:true,timeout:80000});
      const visibility=await invoke('endIdle',{},12000),processes=JSON.parse(fs.readFileSync(file,'utf8'));
      if(!background&&(initialVisibility.initial!=='visible'||visibility.final!=='visible'||visibility.transitions.some(e=>e.state!=='visible')))throw Error('Idle sample lost visible-window condition');
      if(background&&(initialVisibility.initial!=='hidden'||visibility.final!=='hidden'||visibility.transitions.some(e=>e.state!=='hidden')))throw Error('Background idle sample was not consistently hidden');
      const cleanup=await invoke('cleanup');requireClean(cleanup);report.cases.push({spec,setup,memory,visibility,processes,cleanup});save();console.log(JSON.stringify({phase,completed:report.cases.length,total:12,spec,cpuSeconds:processes.cpuSeconds}));
    }
  }else{
    const counts=smoke?[1]:[0,1,2,4,5,8],sizes=smoke?[20]:[20,200,2000];
    for(const items of sizes)for(const roots of counts)for(const style of ['neutral-split','styled'])for(const mode of (roots%2?['scheduled','sync']:['sync','scheduled'])){
      const spec={roots,items,mode,style};const setup=await invoke('setup',spec);
      if(!setup.styleBoundary)throw Error('Neutral style scope leaked');
      await invoke('runCase',{samples:5});const performance=await invoke('runCase',{samples:smoke?5:30});
      if(background&&(performance.visibility!=='hidden'||performance.startingVisibility!=='hidden'||performance.visibilityChanges.some(v=>v!=='hidden')))throw Error('Background case did not remain hidden');
      const native=[];for(let i=0;!background&&i<(smoke?2:10);i++){const result=await invoke('nativeClick',{label:'sidebar',stress:true});if(!result.trusted||result.beforeExpanded===result.afterExpanded||result.clickToMutationMs==null)throw Error('Native sidebar state receipt missing');native.push(result);await delay(160);}
      const theme=await invoke('theme');if(theme.sameSignatureWrites||theme.existingWritesOnCreate||theme.themeReceipts.some(r=>r.themes.some(t=>t!==r.target)))throw Error('Incremental theme invariant failed');
      const memory=await invoke('counters');let screenshot;
      if(!background&&((roots===8&&items===2000&&mode==='scheduled')||smoke))screenshot=await invoke('capture');
      const cleanup=await invoke('cleanup');requireClean(cleanup);
      report.cases.push({spec,setup,performance,native,theme,memory,screenshot,cleanup});save();
      console.log(JSON.stringify({phase,completed:report.cases.length,total:smoke?4:72,spec,commitP95:performance.commitLatency.p95,nativeMax:native.length?Math.max(...native.map(x=>x.clickToMutationMs)):null}));
    }
  }
  await invoke('gc');report.final=await invoke('counters');requireClean(report.final.fixture);report.completedAt=new Date().toISOString();report.status='completed';save();console.log(output);
}catch(error){report.status='blocked';report.error=String(error.message);try{report.cleanup=await invoke('cleanup');}catch(cleanup){report.cleanupError=String(cleanup.message);}save();throw error;}
