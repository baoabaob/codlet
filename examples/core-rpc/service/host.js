'use strict';
const runtime = { name: 'example.rpc.math', api: 1, scope: 'runtime' };
const target = { name: 'example.rpc.target', api: 1, scope: 'target' };
const revision = 'service-v1';
let started = 0, finished = 0, aborted = 0, notifications = 0;

module.exports = {
  activate(context) {
    context.rpc.provide(runtime, 'double', async (params, invocation) => {
      started++;
      if (params.delayMs) await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { invocation.signal.removeEventListener('abort', cancelled); resolve(); }, params.delayMs);
        const cancelled = () => { clearTimeout(timer); aborted++; reject(invocation.signal.reason); };
        invocation.signal.addEventListener('abort', cancelled, { once: true });
      });
      finished++;
      return { value: params.value * 2, revision, caller: invocation.caller, scope: invocation.scope, depth: invocation.depth };
    });
    context.rpc.provide(runtime, 'count', () => { notifications++; });
    context.rpc.provide(runtime, 'stats', () => ({ started, finished, aborted, notifications, revision }));
    context.rpc.provide(target, 'inspect', (_params, invocation) => ({ caller: invocation.caller, scope: invocation.scope, revision }));
  },
  deactivate() {}
};
