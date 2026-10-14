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
