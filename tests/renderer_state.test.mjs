import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const bootstrap = readFileSync(new URL('../bundled/runtime/bootstrap.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function fixture() {
  const scope = vm.createContext({ setTimeout, clearTimeout, AbortController, TextEncoder });
  vm.runInContext(`(${bootstrap})({world:'main'})`, scope);
  return { scope, runtime: scope.__codletRendererV1, metadata: generation => ({ id: 'dev.stateful', version: '1', generation }), definition: code => vm.runInContext(`({activate(context){this.context=context},deactivate(){this.stopped=true},${code}})`, scope) };
}
test('explicit state snapshots clone JSON and restore after the new generation activates', async () => {
  const f = fixture(), old = f.definition('saveState(){return {schema:1,value:{draft:"saved",pages:[1,2]}}},restoreState(){}');
  await f.runtime.activate(f.metadata(1), old);
  const saved = await f.runtime.__snapshot('dev.stateful', 1);
  assert.deepEqual(plain(saved), { ok: true, snapshot: { schema: 1, value: { draft: 'saved', pages: [1, 2] } } });
  const next = f.definition('restoreState(snapshot,context){if(context!==this.context)throw Error("wrong owner");if(!context.restoringState)throw Error("restore flag missing");this.saved=snapshot}');
  assert.equal((await f.runtime.activate(f.metadata(2), next, saved.snapshot)).ok, true);
  assert.equal(old.stopped, true); assert.equal(next.saved.value.draft, 'saved');
  assert.equal(next.context.generation, 2);
  assert.equal(next.context.restoringState, false);
  await f.runtime.deactivate('dev.stateful', 2);
});
test('a failed or unsupported state transfer retains the active old owner', async () => {
  const f = fixture(), old = f.definition('saveState(){throw Error("cannot checkpoint")},restoreState(){}');
  await f.runtime.activate(f.metadata(1), old);
  assert.equal((await f.runtime.__snapshot('dev.stateful', 1)).ok, false);
  assert.deepEqual(plain(f.runtime.status()), [{ id: 'dev.stateful', generation: 1 }]);
  const snapshot = vm.runInContext('({schema:1,value:{draft:"saved"}})', f.scope);
  assert.equal((await f.runtime.activate(f.metadata(2), f.definition(''), snapshot)).code, 'state_restore_unavailable');
  assert.equal(old.stopped, undefined);
  assert.equal((await f.runtime.__snapshot('dev.stateful', 2)).code, 'plugin_deactivated');
  await f.runtime.deactivate('dev.stateful', 1);
});
test('snapshot validation rejects functions, cycles, sparse arrays, prototypes, accessors and oversized state', async () => {
  for (const expression of ['{schema:1,value:{callback(){}}}', '(()=>{const value={};value.self=value;return {schema:1,value}})()', '{schema:1,value:[,1]}', '{schema:1,value:new Date()}', '{schema:1,get value(){throw Error("accessor executed")}}', '{schema:1,value:"x".repeat(256*1024)}', '{schema:1,value:NaN}']) {
    const f = fixture(), definition = f.definition(`saveState(){return (${expression})},restoreState(){}`);
    await f.runtime.activate(f.metadata(1), definition);
    const result = await f.runtime.__snapshot('dev.stateful', 1);
    assert.equal(result.ok, false, expression);
    assert.match(result.code, /^state_snapshot_/);
    assert.notEqual(result.error, 'accessor executed');
    assert.equal(definition.stopped, undefined);
    await f.runtime.deactivate('dev.stateful', 1);
  }
});
test('legacy renderer definitions explicitly report no state contract', async () => {
  const f = fixture(); await f.runtime.activate(f.metadata(1), f.definition(''));
  assert.deepEqual(plain(await f.runtime.__snapshot('dev.stateful', 1)), { ok: true, snapshot: null });
  await f.runtime.deactivate('dev.stateful', 1);
});
test('state checkpoint rejects new ordinary writes and waits for accepted responses and their state updates', async () => {
  const f = fixture(), requests = [], capability = { name: 'dev.state', api: 1, scope: 'target' };
  f.scope.bridge = payload => requests.push(JSON.parse(payload));
  const definition = f.definition('activate(context){globalThis.ctx=context;globalThis.value=0},saveState(){return {schema:1,value:globalThis.value}},restoreState(){}');
  await f.runtime.activate({ ...f.metadata(1), binding: 'bridge', requires: [capability] }, definition);
  const accepted = vm.runInContext('ctx.rpc.request({name:"dev.state",api:1,scope:"target"},"write",{}).then(result=>{globalThis.value=result})', f.scope);
  const saving = f.runtime.__snapshot('dev.stateful', 1);
  await assert.rejects(f.scope.ctx.rpc.request(capability, 'new-write', {}), { code: 'core_updating' });
  assert.throws(() => f.scope.ctx.rpc.notify(capability, 'new-notification', {}), { code: 'core_updating' });
  assert.equal(requests.length, 1);
  f.runtime.__rpcReceive('bridge', { v: 1, type: 'response', id: requests[0].id, ok: true, result: 41 });
  await accepted;
  assert.deepEqual(plain(await saving), { ok: true, snapshot: { schema: 1, value: 41 } });
  assert.equal(f.runtime.__resume('dev.stateful', 1).ok, true);
  const resumed = f.scope.ctx.rpc.request(capability, 'new-write', {});
  assert.equal(requests.length, 2);
  f.runtime.__rpcReceive('bridge', { v: 1, type: 'response', id: requests[1].id, ok: true, result: 'accepted' });
  assert.equal(await resumed, 'accepted');
  await f.runtime.deactivate('dev.stateful', 1);
});
test('checkpoint settles a broker-accepted invocation and its bound nested RPC while rejecting unadmitted invocations', async () => {
  const f = fixture(), requests = [], capability = { name: 'dev.state', api: 1, scope: 'target' };
  f.scope.bridge = payload => requests.push(JSON.parse(payload));
  const definition = f.definition('activate(context){globalThis.value=0;context.rpc.provide({name:"dev.state",api:1,scope:"target"},"nested",async(_,invocation)=>{const result=await invocation.rpc.request({name:"dev.state",api:1,scope:"target"},"inner",{});globalThis.value=result;return result})},saveState(){return {schema:1,value:globalThis.value}},restoreState(){}');
  await f.runtime.activate({ ...f.metadata(1), binding: 'bridge', requires: [capability], provides: [capability] }, definition);
  const envelope = { v: 1, type: 'request', pluginId: 'caller', generation: 1, id: 1, capability, method: 'nested', params: {}, coreInvocation: { token: 'accepted', remainingMs: 2000, depth: 1, caller: { pluginId: 'caller', generation: 1, targetId: 'target', documentEpoch: 1 }, scope: { kind: 'target', targetId: 'target', epoch: 1 } } };
  const accepted = f.runtime.__rpcInvoke('bridge', envelope);
  const saving = f.runtime.__snapshot('dev.stateful', 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests[0].parentToken, 'accepted');
  const { coreInvocation: discarded, ...unadmitted } = envelope;
  assert.equal((await f.runtime.__rpcInvoke('bridge', unadmitted)).code, 'core_updating');
  f.runtime.__rpcReceive('bridge', { v: 1, type: 'response', id: requests[0].id, ok: true, result: 17 });
  assert.deepEqual(plain(await accepted), { ok: true, value: 17 });
  assert.equal((await saving).snapshot.value, 17);
  await f.runtime.deactivate('dev.stateful', 1);
});

test('snapshot requires paired restore hook before calling saveState and old generation can resume',async()=>{
 const f=fixture(),definition=f.definition('saveState(){globalThis.saved=true;return {schema:1,value:null}}');
 await f.runtime.activate(f.metadata(1),definition);
 const result=await f.runtime.__snapshot('dev.stateful',1);assert.equal(result.code,'state_restore_unsupported');assert.equal(f.scope.saved,undefined);
 assert.equal(f.runtime.__resume('dev.stateful',1).ok,true);assert.equal(f.runtime.status()[0].generation,1);
 await f.runtime.deactivate('dev.stateful',1);
});

test('retired checkpointed generation reports deactivation before its former update gate',async()=>{
 const f=fixture(),definition=f.definition('');await f.runtime.activate(f.metadata(1),definition);
 assert.equal((await f.runtime.__snapshot('dev.stateful',1)).ok,true);await f.runtime.deactivate('dev.stateful',1);
 await assert.rejects(definition.context.rpc.request('ping',{}),{code:'plugin_deactivated'});
 assert.throws(()=>definition.context.rpc.notify('ping',{}),{code:'plugin_deactivated'});
});
