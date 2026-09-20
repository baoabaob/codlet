import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const bootstrap = (await Promise.all([
  readFile(new URL('../runtime/host-traffic-bundle.cjs', import.meta.url), 'utf8'),
  readFile(new URL('../runtime/host.cjs', import.meta.url), 'utf8'),
])).join('\n');
const identity = { v: 1, pluginId: 'dev.js-bootstrap', generation: 8 };

async function host(t, source, setup) {
  const root = await mkdtemp(path.join(tmpdir(), 'codlet-js-bootstrap-'));
  const entry = path.join(root, 'host.js');
  const snapshot = path.join(root, 'snapshot.js');
  const bootstrapPath = path.join(root, 'bootstrap.cjs');
  await writeFile(snapshot, source);
  await writeFile(bootstrapPath, bootstrap);
  await setup?.(root);
  const child = spawn(process.execPath, ['--no-addons', '--no-experimental-strip-types', '--require', bootstrapPath, '--eval', '', '--', entry, snapshot], {
    cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const frames = [];
  const waiters = [];
  let stderr = '';
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
    assert.ok(path.basename(root).startsWith('codlet-js-bootstrap-'));
    await rm(root, { recursive: true, force: true });
  });
  return {
    child, exited, stderr: () => stderr,
    send(...messages) { child.stdin.write(messages.map(message => JSON.stringify({ ...identity, ...message }) + '\n').join('')); },
    next() {
      if (frames.length) return Promise.resolve(frames.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`host did not produce a frame: ${stderr}`)), 3000);
        waiters.push(value => { clearTimeout(timer); resolve(value); });
      });
    },
    initialize() { this.send({ type: 'request', id: 1, method: 'initialize', params: { protocolVersion: 1, pluginVersion: '1' } }); },
    shutdown(cleanupBudgetMs) { this.send({ type: 'request', id: 2, method: 'shutdown', params: cleanupBudgetMs === undefined ? null : { cleanupBudgetMs } }); },
  };
}

test('retired async subscription callbacks cannot abort the separate cleanup phase', async t => {
  for (const method of ['cdp.event', 'cdp.subscriptionEnded']) {
    const fixture = await host(t, `module.exports = {
      async activate(context) {
        const callback = async () => { await context.cdp.request('Fixture.waitingCallback'); };
        await context.cdp.subscribe({scope:'all'}, callback, callback);
      },
      async deactivate(cleanup) {
        await cleanup.cdp.request('Fixture.cleanup');
        console.log('cleanup-finished');
      }
    };`);
    fixture.initialize();
    const subscribe = await fixture.next();
    fixture.send({ type: 'response', id: subscribe.id, ok: true, result: { subscriptionId: 1 } });
    assert.equal((await fixture.next()).result.ready, true);
    fixture.send({ type: 'notification', method, params: { subscriptionId: 1, event: { method: 'Fixture.event' }, reason: 'fixture-end' } });
    const pending = await fixture.next();
    assert.equal(pending.params.method, 'Fixture.waitingCallback');
    fixture.shutdown(800);
    const cleanup = await fixture.next();
    assert.equal(cleanup.method, 'cleanup.request');
    assert.equal(cleanup.params.params.method, 'Fixture.cleanup');
    fixture.send({ type: 'response', id: cleanup.id, ok: true, result: {} });
    assert.equal((await fixture.next()).ok, true);
    assert.equal((await fixture.exited)[0], 0);
    assert.match(fixture.stderr(), /cleanup-finished/);
  }
});

test('errors in active subscription callbacks still fail their plugin', async t => {
  for (const method of ['cdp.event', 'cdp.subscriptionEnded']) {
    const fixture = await host(t, `module.exports = {
      async activate(context) {
        const callback = async () => { throw new Error('active-callback-failed'); };
        await context.cdp.subscribe({scope:'all'}, callback, callback);
      },
      deactivate() {}
    };`);
    fixture.initialize();
    const subscribe = await fixture.next();
    fixture.send({ type: 'response', id: subscribe.id, ok: true, result: { subscriptionId: 1 } });
    assert.equal((await fixture.next()).result.ready, true);
    fixture.send({ type: 'notification', method, params: { subscriptionId: 1, event: { method: 'Fixture.event' }, reason: 'fixture-end' } });
    assert.equal((await fixture.exited)[0], 1);
    assert.match(fixture.stderr(), /active-callback-failed/);
  }
});

test('host bootstrap delivers a coalesced subscription response and first event before activation completes', async t => {
  const fixture = await host(t, `module.exports = {
    async activate(context) {
      const first = new Promise(resolve => context.cdp.subscribe({scope:'all'}, event => resolve(event)));
      const event = await first;
      await context.cdp.request('Fixture.afterEvent', {method:event.method});
    },
    deactivate() { console.log('cleaned-once'); }
  };`);
  fixture.initialize();
  const subscribe = await fixture.next();
  assert.equal(subscribe.method, 'cdp.subscribe');
  fixture.send(
    { type: 'response', id: subscribe.id, ok: true, result: { subscriptionId: 1 } },
    { type: 'notification', method: 'cdp.event', params: { subscriptionId: 1, event: { method: 'Runtime.fixture', params: {}, sessionId: null } } },
  );
  const request = await fixture.next();
  assert.equal(request.params.method, 'Fixture.afterEvent');
  assert.deepEqual(request.params.params, { method: 'Runtime.fixture' });
  fixture.send({ type: 'response', id: request.id, ok: true, result: {} });
  assert.equal((await fixture.next()).result.ready, true);
  fixture.shutdown();
  const stopped = await fixture.next();
  assert.equal(stopped.id, 2);
  assert.equal(stopped.ok, true);
  assert.equal((await fixture.exited)[0], 0);
  assert.equal(fixture.stderr().match(/cleaned-once/g).length, 1);
});

test('shutdown aborts an initializing JS request and runs deactivate without late activation replies', async t => {
  const fixture = await host(t, `module.exports = {
    activate(context) { return context.cdp.request('Fixture.never'); },
    deactivate() { console.log('cancelled-cleanup'); }
  };`);
  fixture.initialize();
  const pending = await fixture.next();
  assert.equal(pending.method, 'cdp.request');
  fixture.shutdown();
  const reply = await fixture.next();
  assert.equal(reply.id, 2);
  assert.equal(reply.ok, true);
  assert.equal((await fixture.exited)[0], 0);
  assert.match(fixture.stderr(), /cancelled-cleanup/);
});

test('activation errors retain their code and cleanup still runs during shutdown', async t => {
  const fixture = await host(t, `module.exports = {
    activate() { throw Object.assign(new Error('fixture failure'), {code:'fixture_error'}); },
    deactivate() { console.log('failed-cleanup'); }
  };`);
  fixture.initialize();
  const failed = await fixture.next();
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'fixture_error');
  fixture.shutdown();
  assert.equal((await fixture.next()).id, 2);
  assert.equal((await fixture.exited)[0], 0);
  assert.match(fixture.stderr(), /failed-cleanup/);
});

test('a CommonJS dependency back-reference sees the source snapshot without evaluating the changed entry twice', async t => {
  const fixture = await host(t, `
    exports.marker = 'snapshot';
    const marker = require('./helper.js');
    exports.activate = context => context.cdp.request('Fixture.cache', {marker});
    exports.deactivate = () => {};
  `, async root => {
    await writeFile(path.join(root, 'host.js'), "throw new Error('disk entry must not be evaluated again');");
    await writeFile(path.join(root, 'helper.js'), "module.exports = require('./host.js').marker;");
  });
  fixture.initialize();
  const request = await fixture.next();
  assert.equal(request.method, 'cdp.request');
  assert.deepEqual(request.params.params, { marker: 'snapshot' });
  fixture.send({ type: 'response', id: request.id, ok: true, result: {} });
  assert.equal((await fixture.next()).result.ready, true);
  fixture.shutdown();
  assert.equal((await fixture.next()).ok, true);
  assert.equal((await fixture.exited)[0], 0);
});

test('deactivate has a distinct cleanup request phase while ordinary calls and late replies retire', async t => {
  const fixture = await host(t, `let ordinary; module.exports = {
    activate(context) { ordinary = context; return context.cdp.request('Fixture.old'); },
    async deactivate(cleanup) {
      try { await ordinary.cdp.request('Fixture.mustNotRun'); } catch (error) { console.log(error.code); }
      if (!ordinary.signal.aborted || cleanup.signal.aborted) throw new Error('incorrect phase signals');
      await cleanup.cdp.request('Target.detachFromTarget', {sessionId:'old-session'});
    }
  };`);
  fixture.initialize();
  const old = await fixture.next();
  fixture.shutdown(800);
  const cleanup = await fixture.next();
  assert.equal(cleanup.method, 'cleanup.request');
  assert.equal(cleanup.params.method, 'cdp.request');
  assert.equal(cleanup.params.params.method, 'Target.detachFromTarget');
  fixture.send(
    {type:'response', id:old.id, ok:true, result:{late:true}},
    {type:'response', id:cleanup.id, ok:true, result:{}},
  );
  const stopped = await fixture.next();
  assert.equal(stopped.id, 2);
  assert.equal(stopped.ok, true);
  assert.equal((await fixture.exited)[0], 0);
  assert.match(fixture.stderr(), /host_stopping/);
});

test('an unresolved activation Promise does not consume the entire deactivate opportunity', async t => {
  const fixture = await host(t, `module.exports = {
    async activate(context) { await context.cdp.request('Fixture.started'); return new Promise(() => {}); },
    deactivate(cleanup) { return cleanup.core.request('cdp.request', {method:'Fixture.cleanup'}); }
  };`);
  fixture.initialize();
  const activated = await fixture.next();
  fixture.send({type:'response', id:activated.id, ok:true, result:{}});
  fixture.shutdown(800);
  const cleanup = await fixture.next();
  assert.equal(cleanup.method, 'cleanup.request');
  fixture.send({type:'response', id:cleanup.id, ok:true, result:{}});
  assert.equal((await fixture.next()).id, 2);
  assert.equal((await fixture.exited)[0], 0);
});

test('a sequence of cleanup calls shares one total deadline and yields an explicit failure', async t => {
  const fixture = await host(t, `module.exports = {
    activate() {},
    async deactivate(cleanup) {
      await cleanup.cdp.request('Fixture.first');
      await cleanup.cdp.request('Fixture.never', {}, {timeoutMs:15000});
    }
  };`);
  fixture.initialize();
  assert.equal((await fixture.next()).result.ready, true);
  const started = performance.now();
  fixture.shutdown(120);
  const first = await fixture.next();
  await new Promise(resolve => setTimeout(resolve, 50));
  fixture.send({type:'response', id:first.id, ok:true, result:{}});
  assert.equal((await fixture.next()).params.params.method, 'Fixture.never');
  const stopped = await fixture.next();
  assert.equal(stopped.id, 2);
  assert.equal(stopped.ok, false);
  assert.equal(stopped.error.code, 'cleanup_timeout');
  assert.ok(performance.now() - started < 500);
  assert.equal((await fixture.exited)[0], 1);
});
