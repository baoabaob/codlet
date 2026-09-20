import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCoreServicesRuntime } = require('../runtime/core-services.cjs');

async function until(predicate, message) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('groups map to exact Core methods and credentials never expose plaintext resolve', async () => {
  const root = new AbortController();
  const calls = [];
  const services = createCoreServicesRuntime({
    rootSignal: root.signal,
    detach: callback => callback(),
    request(method, params, options) {
      calls.push({ method, params, options });
      return { ok: true };
    },
  });

  await services.storage.snapshot();
  await services.credentials.list({ origin: 'https://api.example.test' });
  await services.files.writeAtomic({ path: 'C:/fixture', expectedVersion: null, data: 'YQ==' });
  await services.processes.write({ process: 'process_1', bytes: 'AAH/', sequence: '0' });
  await services.network.createProfile({ proxy: 'direct' });
  await services.desktop.notify({ title: 'Fixture', body: 'SDK mapping only', actions: [] });
  await services.desktop.clipboardRead();
  await services.desktop.registerShortcut({ shortcut: 'Ctrl+Shift+F12', actionId: 'fixture' });

  assert.deepEqual(calls.map(call => call.method), [
    'storage.snapshot', 'credentials.list', 'files.writeAtomic',
    'processes.write', 'network.createProfile', 'desktop.notify',
    'desktop.clipboardRead', 'desktop.registerShortcut',
  ]);
  assert.equal(calls[0].params, null);
  assert.deepEqual(calls[3].params.bytes, [0, 1, 255]);
  assert.deepEqual(calls[6].params, {});
  assert.equal(calls.every(call => call.options.signal === root.signal), true);
  assert.equal('resolve' in services.credentials, false);
  await services.close();
});

test('task runner detaches claim and callback work and reports progress and success through short RPCs', async () => {
  const root = new AbortController();
  const calls = [];
  let detached = 0;
  let claimDelivered = false;
  const services = createCoreServicesRuntime({
    rootSignal: root.signal,
    detach(callback) { detached++; return callback(); },
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'tasks.register') return { runner: 'runner_1' };
      if (method === 'tasks.claim') {
        if (!claimDelivered) {
          claimDelivered = true;
          return { tasks: [{ task: 'task_1', claim: 'claim_1', input: { value: 7 }, remainingMs: 5000, deadlineAt: Date.now() + 5000 }], cancellations: [] };
        }
        await new Promise(resolve => setTimeout(resolve, 10));
        return { tasks: [], cancellations: [] };
      }
      if (method === 'tasks.progress') return { task: params.task, state: 'running' };
      if (method === 'tasks.finish') return { task: params.task, state: params.state };
      if (method === 'tasks.unregister') return { unregistered: true };
      throw new Error(`unexpected ${method}`);
    },
  });
  const runner = await services.tasks.register('fixture', async (input, invocation) => {
    assert.deepEqual(input, { value: 7 });
    assert.equal(invocation.signal.aborted, false);
    await invocation.progress({ step: 1 });
    return { answer: input.value * 2 };
  });
  await until(() => calls.some(call => call.method === 'tasks.finish'), 'task did not finish');
  const finish = calls.find(call => call.method === 'tasks.finish');
  assert.deepEqual(finish.params, {
    task: 'task_1', claim: 'claim_1', state: 'succeeded', result: { answer: 14 },
  });
  assert.equal(detached >= 2, true);
  assert.deepEqual(await runner.close(), { unregistered: true });
  await services.close();
});

test('task cancellation aborts the callback and acknowledges cancelled without leaking runner errors', async () => {
  const root = new AbortController();
  const calls = [];
  let claim = 0;
  const services = createCoreServicesRuntime({
    rootSignal: root.signal,
    detach: callback => callback(),
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'tasks.register') return { runner: 'runner_cancel' };
      if (method === 'tasks.claim') {
        claim++;
        if (claim === 1) return { tasks: [{ task: 'task_cancel', claim: 'claim_cancel', input: null, remainingMs: 5000, deadlineAt: Date.now() + 5000 }], cancellations: [] };
        await new Promise(resolve => setTimeout(resolve, 5));
        return { tasks: [], cancellations: [{ task: 'task_cancel', state: 'running', cancelRequested: true }] };
      }
      if (method === 'tasks.finish') return { task: params.task, state: params.state };
      if (method === 'tasks.unregister') return { unregistered: true };
      throw new Error(`unexpected ${method}`);
    },
  });
  const runner = await services.tasks.register('cancel-fixture', (_input, invocation) => new Promise((resolve, reject) => {
    invocation.signal.addEventListener('abort', () => reject(invocation.signal.reason), { once: true });
  }));
  await until(() => calls.some(call => call.method === 'tasks.finish'), 'cancelled task was not acknowledged');
  assert.equal(calls.find(call => call.method === 'tasks.finish').params.state, 'cancelled');
  await runner.close();
  await services.close();
});

test('a callback that ignores cancellation and returns is reported as succeeded', async () => {
  const root = new AbortController();
  const calls = [];
  let claim = 0;
  const services = createCoreServicesRuntime({
    rootSignal: root.signal,
    detach: callback => callback(),
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'tasks.register') return { runner: 'runner_ignored_cancel' };
      if (method === 'tasks.claim') {
        claim++;
        if (claim === 1) return { tasks: [{ task: 'task_committed', claim: 'claim_committed', input: null, remainingMs: 5000, deadlineAt: Date.now() + 5000 }], cancellations: [] };
        await new Promise(resolve => setTimeout(resolve, 5));
        return { tasks: [], cancellations: [{ task: 'task_committed', state: 'running', cancelRequested: true }] };
      }
      if (method === 'tasks.finish') return { task: params.task, state: params.state };
      if (method === 'tasks.unregister') return { unregistered: true };
      throw new Error(`unexpected ${method}`);
    },
  });
  const runner = await services.tasks.register('ignored-cancel-fixture', (_input, invocation) => new Promise(resolve => {
    invocation.signal.addEventListener('abort', () => resolve({ committed: true }), { once: true });
  }));
  await until(() => calls.some(call => call.method === 'tasks.finish'), 'successful task was not acknowledged');
  const finish = calls.find(call => call.method === 'tasks.finish');
  assert.deepEqual(finish.params, {
    task: 'task_committed', claim: 'claim_committed', state: 'succeeded', result: { committed: true },
  });
  await runner.close();
  await services.close();
});

test('root abort tolerates a synchronously failing unregister transport', () => {
  const root = new AbortController();
  const services = createCoreServicesRuntime({
    rootSignal: root.signal,
    detach: callback => callback(),
    request(method) {
      if (method === 'tasks.register') return { runner: 'runner_abort' };
      if (method === 'tasks.claim') return new Promise(() => {});
      throw new Error('transport closed');
    },
  });
  return services.tasks.register('abort-fixture', () => {}).then(() => {
    assert.doesNotThrow(() => root.abort(new Error('shutdown')));
  });
});

test('renderer document lifetime aborts active callbacks and does not fabricate a task outcome', async () => {
  const root = new AbortController();
  const calls = [];
  let delivered = false;
  let callbackSignal;
  const services = createCoreServicesRuntime({
    rootSignal: root.signal,
    detach: callback => callback(),
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'tasks.register') return { runner: 'runner_document' };
      if (method === 'tasks.claim' && !delivered) {
        delivered = true;
        return { tasks: [{ task: 'task_document', claim: 'claim_document', input: null, remainingMs: 5000, deadlineAt: Date.now() + 5000 }], cancellations: [] };
      }
      if (method === 'tasks.claim') return new Promise(() => {});
      if (method === 'tasks.unregister') return { unregistered: true };
      throw new Error(`unexpected ${method}`);
    },
  });
  await services.tasks.register('document-fixture', (_input, invocation) => {
    callbackSignal = invocation.signal;
    return new Promise((_resolve, reject) => invocation.signal.addEventListener('abort', () => reject(invocation.signal.reason), { once: true }));
  });
  await until(() => callbackSignal, 'callback did not start');
  root.abort(new Error('document retired'));
  await until(() => callbackSignal.aborted, 'callback was not aborted with the document');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls.some(call => call.method === 'tasks.finish'), false);
  assert.equal(calls.some(call => call.method === 'tasks.unregister'), true);
});
