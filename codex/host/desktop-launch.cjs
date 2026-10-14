'use strict';
const { attachElectronTrafficBeforeEntry } = require('./electron-bootstrap.cjs');
const fail = code => Object.assign(new Error(code), { code });
function sourceDescriptor(traffic) {
  const source = traffic?.source;
  if (source?.version !== 1 || source.kind !== 'plaintext' || !source.endpoint || source.endpoint.host !== '127.0.0.1'
    || !Number.isSafeInteger(source.endpoint.port) || source.endpoint.port < 1 || source.endpoint.port > 65535
    || typeof source.endpoint.token !== 'string' || !source.endpoint.token || typeof source.routeBaseUrl !== 'string') throw fail('invalid_plaintext_source');
  return source;
}
async function prepareClientLaunch({ traffic, signal, features }) {
  if (signal.aborted) throw fail('host_stopping');
  sourceDescriptor(traffic);
  return { arguments: ['--inspect-brk=127.0.0.1:0'],
    ...(process.platform === 'win32' && features?.moduleDataBootstrap === 1 ? { beforeResume: true } : {}) };
}
async function attachClientLaunch({ inspectorUrl, expectedPid, executable, traffic, signal }) {
  const source = sourceDescriptor(traffic);
  if (typeof CODEX_TRAFFIC_MAIN_SOURCE !== 'string') throw fail('launch_bundle_required');
  return attachElectronTrafficBeforeEntry({ inspectorUrl, expectedPid, executable, signal, mainSource: CODEX_TRAFFIC_MAIN_SOURCE,
    configuration: { source, runtimeExecutable: process.execPath } });
}
module.exports = { activate() {}, deactivate() {}, prepareClientLaunch, attachClientLaunch,
  clientSource() { return {code:CODEX_TRAFFIC_MAIN_SOURCE}; },
  beforeClientResume: require('./windows-bootstrap.cjs').beforeClientResume,
  ...require('./codex-traffic.cjs') };
