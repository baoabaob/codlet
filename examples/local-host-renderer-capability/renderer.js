'use strict';

const capability = { name: 'example.combined.host', api: 1, scope: 'target' };

module.exports = {
  async activate(context) {
    const result = await context.rpc.request(capability, 'describe', null);
    if (!result?.ready || result.pluginId !== context.pluginId || result.caller.pluginId !== context.pluginId) {
      throw new Error('The native entry did not confirm this renderer caller');
    }
    // This result belongs to the isolated renderer world, not the page DOM.
    globalThis.__codletCombinedExample = result;
  },
  deactivate() {
    delete globalThis.__codletCombinedExample;
  },
};
