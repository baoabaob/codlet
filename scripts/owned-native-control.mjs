// One explicitly sequenced operation through this run's test plugin. A timeout
// reports an unknown outcome and leaves the original command intact for queries.
import fs from 'node:fs';import path from 'node:path';import {setTimeout as delay}from'node:timers/promises';
import {captureProcessIdentity}from'./runtime-update-helper.mjs';
const [input,action,params='{}']=process.argv.slice(2),run=path.resolve(input??''),root=path.join(run,'profile'),probe=path.join(root,'project/fixtures/unified-probe');
if(!/^core-[a-f0-9-]{36}$/.test(path.basename(run))||!action)throw Error('Explicit owned run and action required');
const current=JSON.parse(fs.readFileSync(path.join(root,'logs/manual-client.json')));
if(current.state!=='ready')throw Error('Owned coordinator is not ready');
const [manager,native]=await Promise.all([captureProcessIdentity(current.managerPid),captureProcessIdentity(current.desktopPid)]);
const millis=Date.parse(current.managerCreated),fraction=current.managerCreated.match(/\.(\d{7})Z$/)?.[1];
if(!Number.isFinite(millis)||!fraction)throw Error('Missing exact manager creation time');
const managerBirth=((BigInt(millis)+11644473600000n)*10000n+BigInt(fraction.slice(3))).toString();
if(!manager||!native||manager.creationTime!==managerBirth||native.creationTime!==String(current.desktopCreated))throw Error('Owned process identity changed');
const reportFile=path.join(probe,'report.json'),read=()=>JSON.parse(fs.readFileSync(reportFile));
const report=read(),pending=report.actions.at(-1);
if(pending?.phase==='admitted')throw Error('Previous action is unresolved; query its original report without replay');
if(action==='query'){console.log(JSON.stringify(report,null,2));process.exit(0)}
const sequence=report.lastSequence+1,command={runId:path.basename(run),sequence,action,params:JSON.parse(params)},file=path.join(probe,'control.json'),temporary=file+'.'+sequence+'.tmp';
fs.writeFileSync(temporary,JSON.stringify(command)+'\n',{flag:'wx'});fs.renameSync(temporary,file);
const end=Date.now()+20000;
while(Date.now()<end){const value=read(),result=value.actions.find(item=>item.sequence===sequence);if(result&&result.phase!=='admitted'){console.log(JSON.stringify(result,null,2));process.exit(result.phase==='settled'?0:1)}await delay(100)}
console.error(JSON.stringify({sequence,action,outcome:'unknown',command:file,message:'Original command retained; do not replay'}));process.exitCode=2;
