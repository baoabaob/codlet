'use strict';
// SDK bindings only. Core owns every channel socket, forward and TLS session.
const { createHostedInterceptors } = require('./host-interceptors.cjs');
const { createHostedChannels } = require('./host-channels.cjs');
function createTrafficRuntime({ coreRequest, rootSignal, makeError, reportState, detach = fn => fn() }) {
  if (typeof coreRequest !== 'function' || typeof makeError !== 'function') throw new TypeError('traffic runtime dependencies are required');
  let interceptors;
  const channels = createHostedChannels({ coreRequest, rootSignal, reportState, detach, getPeer: () => interceptors.getPeer() });
  interceptors = createHostedInterceptors({ coreRequest, rootSignal, detach, extension: channels });
  const closeAll = () => { channels.closeAll(); interceptors.closeAll(); };
  rootSignal.addEventListener('abort', closeAll, { once: true });
  return Object.freeze({ api: Object.freeze({ openChannel: channels.openChannel,
    openHttpChannel: (options, handler) => channels.openChannel(options, { http: handler }),
    openSource: interceptors.openSource, registerInterceptor: interceptors.registerInterceptor, inspect: interceptors.inspect }), closeAll });
}
module.exports = { createTrafficRuntime };
