'use strict';

const capability = { name: 'example.combined.host', api: 1, scope: 'target' };
const owned = new Map();

module.exports = {
  activate(context) {
    context.rpc.provide(capability, 'describe', async (_params, invocation) => {
      const targetId = invocation.caller.targetId;
      let resource = owned.get(targetId);
      if (!resource) {
        const { sessionId } = await context.cdp.request('Target.attachToTarget', { targetId, flatten: true });
        const marker = `__codletCombinedHost_${context.plugin.generation}`;
        resource = { sessionId, marker };
        owned.set(targetId, resource);
        await context.cdp.request('Runtime.evaluate', {
          expression: `globalThis[${JSON.stringify(marker)}] = true`, returnByValue: true,
        }, { sessionId });
      }
      return {
        pluginId: context.plugin.id,
        generation: context.plugin.generation,
        caller: invocation.caller,
        targetId,
        marker: resource.marker,
        ready: true,
      };
    });
  },
  async deactivate(cleanup) {
    let failure;
    for (const { sessionId, marker } of owned.values()) {
      try {
        await cleanup.cdp.request('Runtime.evaluate', {
          expression: `delete globalThis[${JSON.stringify(marker)}]`, returnByValue: true,
        }, { sessionId });
      } catch (error) { failure ??= error; }
      try { await cleanup.cdp.request('Target.detachFromTarget', { sessionId }); }
      catch (error) { failure ??= error; }
    }
    owned.clear();
    if (failure) throw failure;
  },
};
