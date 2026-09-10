import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const bootstrap = readFileSync(new URL('../bundled/runtime/bootstrap.js', import.meta.url), 'utf8');
const entry = readFileSync(new URL('../examples/local-echo/renderer.js', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../examples/local-echo/codlet.json', import.meta.url), 'utf8'));

function fixture() {
    const context = vm.createContext({ module: { exports: {} }, setTimeout, clearTimeout, AbortController, TextEncoder });
    vm.runInContext(bootstrap, context);
    vm.runInContext(entry, context);
    const requests = [];
    context.example_binding = (payload) => requests.push(JSON.parse(payload));
    const runtime = context.__codletRendererV1;
    return {
        runtime,
        requests,
        start() {
            return runtime.activate({
                id: manifest.id,
                version: manifest.version,
                generation: 1,
                binding: 'example_binding',
                provides: manifest.provides,
                requires: manifest.requires
            }, context.module.exports);
        },
        reply(result) {
            return runtime.__rpcReceive('example_binding', {
                v: 1, type: 'response', id: requests[0].id, ok: true, result
            });
        },
        invoke(params) {
            return runtime.__rpcInvoke('example_binding', {
                v: 1, type: 'request', id: 1, pluginId: 'dev.consumer', generation: 1,
                capability: manifest.provides[0], method: 'echo', params
            });
        }
    };
}

test('local example uses CommonJS, waits for the host, provides an endpoint and unloads', async () => {
    const example = fixture();
    const activation = example.start();
    assert.equal(example.runtime.status().length, 0);
    assert.equal(example.requests.length, 1);
    assert.deepEqual(example.requests[0].capability, manifest.requires[0]);
    assert.equal(example.reply({ pong: true, abi: 1 }).ok, true);
    assert.equal((await activation).ok, true);
    const result = await example.invoke({ text: 'from a local plugin' });
    assert.deepEqual(JSON.parse(JSON.stringify(result)), {
        ok: true, value: { text: 'from a local plugin', pluginId: manifest.id }
    });
    assert.equal((await example.invoke({ text: 7 })).ok, false);
    assert.equal((await example.runtime.deactivate(manifest.id, 1)).ok, true);
    assert.equal(example.runtime.status().length, 0);
    assert.equal((await example.invoke({ text: 'after unload' })).ok, false);
});

test('local example does not publish a provider after a failed host handshake', async () => {
    const example = fixture();
    const activation = example.start();
    example.reply({ pong: true, abi: 2 });
    assert.equal((await activation).ok, false);
    assert.equal(example.runtime.status().length, 0);
    assert.equal((await example.invoke({ text: 'unavailable' })).ok, false);
});
