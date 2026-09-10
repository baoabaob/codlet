import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const bootstrap = await readFile(new URL('../runtime/host.cjs', import.meta.url), 'utf8');
const capability = { name: 'dev.host-test', api: 1, scope: 'target' };
const caller = { pluginId: 'dev.renderer-caller', generation: 9, targetId: 'worker-target', documentEpoch: 12 };
const identity = { v: 1, pluginId: 'dev.host-provider', generation: 8 };

async function host(t, source) {
  const root = await mkdtemp(path.join(tmpdir(), 'codlet-host-capability-'));
  const entry = path.join(root, 'host.js');
  const snapshot = path.join(root, 'snapshot.js');
  await writeFile(snapshot, source);
  const child = spawn(process.execPath, ['--no-addons', '--no-experimental-strip-types', '--input-type=commonjs', '--eval', bootstrap, '--', entry, snapshot], {
    cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const frames = [], waiters = [];
  let stderr = '', nextId = 1;
  child.stderr.on('data', chunk => { stderr += chunk; });
  const reader = createInterface({ input: child.stdout });
  reader.on('line', line => {
    const frame = JSON.parse(line);
    if (waiters.length) waiters.shift()(frame); else frames.push(frame);
  });
  const exited = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await exited;
    reader.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('codlet-host-capability-'));
    await rm(root, { recursive: true, force: true });
  });
  const fixture = {
    root, child, exited, stderr: () => stderr,
    send(...messages) { child.stdin.write(messages.map(message => JSON.stringify({ ...identity, ...message }) + '\n').join('')); },
    next() {
      if (frames.length) return Promise.resolve(frames.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`host did not produce a frame: ${stderr}`)), 4000);
        waiters.push(value => { clearTimeout(timer); resolve(value); });
      });
    },
    request(method, params) { const id = nextId++; this.send({ type: 'request', id, method, params }); return id; },
    invoke(method, params = null, remainingMs = 2000) {
      return this.request('capability.invoke', { capability, method, params, caller, remainingMs });
    },
    async stop() {
      const id = this.request('shutdown', { cleanupBudgetMs: 800 });
      const result = await this.next();
      assert.equal(result.id, id); assert.equal(result.ok, true);
      assert.equal((await exited)[0], 0, stderr);
    },
  };
  fixture.request('initialize', { protocolVersion: 1, pluginVersion: '1', provides: [capability] });
  const ready = await fixture.next();
  assert.equal(ready.id, 1); assert.equal(ready.ok, true, JSON.stringify(ready));
  return fixture;
}

test('Host provide validates declarations and duplicates, and handlers receive frozen Core identity', async t => {
  const fixture = await host(t, `const cap = ${JSON.stringify(capability)}; module.exports = {
    activate(context) {
      const errors = [];
      for (const supplied of [{...cap,api:2}, {...cap,scope:'runtime'}, {...cap,name:'dev.other'}]) {
        try { context.rpc.provide(supplied, 'wrong', () => {}); } catch(error) { errors.push(error.code); }
      }
      const registered = context.rpc.provide(cap, 'inspect', (params, invocation) => ({
        registered, errors, params, pluginId:invocation.pluginId, generation:invocation.generation,
        capability:invocation.capability, method:invocation.method, caller:invocation.caller,
        frozen:[Object.isFrozen(invocation),Object.isFrozen(invocation.caller),Object.isFrozen(invocation.capability)],
        remaining:invocation.remainingMs(), aborted:invocation.signal.aborted,
      }));
      try { context.rpc.provide(cap, 'inspect', () => {}); } catch(error) { errors.push(error.code); }
    }, deactivate() {}
  };`);
  const id = fixture.invoke('inspect', { caller: { pluginId: 'forged' } });
  const response = await fixture.next();
  assert.equal(response.id, id); assert.equal(response.ok, true);
  assert.deepEqual(response.result.caller, caller);
  assert.deepEqual(response.result.frozen, [true, true, true]);
  assert.equal(response.result.pluginId, identity.pluginId);
  assert.equal(response.result.generation, identity.generation);
  assert.deepEqual(response.result.capability, capability);
  assert.equal(response.result.method, 'inspect');
  assert.deepEqual(response.result.registered, { ok: true });
  assert.deepEqual(response.result.errors, Array(4).fill('invalid_provider'));
  assert.ok(response.result.remaining > 0 && response.result.remaining <= 2000);
  assert.equal(response.result.aborted, false);
  await fixture.stop();
});

test('managed async CDP descendants carry one invocation token, cancel without late replies, and leave cleanup independent', async t => {
  const fixture = await host(t, `const cap = ${JSON.stringify(capability)}; const fs = require('node:fs'); let ordinary; module.exports = {
    activate(context) {
      ordinary = context;
      context.rpc.provide(cap, 'hold', async (params, invocation) => {
        await Promise.resolve();
        try { await context.cdp.request('Arbitrary.extensionMethod', {}, {timeoutMs:15000}); }
        catch(error) {
          let continuation;
          try { await context.core.request('cdp.request', {method:'Fixture.mustNotRun'}); }
          catch(failure) { continuation = failure.code; }
          fs.writeFileSync('cancelled.json', JSON.stringify({aborted:invocation.signal.aborted,code:error.code,continuation}));
        }
        return {late:true};
      });
      context.rpc.provide(cap, 'ping', () => ({alive:true}));
    },
    async deactivate(cleanup) {
      let rejected = false;
      try { await ordinary.core.request('cleanup.request', {method:'cdp.request',params:{method:'Fixture.mustNotRun'}}, 15000, undefined, true); }
      catch(error) { rejected = error.code === 'host_stopping'; }
      if(!rejected) throw new Error('ordinary Core handle borrowed cleanup admission');
      return cleanup.cdp.request('Fixture.cleanup');
    }
  };`);
  const held = fixture.invoke('hold');
  const child = await fixture.next();
  assert.equal(child.type, 'request');
  assert.equal(child.method, 'capability.request');
  assert.equal(child.params.invocationId, held);
  assert.equal(child.params.method, 'cdp.request');
  assert.equal(child.params.params.method, 'Arbitrary.extensionMethod');
  fixture.send({ type:'notification', method:'capability.cancel', params:{invocationId:held,code:'invocation_cancelled',message:'caller retired'} });
  const ping = fixture.invoke('ping');
  const alive = await fixture.next();
  assert.equal(alive.id, ping); assert.deepEqual(alive.result, {alive:true});
  assert.deepEqual(JSON.parse(await readFile(path.join(fixture.root, 'cancelled.json'), 'utf8')), {
    aborted:true, code:'invocation_cancelled', continuation:'invocation_cancelled',
  });
  fixture.send({ type:'response',id:child.id,ok:true,result:{late:true} });
  const stop = fixture.request('shutdown', {cleanupBudgetMs:800});
  const cleanup = await fixture.next();
  assert.equal(cleanup.method, 'cleanup.request');
  assert.equal(cleanup.params.params.method, 'Fixture.cleanup');
  assert.equal(cleanup.params.invocationId, undefined);
  fixture.send({type:'response',id:cleanup.id,ok:true,result:{}});
  assert.equal((await fixture.next()).id, stop);
  assert.equal((await fixture.exited)[0], 0, fixture.stderr());
});

test('timeout closes async descendants while method and oversized-result errors preserve the provider', async t => {
  const fixture = await host(t, `const cap = ${JSON.stringify(capability)}; module.exports = {
    activate(context) {
      context.rpc.provide(cap, 'wait', async () => {
        await context.cdp.request('Fixture.never', {}, {timeoutMs:15000});
        return {late:true};
      });
      context.rpc.provide(cap, 'oversize', () => 'x'.repeat(1024 * 1024));
      context.rpc.provide(cap, 'ping', () => 'alive');
    }, deactivate() {}
  };`);
  const wait = fixture.invoke('wait', null, 100);
  const child = await fixture.next();
  assert.equal(child.params.invocationId, wait);
  const timedOut = await fixture.next();
  assert.equal(timedOut.id, wait); assert.equal(timedOut.ok, false);
  assert.equal(timedOut.error.code, 'request_timeout');
  for (const [method, code] of [['oversize','response_too_large'], ['missing','method_not_found']]) {
    const id = fixture.invoke(method);
    const result = await fixture.next();
    assert.equal(result.id, id); assert.equal(result.error.code, code);
  }
  fixture.send({type:'response',id:child.id,ok:true,result:{late:true}});
  const ping = fixture.invoke('ping');
  const result = await fixture.next();
  assert.equal(result.id, ping); assert.equal(result.result, 'alive');
  await fixture.stop();
});

test('Host invocation and endpoint tables have independent finite bounds', async t => {
  const fixture = await host(t, `const cap = ${JSON.stringify(capability)}; module.exports = {
    activate(context) {
      context.rpc.provide(cap, 'hold', () => new Promise(() => {}));
      for(let index=1;index<256;index++) context.rpc.provide(cap, 'endpoint-'+index, () => index);
      try { context.rpc.provide(cap, 'overflow', () => {}); throw new Error('unbounded endpoints'); }
      catch(error) { if(error.code !== 'request_limit') throw error; }
    }, deactivate() {}
  };`);
  const active = Array.from({length:4}, () => fixture.invoke('hold'));
  const overflow = fixture.invoke('hold');
  const rejected = await fixture.next();
  assert.equal(rejected.id, overflow); assert.equal(rejected.error.code, 'request_limit');
  for(const id of active) fixture.send({type:'notification',method:'capability.cancel',params:{invocationId:id,code:'invocation_cancelled',message:'cancel'}});
  const ping = fixture.invoke('endpoint-1');
  const response = await fixture.next();
  assert.equal(response.id, ping); assert.equal(response.result, 1);
  await fixture.stop();
});
