// Core seals this plan before handoff. Windows Installer owns the file update,
// rollback, registration and elevation; this helper owns only coordination.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {read,verify,writeJson,ordinary,key,sha,absolute,ownersAlive,officialResult} from './runtime-update-helper.mjs';
const self=fileURLToPath(import.meta.url),fail=(code,message)=>Object.assign(new Error(message),{code});
const hash=value=>createHash('sha256').update(value).digest('hex');
const plain=value=>value.replace(/^\\\\\?\\/,'');
function execute(program,args,options){
  return new Promise((resolve,reject)=>{
    const out=fs.openSync(options.log+'.stdout.log','wx'),err=fs.openSync(options.log+'.stderr.log','wx');
    try{const child=spawn(program,args,{cwd:options.cwd,env:options.env??process.env,windowsHide:true,stdio:['ignore',out,err]});child.once('error',reject);child.once('close',code=>resolve(code));}
    finally{fs.closeSync(out);fs.closeSync(err);}
  });
}
export function validateMsiPlan(plan,planPath,expectedSha){
  const job=path.dirname(absolute(planPath));
  if(plan.schema!==1||plan.kind!=='codlet-msi-install-plan'||!/^runtime-install-[A-Za-z0-9_-]+$/.test(plan.id)||!sha(expectedSha)||
    key(job)!==key(path.join(absolute(plan.stateRoot),plan.id))||path.basename(planPath)!=='install-plan.json'||
    typeof plan.officialUpdate!=='boolean'||typeof plan.activateOnNextStart!=='boolean'||plan.officialUpdate&&plan.activateOnNextStart)throw fail('plan_invalid','Invalid MSI update plan.');
  if(!Number.isSafeInteger(plan.createdAt)||!Number.isSafeInteger(plan.expiresAt)||plan.expiresAt<=Date.now()||plan.createdAt>plan.expiresAt)throw fail('plan_expired','MSI update confirmation expired.');
  for(const name of ['stateRoot','installRoot'])ordinary(absolute(plan[name]),true);
  ordinary(job,true);
  for(const [name,file]of [['handoffAckPath','handoff-ack.json'],['installReceiptPath','install-receipt.json']])if(key(plan[name])!==key(path.join(job,file)))throw fail('plan_invalid','MSI transaction path changed.');
  if(key(plan.summaryReceiptPath)!==key(path.join(plan.stateRoot,'runtime-update-install-receipt.json')))throw fail('plan_invalid','MSI receipt path changed.');
  for(const name of ['helperScript','primitives','helperNode']){
    if(key(absolute(plan[name]?.path)).startsWith(key(plan.installRoot)+path.sep))throw fail('plan_invalid','MSI helpers must remain outside the replaced installation.');verify(plan[name].path,plan[name]);
  }
  if(key(plan.primitives.path)!==key(path.join(path.dirname(plan.helperScript.path),'runtime-update-helper.mjs')))throw fail('plan_invalid','MSI helper dependency changed.');
  if(key(plan.helperScript.path)!==key(self)||key(plan.helperNode.path)!==key(process.execPath))throw fail('plan_invalid','MSI helper process differs from its plan.');
  if(key(plan.marker.path)!==key(path.join(plan.installRoot,'msi-install.json'))||key(plan.currentExecutable.path)!==key(path.join(plan.installRoot,'codlet.exe')))throw fail('plan_invalid','MSI owner path changed.');
  if(key(path.dirname(plan.installer.path))!==key(plan.stateRoot)||path.basename(plan.installer.path)!==`runtime-installer-${plan.installer.sha256}.exe`)throw fail('plan_invalid','MSI setup is outside the staged release.');
  if(!Array.isArray(plan.expectedFiles)||!plan.expectedFiles.some(file=>file.path==='codlet.exe')||plan.expectedFiles.some(file=>!['codlet.exe','runtime/node-runtime.json'].includes(file.path)))throw fail('plan_invalid','MSI payload identity is incomplete.');
  if(!Array.isArray(plan.waitFor)||!plan.waitFor.length||new Set(plan.waitFor.map(value=>value.pid)).size!==plan.waitFor.length||plan.waitFor.some(value=>!Number.isSafeInteger(value.pid)||value.pid<=0||value.pid===process.pid||!/^\d+$/.test(value.creationTime)))throw fail('plan_invalid','Invalid original owner identities.');
  if(!plan.restart||!Array.isArray(plan.restart.args)||!plan.restart.environment||typeof plan.restart.environment!=='object')throw fail('plan_invalid','Missing checked restart command.');
  if(key(plan.restart.program)!==key(plan.restartProgram.path))throw fail('plan_invalid','MSI restart program changed.');
  verify(plan.restartProgram.path,plan.restartProgram,true);
  for(const launcher of plan.launcherFiles){if(key(path.dirname(launcher.path))!==key(job))throw fail('plan_invalid','MSI restart helper is not owned by the transaction.');verify(launcher.path,launcher);}
  verify(plan.marker.path,plan.marker);verify(plan.currentExecutable.path,plan.currentExecutable);verify(plan.installer.path,plan.installer);
  return plan;
}
export async function runMsiInstall(planPath,expectedSha,onReady=()=>{},dependencies={}){
  const bytes=read(planPath);if(!sha(expectedSha)||hash(bytes)!==expectedSha)throw fail('plan_digest_mismatch','MSI plan changed after confirmation.');
  const plan=validateMsiPlan(JSON.parse(bytes),planPath,expectedSha),job=path.dirname(planPath),run=dependencies.execute??execute,alive=dependencies.ownersAlive??ownersAlive,pause=dependencies.pause??delay;
  if(fs.existsSync(plan.installReceiptPath)||fs.existsSync(plan.handoffAckPath))throw fail('plan_already_used','This MSI transaction was already started.');
  const receipt={schema:1,id:plan.id,planSha256:expectedSha,version:plan.version,phase:'validating',movedOld:[],movedNew:[],configPatched:false,error:null};
  const persist=()=>{receipt.updatedAt=Date.now();writeJson(plan.installReceiptPath,receipt);writeJson(plan.summaryReceiptPath,receipt);};
  let attempted=false;
  async function setup(mode,name){
    verify(plan.installer.path,plan.installer);const file=path.join(job,name+'.json');
    const code=await run(plan.installer.path,[mode,plain(plan.installRoot),'--version',plan.version,'--receipt',plain(file)],{cwd:job,log:path.join(job,name)});
    const result=JSON.parse(read(file));
    if(code!==0&&code!==3010||result.version!==plan.version||typeof result.installRoot!=='string'||key(result.installRoot)!==key(plan.installRoot)||!(mode==='--validate-upgrade'?result.phase==='ready':['installed','restartRequired'].includes(result.phase)))throw fail('msi_install_failed',result.error??'Windows Installer did not confirm the requested upgrade.');
    return result;
  }
  try{
    await setup('--validate-upgrade','setup-preflight');
    receipt.phase='ready';persist();onReady({schema:1,event:'runtime-update-helper-ready',id:plan.id,planSha256:expectedSha});
    while(!fs.existsSync(plan.handoffAckPath)){if(Date.now()>plan.expiresAt)throw fail('handoff_not_armed','MSI update was not acknowledged.');await pause(50);}
    const ack=JSON.parse(read(plan.handoffAckPath));if(ack.id!==plan.id||ack.planSha256!==expectedSha)throw fail('handoff_ack_invalid','MSI acknowledgement changed.');
    receipt.phase='waitingForExit';persist();
    while(await alive(plan.waitFor)){officialResult(plan,expectedSha);await pause(250);}
    officialResult(plan,expectedSha,true);
    verify(plan.marker.path,plan.marker);verify(plan.currentExecutable.path,plan.currentExecutable);
    attempted=true;receipt.phase='installing';persist();
    const result=await setup('--upgrade-existing','setup-result');
    for(const file of plan.expectedFiles)verify(path.join(plan.installRoot,file.path),file);
    if(result.phase==='restartRequired'||plan.activateOnNextStart){receipt.phase='installedDeferred';receipt.restartRequired=result.phase==='restartRequired';persist();return receipt;}
    verify(plan.restartProgram.path,plan.restartProgram,true);for(const file of plan.launcherFiles)verify(file.path,file);
    receipt.phase='restarting';persist();
    const code=await run(plan.restart.program,plan.restart.args,{cwd:plan.restart.workingDirectory,env:{...process.env,...plan.restart.environment},log:path.join(job,'restart')});
    if(code!==0)throw fail('msi_restart_unconfirmed','The updated Codlet launcher did not confirm readiness.');
    receipt.phase='installed';persist();return receipt;
  }catch(error){receipt.phase=attempted?'rollbackBlocked':'failed';receipt.error={code:error.code??'msi_update_failed',message:String(error.message??error)};persist();throw Object.assign(error,{receipt});}
}
if(process.argv[1]&&key(process.argv[1])===key(self)){
  process.stdout.on('error',()=>{});const args=process.argv.slice(2);let ready=false;
  try{if(args.length!==4||args[0]!=='--plan'||args[2]!=='--sha256')throw fail('invalid_arguments','Expected a sealed MSI update plan.');
    await runMsiInstall(args[1],args[3],message=>{ready=true;process.stdout.write(JSON.stringify(message)+'\n');});
  }catch(error){if(!ready)process.stdout.write(JSON.stringify({schema:1,event:'runtime-update-helper-failed',id:error.receipt?.id??null,error:{code:error.code??'msi_update_failed',message:String(error.message??error)}})+'\n');process.exitCode=1;}
}
