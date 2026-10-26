import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {runMsiInstall} from '../scripts/runtime-msi-update-helper.mjs';
const digest=value=>createHash('sha256').update(value).digest('hex');
const checked=file=>({path:file,bytes:fs.statSync(file).size,sha256:digest(fs.readFileSync(file))});
function fixture(t,{official=true,deferred=false,cancel=false,failSetup=false}={}){
  const temp=fs.realpathSync.native(os.tmpdir()),root=fs.mkdtempSync(path.join(temp,'codlet-msi-helper-')),state=path.join(root,'state'),install=path.join(root,'installed'),id='runtime-install-'+randomUUID(),job=path.join(state,id);
  fs.mkdirSync(job,{recursive:true});fs.mkdirSync(install);const executable=path.join(install,'codlet.exe'),marker=path.join(install,'msi-install.json');
  fs.writeFileSync(executable,'old exe');fs.writeFileSync(marker,'{"schema":1}');fs.writeFileSync(path.join(install,'user-data.json'),'preserved');
  const setupBytes=Buffer.from('verified setup'),setup=path.join(state,'runtime-installer-'+digest(setupBytes)+'.exe');fs.writeFileSync(setup,setupBytes);
  const launcher=path.join(job,'restart.ps1');fs.writeFileSync(launcher,'checked owner restart');
  const helper=fileURLToPath(new URL('../scripts/runtime-msi-update-helper.mjs',import.meta.url)),primitives=fileURLToPath(new URL('../scripts/runtime-update-helper.mjs',import.meta.url));
  const plan={schema:1,kind:'codlet-msi-install-plan',id,version:'9.0.0',stateRoot:state,installRoot:install,installer:checked(setup),marker:checked(marker),currentExecutable:checked(executable),expectedFiles:[{path:'codlet.exe',bytes:7,sha256:digest('new exe')}],helperNode:checked(process.execPath),helperScript:checked(helper),primitives:checked(primitives),restartProgram:checked(process.execPath),restart:{program:process.execPath,args:[launcher],workingDirectory:job,environment:{}},launcherFiles:[checked(launcher)],waitFor:[{pid:123,creationTime:'1'}],officialUpdate:official,activateOnNextStart:deferred,handoffAckPath:path.join(job,'handoff-ack.json'),installReceiptPath:path.join(job,'install-receipt.json'),summaryReceiptPath:path.join(state,'runtime-update-install-receipt.json'),createdAt:Date.now(),expiresAt:Date.now()+60000};
  const planPath=path.join(job,'install-plan.json');fs.writeFileSync(planPath,JSON.stringify(plan));const sha=digest(fs.readFileSync(planPath));let alive=true;const calls=[];
  const dependencies={ownersAlive:async()=>alive,execute:async(program,args)=>{
    calls.push(args[0]);if(program===setup){assert.equal(args[1],install);assert.equal(args[3],plan.version);if(args[0]==='--upgrade-existing'){assert.equal(alive,false);if(failSetup){fs.writeFileSync(args[5],JSON.stringify({phase:'failed',error:'MSI cancelled'}));return 1;}fs.writeFileSync(executable,'new exe');}
      fs.writeFileSync(args[5],JSON.stringify({phase:args[0]==='--validate-upgrade'?'ready':'installed',version:plan.version,installRoot:install}));return 0;
    }assert.equal(fs.readFileSync(executable,'utf8'),'new exe');return 0;
  }};
  const ready=message=>{assert.equal(fs.readFileSync(executable,'utf8'),'old exe');assert.equal(message.planSha256,sha);fs.writeFileSync(plan.handoffAckPath,JSON.stringify({id,planSha256:sha}));if(official)fs.writeFileSync(path.join(job,'official-result.json'),JSON.stringify({id,planSha256:sha,ready:!cancel}));alive=false;};
  t.after(()=>{assert.ok(path.resolve(root).startsWith(path.resolve(temp)+path.sep));fs.rmSync(root,{recursive:true});});
  return{plan,planPath,sha,ready,dependencies,calls,executable,install};
}
test('MSI handoff waits for Native confirmation, delegates file changes to setup and restarts once',async t=>{
  const f=fixture(t),result=await runMsiInstall(f.planPath,f.sha,f.ready,f.dependencies);
  assert.equal(result.phase,'installed');assert.equal(f.calls.filter(value=>value==='--upgrade-existing').length,1);assert.equal(f.calls.length,3);
  assert.equal(fs.readFileSync(path.join(f.install,'user-data.json'),'utf8'),'preserved');
  await assert.rejects(runMsiInstall(f.planPath,f.sha,f.ready,f.dependencies),{code:'payload_changed'});assert.equal(f.calls.length,3);
});
test('cancelled official installation never starts the MSI transaction',async t=>{
  const f=fixture(t,{cancel:true});await assert.rejects(runMsiInstall(f.planPath,f.sha,f.ready,f.dependencies),{code:'official_update_cancelled'});
  assert.deepEqual(f.calls,['--validate-upgrade']);assert.equal(fs.readFileSync(f.executable,'utf8'),'old exe');
});
test('MSI failure is retained without portable rollback or another launch, and natural exit does not relaunch',async t=>{
  const failed=fixture(t,{failSetup:true});await assert.rejects(runMsiInstall(failed.planPath,failed.sha,failed.ready,failed.dependencies),error=>error.code==='msi_install_failed'&&error.receipt.phase==='rollbackBlocked');assert.equal(failed.calls.length,2);
  const deferred=fixture(t,{official:false,deferred:true});assert.equal((await runMsiInstall(deferred.planPath,deferred.sha,deferred.ready,deferred.dependencies)).phase,'installedDeferred');assert.equal(deferred.calls.length,2);
});
