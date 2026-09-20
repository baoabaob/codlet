'use strict';

const transport = { name: 'codex.backend.transport', api: 1, scope: 'target' };
const ownChannel = { name: 'example.traffic.channel', api: 1, scope: 'runtime' };
let dispose;

module.exports = {
  async activate(context) {
    const support = await context.rpc.request(transport, 'probe', {});
    if (!support.available) throw new Error('This client does not support managed channel attachment');
    const access = await context.rpc.request(transport, 'getApi', {});
    const api = globalThis[Symbol.for(access.symbol)];
    dispose = api.registerThreadTransport(context, access.ticket, { id: 'workspace-channel' }, async (draft, { signal }) => {
      const state = await context.rpc.request(ownChannel, 'status', {}, { signal });
      // The sample is inactive without settings.json and only attaches the
      // explicitly configured workspace. It does not interrupt loaded tasks.
      if (!state.configured || !state.open || draft.cwd !== state.cwd) return;
      return { channel: state.channel };
    });
  },
  deactivate() { dispose?.(); dispose = undefined; }
};
