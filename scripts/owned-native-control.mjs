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
const reportFile=path.join(probe,'report.json'),read=()=>{const value=JSON.parse(fs.readFileSync(reportFile));if(!Number.isSafeInteger(value.lastSequence)||value.lastSequence<0||!Array.isArray(value.actions))throw Error('Invalid original action report');return value;};
const file=path.join(probe,'control.json');
function pendingCommand(report){
  if(!fs.existsSync(file))return null;
  const command=JSON.parse(fs.readFileSync(file));
  if(command.runId!==path.basename(run)||!Number.isSafeInteger(command.sequence))throw Error('Invalid original command owner');
  const receipt=report.actions.find(item=>item.sequence===command.sequence);
  return command.sequence>report.lastSequence||!receipt||receipt.phase==='admitted'?command:null;
}
if(action==='query'){const report=read();console.log(JSON.stringify({...report,pendingCommand:pendingCommand(report)},null,2));process.exit(0)}
const lock=path.join(probe,'control-writer.lock'),owner=fs.openSync(lock,'wx');
try{
  const report=read();
  if(pendingCommand(report)||report.actions.at(-1)?.phase==='admitted')throw Error('Previous action is unresolved; query its original report without replay');
  const sequence=report.lastSequence+1,command={runId:path.basename(run),sequence,action,params:JSON.parse(params)},temporary=file+'.'+sequence+'.tmp';
  fs.writeFileSync(temporary,JSON.stringify(command)+'\n',{flag:'wx'});fs.renameSync(temporary,file);
  const end=Date.now()+20000;let settled=false;
  while(Date.now()<end){const value=read(),result=value.actions.find(item=>item.sequence===sequence);if(result&&result.phase!=='admitted'){console.log(JSON.stringify(result,null,2));process.exitCode=result.phase==='settled'?0:1;settled=true;break;}await delay(100)}
  if(!settled){console.error(JSON.stringify({sequence,action,outcome:'unknown',command:file,message:'Original command retained; do not replay'}));process.exitCode=2;}
}finally{fs.closeSync(owner);fs.unlinkSync(lock);}
