'use strict';
const coordinator = { name: 'example.rpc.coordinator', api: 1, scope: 'runtime' };
const math = { name: 'example.rpc.math', api: 1, scope: 'runtime' };
module.exports = {
  async activate(context) {
    globalThis.__rpcConsumerState = await context.rpc.request(coordinator, 'inspect');
    globalThis.__rpcRoundTrip = (params = { value: 5 }, options) => context.rpc.request(coordinator, 'roundTrip', params, options);
    globalThis.__rpcStats = () => context.rpc.request(math, 'stats');
    globalThis.__rpcProbe = () => context.rpc.request(coordinator, 'probeHandle');
    globalThis.__rpcRefresh = () => context.rpc.request(coordinator, 'refreshScope');
    globalThis.__rpcClose = () => context.rpc.request(coordinator, 'closeScope');
    globalThis.__rpcNotify = () => context.rpc.notify(coordinator, 'notify');
  },
  deactivate() {
    for (const key of ['__rpcConsumerState', '__rpcRoundTrip', '__rpcStats', '__rpcProbe', '__rpcRefresh', '__rpcClose', '__rpcNotify']) delete globalThis[key];
  }
};
