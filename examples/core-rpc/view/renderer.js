'use strict';
const math = { name: 'example.rpc.math', api: 1, scope: 'runtime' };
const view = { name: 'example.rpc.view', api: 1, scope: 'target' };
module.exports = {
  async activate(context) {
    const initial = await context.rpc.request(math, 'double', { value: 1 });
    globalThis.__rpcViewState = { targetId: initial.caller.targetId, revision: 'view-v1', notifications: 0 };
    context.rpc.provide(view, 'calculate', async (params, invocation) => {
      // This bound client preserves the inbound Core token in a browser realm.
      const nested = await invocation.rpc.request(math, 'double', params);
      return { nested, caller: invocation.caller, scope: invocation.scope, depth: invocation.depth };
    });
    context.rpc.provide(view, 'mark', () => { globalThis.__rpcViewState.notifications++; });
  },
  deactivate() { delete globalThis.__rpcViewState; }
};
