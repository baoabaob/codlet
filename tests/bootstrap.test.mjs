import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const bootstrapSource = readFileSync(
    new URL('../bundled/runtime/bootstrap.js', import.meta.url),
    'utf8'
);

function createRuntime() {
    const context = vm.createContext({});
    const result = vm.runInContext(bootstrapSource, context);
    assert.equal(result.ok, true);
    assert.equal(result.reused, false);
    return context.__codletRendererV1;
}

const metadata = (generation, extra = {}) => ({
    id: 'dev.example',
    version: '1.0.0',
    generation,
    ...extra
});

const capability = Object.freeze({
    name: 'renderer.example',
    api: 1,
    scope: 'target'
});

test('failed activation leaves no generation and releases its operation gate', async () => {
    const runtime = createRuntime();
    let cleanups = 0;
    const failed = await runtime.activate(metadata(1), {
        activate() {
            throw new Error('activation failed');
        },
        deactivate() {
            cleanups += 1;
        }
    });

    assert.equal(failed.ok, false);
    assert.equal(failed.error, 'activation failed');
    assert.equal(failed.cleanupError, null);
    assert.equal(cleanups, 1);
    assert.equal(runtime.status().length, 0);

    let activations = 0;
    const retried = await runtime.activate(metadata(1), {
        activate() {
            activations += 1;
        },
        deactivate() {}
    });
    assert.equal(retried.ok, true);
    assert.equal(retried.reused, false);
    assert.equal(activations, 1);
});

test('failed activation reports cleanup failure without publishing the definition', async () => {
    const runtime = createRuntime();
    const failed = await runtime.activate(metadata(1), {
        activate() {
            throw new Error('activation failed');
        },
        deactivate() {
            throw new Error('cleanup failed');
        }
    });

    assert.equal(failed.ok, false);
    assert.equal(failed.error, 'activation failed');
    assert.equal(failed.cleanupError, 'cleanup failed');
    assert.equal(runtime.status().length, 0);
});

test('failed replacement cleans only the candidate and preserves the active generation', async () => {
    const runtime = createRuntime();
    let oldDeactivations = 0;
    let candidateDeactivations = 0;
    await runtime.activate(metadata(1), {
        activate() {},
        deactivate() {
            oldDeactivations += 1;
        }
    });

    const failed = await runtime.activate(metadata(2), {
        activate() {
            throw new Error('replacement failed');
        },
        deactivate() {
            candidateDeactivations += 1;
        }
    });

    assert.equal(failed.ok, false);
    assert.equal(candidateDeactivations, 1);
    assert.equal(oldDeactivations, 0);
    assert.equal(runtime.status().length, 1);
    assert.equal(runtime.status()[0].id, 'dev.example');
    assert.equal(runtime.status()[0].generation, 1);
});

test('activating the same generation reuses the active definition', async () => {
    const runtime = createRuntime();
    let activations = 0;
    const definition = {
        activate() {
            activations += 1;
        },
        deactivate() {}
    };

    const first = await runtime.activate(metadata(1), definition);
    const duplicate = await runtime.activate(metadata(1), definition);

    assert.equal(first.reused, false);
    assert.equal(duplicate.reused, true);
    assert.equal(activations, 1);
});

test('deactivation is idempotent for an inactive generation', async () => {
    const runtime = createRuntime();
    let deactivations = 0;
    await runtime.activate(metadata(1), {
        activate() {},
        deactivate() {
            deactivations += 1;
        }
    });

    const first = await runtime.deactivate('dev.example', 1);
    const duplicate = await runtime.deactivate('dev.example', 1);

    assert.equal(first.ok, true);
    assert.equal(first.inactive, true);
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.inactive, true);
    assert.equal(deactivations, 1);
});

test('bootstrap entry point and lifecycle methods are immutable', () => {
    const context = vm.createContext({});
    const result = vm.runInContext(bootstrapSource, context);
    assert.equal(result.ok, true);

    const descriptor = vm.runInContext(
        'Object.getOwnPropertyDescriptor(globalThis, "__codletRendererV1")',
        context
    );
    assert.equal(descriptor.configurable, false);
    assert.equal(descriptor.writable, false);
    assert.equal(vm.runInContext('Object.isFrozen(globalThis.__codletRendererV1)', context), true);
    assert.equal(vm.runInContext('delete globalThis.__codletRendererV1', context), false);
    assert.equal(
        vm.runInContext(
            'globalThis.__codletRendererV1 = null; globalThis.__codletRendererV1.abi',
            context
        ),
        1
    );
});

test('activation can await a renderer RPC without publishing active state early', async () => {
    const context = vm.createContext({});
    vm.runInContext(bootstrapSource, context);
    const envelopes = [];
    context.codlet_rpc_activating = (payload) => envelopes.push(JSON.parse(payload));
    let readyValue = null;

    const activation = context.__codletRendererV1.activate(metadata(1, {
        binding: 'codlet_rpc_activating',
        requires: [capability]
    }), {
        async activate(pluginContext) {
            readyValue = await pluginContext.rpc.request(capability, 'ready', null);
        },
        deactivate() {}
    });
    await Promise.resolve();

    assert.equal(context.__codletRendererV1.status().length, 0);
    assert.equal(envelopes.length, 1);
    assert.equal(envelopes[0].method, 'ready');
    const received = context.__codletRendererV1.__rpcReceive('codlet_rpc_activating', {
        v: 1,
        type: 'response',
        id: envelopes[0].id,
        ok: true,
        result: { accepted: true }
    });
    assert.equal(received.ok, true);

    const activated = await activation;
    assert.equal(activated.ok, true);
    assert.deepEqual(readyValue, { accepted: true });
    const status = context.__codletRendererV1.status();
    assert.equal(status.length, 1);
    assert.equal(status[0].id, 'dev.example');
    assert.equal(status[0].generation, 1);
});

test('activation RPC rejection cleans the candidate and releases its operation gate', async () => {
    const context = vm.createContext({});
    vm.runInContext(bootstrapSource, context);
    const envelopes = [];
    context.codlet_rpc_activating_error = (payload) => envelopes.push(JSON.parse(payload));
    let cleanups = 0;

    const activation = context.__codletRendererV1.activate(metadata(1, {
        binding: 'codlet_rpc_activating_error',
        requires: [capability]
    }), {
        async activate(pluginContext) {
            await pluginContext.rpc.request(capability, 'ready', null);
        },
        deactivate() {
            cleanups += 1;
        }
    });
    await Promise.resolve();
    context.__codletRendererV1.__rpcReceive('codlet_rpc_activating_error', {
        v: 1,
        type: 'response',
        id: envelopes[0].id,
        ok: false,
        error: { code: 'not_ready', message: 'host rejected readiness' }
    });

    const failed = await activation;
    assert.equal(failed.ok, false);
    assert.equal(failed.error, 'host rejected readiness');
    assert.equal(cleanups, 1);
    assert.equal(context.__codletRendererV1.status().length, 0);

    const retried = await context.__codletRendererV1.activate(metadata(1), {
        activate() {},
        deactivate() {}
    });
    assert.equal(retried.ok, true);
    assert.equal(retried.reused, false);
});

test('renderer request uses the fixed binding envelope and resolves a host response', async () => {
    const context = vm.createContext({});
    const installed = vm.runInContext(bootstrapSource, context);
    assert.equal(installed.ok, true);
    const envelopes = [];
    context.codlet_rpc_test = (payload) => envelopes.push(JSON.parse(payload));
    let pluginContext;
    const activated = await context.__codletRendererV1.activate(metadata(1, {
        binding: 'codlet_rpc_test',
        requires: [capability]
    }), {
        activate(value) {
            pluginContext = value;
        },
        deactivate() {}
    });
    assert.equal(activated.ok, true);

    const pending = pluginContext.rpc.request(capability, 'roundTrip', { value: 7 });
    assert.deepEqual(envelopes, [{
        v: 1,
        type: 'request',
        pluginId: 'dev.example',
        generation: 1,
        id: 1,
        capability,
        method: 'roundTrip',
        params: { value: 7 }
    }]);
    const received = context.__codletRendererV1.__rpcReceive('codlet_rpc_test', {
        v: 1,
        type: 'response',
        id: 1,
        ok: true,
        result: { accepted: true }
    });
    assert.equal(received.ok, true);
    assert.deepEqual(await pending, { accepted: true });
});

test('renderer provider dispatches only its declared endpoint', async () => {
    const context = vm.createContext({});
    vm.runInContext(bootstrapSource, context);
    let invocations = 0;
    await context.__codletRendererV1.activate(metadata(1, {
        binding: 'codlet_rpc_provider',
        provides: [capability]
    }), {
        activate(pluginContext) {
            pluginContext.rpc.provide(capability, 'roundTrip', (params) => {
                invocations += 1;
                return { echoed: params.value };
            });
        },
        deactivate() {}
    });

    const accepted = await context.__codletRendererV1.__rpcInvoke('codlet_rpc_provider', {
        v: 1,
        type: 'request',
        pluginId: 'dev.consumer',
        generation: 1,
        id: 9,
        capability,
        method: 'roundTrip',
        params: { value: 11 }
    });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.value.echoed, 11);
    assert.equal(invocations, 1);

    const rejected = await context.__codletRendererV1.__rpcInvoke('codlet_rpc_provider', {
        v: 1,
        type: 'request',
        pluginId: 'dev.consumer',
        generation: 1,
        id: 10,
        capability,
        method: 'missing',
        params: null
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error, 'renderer endpoint is not registered');
    assert.equal(invocations, 1);

    const malformed = await context.__codletRendererV1.__rpcInvoke('codlet_rpc_provider', {
        v: 1,
        type: 'request',
        pluginId: 'dev.consumer',
        generation: 1,
        id: 11,
        capability: null,
        method: 'roundTrip',
        params: null
    });
    assert.equal(malformed.ok, false);
    assert.equal(malformed.error, 'invalid provider request');
    assert.equal(invocations, 1);
});

test('renderer notification uses the fixed envelope without a request id', async () => {
    const context = vm.createContext({});
    vm.runInContext(bootstrapSource, context);
    const envelopes = [];
    context.codlet_rpc_notify = (payload) => envelopes.push(JSON.parse(payload));
    let pluginContext;
    await context.__codletRendererV1.activate(metadata(1, {
        binding: 'codlet_rpc_notify',
        requires: [capability]
    }), {
        activate(value) {
            pluginContext = value;
        },
        deactivate() {}
    });

    pluginContext.rpc.notify(capability, 'changed', { active: true });
    assert.deepEqual(envelopes, [{
        v: 1,
        type: 'notification',
        pluginId: 'dev.example',
        generation: 1,
        capability,
        method: 'changed',
        params: { active: true }
    }]);
});

test('renderer response errors preserve diagnostic code and message', async () => {
    const context = vm.createContext({});
    vm.runInContext(bootstrapSource, context);
    context.codlet_rpc_error = () => {};
    let pluginContext;
    await context.__codletRendererV1.activate(metadata(1, {
        binding: 'codlet_rpc_error',
        requires: [capability]
    }), {
        activate(value) {
            pluginContext = value;
        },
        deactivate() {}
    });

    const pending = pluginContext.rpc.request(capability, 'roundTrip', null);
    context.__codletRendererV1.__rpcReceive('codlet_rpc_error', {
        v: 1,
        type: 'response',
        id: 1,
        ok: false,
        error: { code: 'capability_denied', message: 'principal is stale' }
    });
    await assert.rejects(pending, (error) => {
        assert.equal(error.code, 'capability_denied');
        assert.equal(error.message, 'principal is stale');
        return true;
    });
});
