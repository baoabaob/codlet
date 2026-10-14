'use strict';

const ownChannel = { name: 'example.traffic.channel', api: 1, scope: 'runtime' };
let dispose;

module.exports = {
  async activate(context) {
    dispose = await context.codex.configuration.register({ id: 'workspace-provider' }, async (draft, { signal }) => {
      const state = await context.rpc.request(ownChannel, 'status', {}, { signal });
      // The sample is inactive without settings.json and only attaches the
      // explicitly configured workspace. It does not interrupt loaded tasks.
      if (!state.configured || !state.open || draft.cwd !== state.cwd) return;
      return { provider: { baseUrl: state.channel.endpoint + '/v1', name: 'Example local provider', supportsWebSockets: state.channel.protocols.includes('websocket') } };
    });
  },
  deactivate() { dispose?.(); dispose = undefined; }
};
