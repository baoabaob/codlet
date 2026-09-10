'use strict';
const math = { name: 'example.rpc.math', api: 1, scope: 'runtime' };
const target = { name: 'example.rpc.target', api: 1, scope: 'target' };
const view = { name: 'example.rpc.view', api: 1, scope: 'target' };
const coordinator = { name: 'example.rpc.coordinator', api: 1, scope: 'runtime' };
let sessionId, scope, selected, initial;

module.exports = {
  async activate(context) {
    const runtimeResult = await context.rpc.request(math, 'double', { value: 3 });
    await context.rpc.notify(math, 'count');
    const { targetInfos } = await context.cdp.request('Target.getTargets');
    const pages = targetInfos.filter(target => target.type === 'page').sort((a, b) => a.targetId.localeCompare(b.targetId));
    if (!pages.length) throw new Error('This example needs a renderer Target.');
    selected = pages[pages.length - 1].targetId;
    ({ sessionId } = await context.cdp.request('Target.attachToTarget', { targetId: selected, flatten: true }));
    scope = await context.rpc.target({ sessionId });
    const targetResult = await context.rpc.request(target, 'inspect', null, { scope });
    const reverseResult = await context.rpc.request(view, 'calculate', { value: 7 }, { scope });
    await context.rpc.notify(view, 'mark', null, { scope });
    initial = { selected, runtimeResult, targetResult, reverseResult };
    context.rpc.provide(coordinator, 'inspect', (_params, invocation) => ({ initial, caller: invocation.caller, scope: invocation.scope, depth: invocation.depth }));
    context.rpc.provide(coordinator, 'roundTrip', async (params, invocation) => ({
      result: await context.rpc.request(view, 'calculate', params),
      caller: invocation.caller, scope: invocation.scope, depth: invocation.depth
    }));
    context.rpc.provide(coordinator, 'notify', () => context.rpc.notify(view, 'mark'));
    context.rpc.provide(coordinator, 'probeHandle', async () => {
      try { return await context.rpc.request(target, 'inspect', null, { scope }); }
      catch (error) { return { error: error.code }; }
    });
    context.rpc.provide(coordinator, 'refreshScope', async () => { scope = await context.rpc.target({ sessionId }); return { kind: scope.kind }; });
    context.rpc.provide(coordinator, 'closeScope', async () => { await scope.close(); return { closed: true }; });
  },
  // Core closes the recorded raw session after this finite cleanup phase.
  deactivate() {}
};
