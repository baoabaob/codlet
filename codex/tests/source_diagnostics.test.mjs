import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {sourceDiagnostic}=createRequire(import.meta.url)('../host/source-diagnostics.cjs');
test('source diagnostics retain bounded readiness fields without requests, credentials or arbitrary nested data',()=>{
  const report=sourceDiagnostic({pid:42,startedUnixMs:1000,finishedUnixMs:2000,phase:'startup',appReady:true,sourceConnected:true,
    source:{token:'private-secret'},request:{body:'private-secret'},error:'error message private-secret',
    recovery:{attempted:true,calls:2,constructors:1,instances:3,transports:3,processes:3,localProcesses:2,eligible:1,reconnected:1,token:'private-secret'},
    desktop:{available:false,reason:'hook_unavailable',modules:{bootstrap:true,main:false,secret:'private-secret'},
      bindingErrors:{main:'ReferenceError',secret:'private-secret'},deferredBindings:1,observedModules:17,
      observedModuleInventory:[{name:'main-fixture.js',hash:'b'.repeat(64),classes:12,source:'private-secret'},{name:'C:/private-secret.js',hash:'c'.repeat(64),classes:1}],
      bindingCandidates:{network:1,fetch:0,stdio:NaN,connection:-1,secret:'private-secret'},bindingReasons:{fetch:'contract_unavailable',stdio:'private-secret',secret:'private-secret'},
      mismatch:{name:'main-fixture.js',observedSha256:'a'.repeat(64),secret:'private-secret'}},
    backend:{available:false,reason:'child_unavailable',backendRootsPrepared:0,backendRootsDeclined:0,command:'private-secret',probeDiagnostic:{phase:'initialize',outcome:'child_exit',exitCode:2,systemCode:'private-secret',stderr:'private-secret'}}});
  assert.equal(report.phase,'startup');assert.equal(report.desktop.modules.bootstrap,true);assert.equal(report.desktop.bindingErrors.main,'ReferenceError');
  assert.equal(report.backend.reason,'child_unavailable');assert.equal(report.error,null);
  assert.deepEqual(report.recovery,{attempted:true,calls:2,constructors:1,instances:3,transports:3,processes:3,localProcesses:2,eligible:1,reconnected:1});
  assert.deepEqual(report.backend.probeDiagnostic,{phase:'initialize',outcome:'child_exit',exitCode:2,systemCode:null});
  assert.equal(report.desktop.observedModules,17);assert.deepEqual(report.desktop.bindingCandidates,{network:1,fetch:0,stdio:null,connection:null});
  assert.equal(report.desktop.bindingReasons.fetch,'contract_unavailable');assert.equal(report.desktop.bindingReasons.stdio,null);
  assert.deepEqual(report.desktop.observedModuleInventory,[{name:'main-fixture.js',hash:'b'.repeat(64),classes:12}]);
  assert.equal(JSON.stringify(report).includes('private-secret'),false);
});
