import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createSdkHost } = createRequire(import.meta.url)('../runtime/sdk-host.cjs');

function fixture(source, extra = {}) {
  const controller = new AbortController();
  const log = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(key => [key, () => {}]));
  const context = { plugin: { id: 'test.compute', version: '1', generation: 1 }, root: '/fixture', signal: controller.signal, log, ...extra };
  const plugin = createSdkHost({ source, filename: '/fixture/host.js' });
  return { plugin, context, controller };
}

test('SDK Host computes without ambient Node, import loaders or host function prototypes', async () => {
  const values = [];
  const { plugin, context } = fixture(`module.exports = {
    async activate(context) {
      for (const name of ['process', 'Buffer', 'global', '__codletBridge']) {
        if (typeof globalThis[name] !== 'undefined') throw new Error(name + ' leaked');
      }
      for (const entry of ['node:fs', 'node:http', 'node:child_process', './disk.js']) {
        try { require(entry); throw new Error('import accepted'); }
        catch (error) { if (error.code !== 'sdk_import_denied') throw error; }
      }
      try { context.core.request.constructor('return process')(); throw new Error('constructor escaped'); }
      catch (error) { if (error.name !== 'EvalError') throw error; }
      try { globalThis.constructor.constructor('return process')(); throw new Error('global constructor escaped'); }
      catch (error) { if (error.name !== 'EvalError') throw error; }
      const sum = Array.from({length:1000}, (_, n) => n).reduce((a, b) => a + b, 0);
      await new Promise(resolve => setTimeout(resolve, 1));
      await context.core.request('Fixture.compute', {sum, bytes: new TextEncoder().encode('文').length});
    }, deactivate() {}
  };`, { core: { request: async (method, params) => { values.push({ method, params }); return {}; } } });
  await plugin.activate(context);
  assert.deepEqual(values, [{ method: 'Fixture.compute', params: { sum: 499500, bytes: 3 } }]);
  await plugin.deactivate(context);
});

test('SDK entry admission rejects dynamic loaders before their foreign errors can reach plugin code', () => {
  for (const source of [
    "module.exports={async activate(){await import('node:fs')},deactivate(){}};",
    "module.exports={async activate(){await `${await import /*comment*/ ('node:http')}`},deactivate(){}};",
    "module.exports={activate(){return import('node:child_process').catch(e=>e.constructor.constructor('return process')())},deactivate(){}};",
  ]) assert.throws(() => fixture(source), {code:'sdk_import_denied'});
  assert.doesNotThrow(() => fixture("// import('node:fs') is unavailable\nmodule.exports={activate(){return 'import text';},deactivate(){}};"));
});

test('SDK denial results and responses retain local prototypes and preserve broker denial', async () => {
  let passed = false;
  const { plugin, context } = fixture(`module.exports={
    async activate(context) {
      try { await context.core.request('host.process.run', {}); throw new Error('broker accepted'); }
      catch(error) {
        if (error.code !== 'permission_denied' || !(error instanceof Error)) throw error;
        try { error.constructor.constructor('return process')(); throw new Error('error leaked Node'); }
        catch(nested) { if (nested.name !== 'EvalError') throw nested; }
      }
      const result=await context.core.request('read', {});
      if (!(result.bytes instanceof Uint8Array) || result.bytes[0] !== 23) throw new Error('bad bytes');
      await context.done();
    },deactivate(){}};`, {
    core: { request: async method => { if (method === 'host.process.run') throw Object.assign(new Error('explicit grant required'), { code: 'permission_denied' }); return { bytes: Uint8Array.from([23]) }; } },
    done: () => { passed = true; },
  });
  await plugin.activate(context); assert.equal(passed, true); await plugin.deactivate(context);
});

test('SDK callbacks, opaque target handles and abort signals keep the underlying SDK ownership', async () => {
  const scope = Object.freeze({ kind: 'target', close: async () => ({ closed: true }) });
  let handler;
  let targetMatched = false;
  const { plugin, context, controller } = fixture(`module.exports={
    async activate(context) {
      const scope=await context.rpc.target({sessionId:'owned'});
      await context.rpc.request({}, 'read', {}, {scope});
      context.rpc.provide({}, 'twice', async (input, invocation) => ({value:input.value*2, aborted:invocation.signal.aborted}));
      context.signal.addEventListener('abort', () => context.report(context.signal.reason.code));
    },deactivate(){}};`, {
    rpc: { target: async () => scope, request: async (_cap, _method, _params, options) => { targetMatched = options.scope === scope; }, provide: (_cap, _method, callback) => { handler = callback; return { ok: true }; } },
    report: code => { assert.equal(code, 'host_stopping'); },
  });
  await plugin.activate(context);
  assert.equal(targetMatched, true);
  assert.deepEqual(await handler({value:21}, {signal:controller.signal}), {value:42, aborted:false});
  controller.abort(Object.assign(new Error('retired'), {code:'host_stopping'}));
  await plugin.deactivate(context);
});

test('SDK stream callbacks move bytes through the JSON bridge without exposing Node Buffer', async () => {
  const { plugin, context } = fixture(`module.exports={
    async activate(context) {
      const stream=await context.read(); let total=0;
      for await (const bytes of stream) total += bytes[0];
      await context.write((async function*(){yield new Uint8Array([total]);})());
    },deactivate(){}};`, {
    read: async () => (async function* () { yield Uint8Array.from([21]); yield Buffer.from([21]); })(),
    write: async stream => { let result; for await (const bytes of stream) result = bytes; assert.deepEqual(result, Uint8Array.from([42])); },
  });
  await plugin.activate(context); await plugin.deactivate(context);
});

test('long-lived callback runners reclaim invocation methods and never rebind an old handle', async () => {
  const callbacks = new Map();
  const { plugin, context } = fixture(`let previous;module.exports={activate(context){
    context.provide('run',async(_input,invocation)=>{previous=invocation;await invocation.progress({});return invocation.remainingMs();});
    context.provide('old',async()=>previous.remainingMs());
  },deactivate(){}};`, { provide: (name, callback) => { callbacks.set(name, callback); } });
  await plugin.activate(context);
  for (let index = 0; index < 1500; index++) {
    const owner = new AbortController();
    assert.equal(await callbacks.get('run')(null, { signal: owner.signal, remainingMs: () => index, progress: async () => {}, rpc: { request: async () => {} } }), index);
    owner.abort(Object.assign(new Error('invocation ended'), { code: 'invocation_cancelled' }));
  }
  await assert.rejects(callbacks.get('old')(), { code: 'sdk_handle_invalid' });
  const next = new AbortController();
  assert.equal(await callbacks.get('run')(null, { signal: next.signal, remainingMs: () => 9000, progress: async () => {} }), 9000);
  next.abort();
  await assert.rejects(callbacks.get('old')(), { code: 'sdk_handle_invalid' });
  await plugin.deactivate(context);
});

test('a callback-returned stream keeps its lease methods after handler completion and retires their descendants at lease end', async () => {
  let callback;
  const { plugin, context } = fixture(`module.exports={activate(context){context.provide(async(request)=>request.body);},deactivate(){}};`, { provide: value => { callback = value; } });
  await plugin.activate(context);
  const owner = new AbortController();
  const stream = await callback({ body: (async function* () { yield Uint8Array.from([7]); yield Uint8Array.from([8]); })() }, { signal: owner.signal });
  const iterator = stream[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { done: false, value: Uint8Array.from([7]) });
  owner.abort(Object.assign(new Error('stream lease ended'), { code: 'stream_retired' }));
  await assert.rejects(iterator.next(), { code: 'sdk_handle_invalid' });
  await plugin.deactivate(context);
});

test('compute realm retirement rejects pending SDK waiters and retained callback wrappers', async () => {
  let callback, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const { plugin, context } = fixture(`module.exports={async activate(context){context.provide(async()=>42);await context.wait();},deactivate(){}};`, {
    provide: value => { callback = value; }, wait: () => { entered(); return new Promise(() => {}); },
  });
  const activation = plugin.activate(context);
  const rejected = assert.rejects(activation, { code: 'host_stopping' });
  await started;
  await plugin.deactivate(context);
  await rejected;
  await assert.rejects(callback(), { code: 'host_stopping' });
});

test('external resources keep inline guest callbacks and returned streams alive through forced GC', { skip: typeof global.gc !== 'function' }, async () => {
  let externalCallback;
  const { plugin, context } = fixture(`module.exports={activate(context){context.provide(async request=>request.body??42);},deactivate(){}};`, {
    provide: callback => { externalCallback = callback; },
  });
  await plugin.activate(context);
  for (let index = 0; index < 4; index++) { global.gc(); await new Promise(resolve => setImmediate(resolve)); }
  assert.equal(await externalCallback({}), 42);
  const owner = new AbortController();
  const stream = await externalCallback({ body: (async function* () { yield Uint8Array.from([21]); })() }, { signal: owner.signal });
  for (let index = 0; index < 4; index++) { global.gc(); await new Promise(resolve => setImmediate(resolve)); }
  const bytes = []; for await (const chunk of stream) bytes.push(...chunk);
  assert.deepEqual(bytes, [21]);
  owner.abort(); await plugin.deactivate(context);
});

test('bundled CommonJS syntax traversal handles a large finite declaration without argument-stack limits', async () => {
  let length;
  const values = Array.from({ length: 150000 }, () => '0').join(',');
  const { plugin, context } = fixture(`module.exports={activate(context){return context.done([${values}].length);},deactivate(){}};`, { done: value => { length = value; } });
  await plugin.activate(context); assert.equal(length, 150000); await plugin.deactivate(context);
});
