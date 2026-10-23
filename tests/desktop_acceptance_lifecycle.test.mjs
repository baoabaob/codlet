import test from 'node:test';
import assert from 'node:assert/strict';
import {auditAcceptanceLifecycle,settleAcceptanceLifecycle} from '../scripts/desktop-acceptance-lifecycle.mjs';

const applied=()=>({outcome:'completed',control:{operation:{completion:{report:{outcome:'applied',target_failures:[]}}}}});
function fixture(overrides={}) {
  let generation=0;
  return {pluginId:'owned.fixture',cycles:2,
    async execute(action){if(action!=='enable')generation++;return applied();},
    async readCleanup(){return{retired:true,generation};},async save(){},...overrides};
}
test('lifecycle counts complete cycles and requires new retirement evidence for every destructive transition',async()=>{
  const saved=[];const result=await auditAcceptanceLifecycle(fixture({save:audit=>saved.push(structuredClone(audit))}));
  assert.equal(result.passed,true);assert.equal(result.completedCycles,2);
  assert.deepEqual(result.commands.map(({cycle,action})=>[cycle,action]),[[1,'reload'],[1,'disable'],[1,'enable'],[2,'reload'],[2,'disable'],[2,'enable']]);
  assert.equal(saved.length,7);assert.equal(saved[0].commands.length,1);
});
test('stale cleanup cannot make repeated reload and disable operations pass',async()=>{
  const result=await auditAcceptanceLifecycle(fixture({readCleanup:async()=>({retired:true,generation:1})}));
  assert.equal(result.passed,false);assert.equal(result.completedCycles,0);
  assert.equal(result.commands.length,1);assert.match(result.error,/Stale fixture retirement/);
});
test('a failed target or missing receipt evidence stops the audit',async()=>{
  for(const receipt of [{outcome:'completed'}, {outcome:'completed',control:{operation:{completion:{report:{outcome:'applied',target_failures:[{target:'owned'}]}}}}}]) {
    const result=await auditAcceptanceLifecycle(fixture({execute:async()=>receipt}));
    assert.equal(result.passed,false);assert.equal(result.commands.length,0);
  }
});
test('invalid cycle counts cannot execute a command',async()=>{
  for(const cycles of [0,101,1.5,'2'])await assert.rejects(auditAcceptanceLifecycle(fixture({cycles,execute:()=>{throw Error('executed');}})),/lifecycleCycles/);
});
test('only explicitly unsubmitted busy commands can retry',async()=>{
  let calls=0,generation=0;
  const result=await auditAcceptanceLifecycle(fixture({cycles:1,pause:async()=>{},
    async execute(action){calls++;if(calls===1)throw Object.assign(Error('busy'),{stderr:'package helper: operation was not submitted (Host control endpoint is serving another client); retry the plugin command later to obtain a new receipt\n'});if(action!=='enable')generation++;return applied();},
    readCleanup:()=>({retired:true,generation})}));
  assert.equal(result.passed,true);assert.equal(result.commands.length,3);assert.equal(calls,4);assert.equal(result.unsubmittedBusyRetries,1);
  calls=0;
  const uncertain=await auditAcceptanceLifecycle(fixture({execute:async()=>{calls++;throw Object.assign(Error('unconfirmed'),{stderr:'operation receipt is not confirmed complete'});},pause:async()=>{}}));
  assert.equal(uncertain.passed,false);assert.equal(calls,1);
});

const finalAudit=()=>{
  const receipt=applied();receipt.control.operation.completion.report.generations=[{plugin_id:'owned.fixture',generation:101}];
  return{pluginId:'owned.fixture',passed:true,commands:[{action:'enable',cleanup:{generation:100},receipt}]};
};
test('the final enable waits past an older ready generation and a disabled renderer',async()=>{
  const values=[{generation:99,phase:'ready',reportNodes:1},{phase:'waiting',reportNodes:0},{generation:101,phase:'ready',reportNodes:1}],saved=[];let time=0;
  const result=await settleAcceptanceLifecycle(finalAudit(),{readProbe:async()=>({elapsedMs:time,value:values.shift()}),save:async value=>saved.push(structuredClone(value)),now:()=>time,pause:async ms=>{time+=ms;}});
  assert.equal(result.passed,true);assert.equal(result.finalRenderer.expectedGeneration,101);assert.equal(result.finalRenderer.value.generation,101);
  assert.equal(saved.length,1);assert.equal(time,200);
});
test('stale renderer readiness cannot certify a completed lifecycle audit',async()=>{
  let time=0;const result=await settleAcceptanceLifecycle(finalAudit(),{timeoutMs:250,readProbe:async()=>({value:{generation:99,phase:'ready',reportNodes:1}}),save:async()=>{},now:()=>time,pause:async ms=>{time+=ms;}});
  assert.equal(result.passed,false);assert.match(result.error,/did not become ready/);assert.equal(result.commands.length,1);
});
test('missing final generation evidence cannot finish a lifecycle audit',async()=>{
  const audit=finalAudit();delete audit.commands[0].receipt.control.operation.completion.report.generations;
  const result=await settleAcceptanceLifecycle(audit,{readProbe:async()=>{throw Error('must not poll');},save:async()=>{}});
  assert.equal(result.passed,false);assert.match(result.error,/generation is unconfirmed/);
});
