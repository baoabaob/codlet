import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const {verifyBackend,prepareBackendLaunch}=createRequire(import.meta.url)('../host/backend-launch.cjs');
const contract={api:1,initialize:true,configRead:true,accountRead:true,routing:'runtime',providerOverrides:['openai_base_url']};

test('an unknown executable identity can use a proven contract, while a changed file requires a new probe',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codlet-backend-contract-'));
  t.after(()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true});});
  const executable=path.join(root,process.platform==='win32'?'codex.exe':'codex');
  fs.writeFileSync(executable,'synthetic identity; this file is never executed');
  const identity=verifyBackend(executable);
  assert.equal(identity.recorded,false);
  const input={executable,arguments:['app-server','--stdio'],originalEnvironment:{MARKER:'kept'},providerRoutes:{openai_base_url:'http://127.0.0.1:34567/owned/'},compatibility:{...identity,contract}};
  const launch=prepareBackendLaunch(input);
  assert.equal(launch.originalEnvironment,undefined);
  assert.equal(launch.environment,input.originalEnvironment);
  assert.deepEqual(launch.arguments,['app-server','--stdio','-c','openai_base_url="http://127.0.0.1:34567/owned/"']);
  assert.throws(()=>prepareBackendLaunch({...input,compatibility:{...identity}}),{code:'backend_contract_unavailable'});
  assert.throws(()=>prepareBackendLaunch({...input,compatibility:{...identity,contract:{...contract,routing:'recorded'}}}),{code:'backend_contract_unavailable'});
  assert.throws(()=>prepareBackendLaunch({...input,providerRoutes:{'model_providers.unprobed.base_url':'http://127.0.0.1:34567/other/'}}),{code:'backend_contract_unavailable'});
  fs.appendFileSync(executable,'repacked');
  assert.throws(()=>prepareBackendLaunch(input),{code:'backend_identity_changed'});
  const updated=prepareBackendLaunch({...input,compatibility:{...verifyBackend(executable),contract}});
  assert.deepEqual(updated.arguments,launch.arguments);
});
