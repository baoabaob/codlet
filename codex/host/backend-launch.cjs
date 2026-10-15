'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { probeCodexTraffic } = require('./codex-traffic.cjs');
const fail = code => Object.assign(new Error(code), { code });
const toml = value => JSON.stringify(value);

function verifyBackend(executable, platform = process.platform) {
  if (typeof executable !== 'string' || !path.isAbsolute(executable) || !/^codex(?:\.exe)?$/iu.test(path.basename(executable))) throw fail('invalid_backend_launch');
  const fd = fs.openSync(executable, 'r'); let binarySha256;
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size < 1 || before.size > 512 * 1024 * 1024) throw fail('backend_identity_unavailable');
    const hash = createHash('sha256'), bytes = Buffer.alloc(64 * 1024);
    for (;;) { const count = fs.readSync(fd, bytes); if (!count) break; hash.update(bytes.subarray(0, count)); }
    const after = fs.fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw fail('backend_identity_changed');
    binarySha256 = hash.digest('hex');
  } finally { fs.closeSync(fd); }
  // The digest binds a probe to this file. An unlisted digest is not an API
  // failure: the launch path verifies the actual app-server contract below.
  const recorded = probeCodexTraffic({ platform, binarySha256 }).fixtureVerified;
  return Object.freeze({ platform, binarySha256, recorded });
}

function supportsBackendContract(contract, settings) {
  return contract?.api === 1 && contract.initialize === true && contract.configRead === true && contract.accountRead === true
    && ['runtime', 'recorded'].includes(contract.routing)
    && Array.isArray(contract.providerOverrides) && contract.providerOverrides.length > 0 && contract.providerOverrides.length <= 17
    && new Set(contract.providerOverrides).size === contract.providerOverrides.length
    && contract.providerOverrides.every(value => typeof value === 'string' && (value === 'openai_base_url' || /^model_providers\.[A-Za-z0-9_-]{1,64}\.base_url$/u.test(value)))
    && settings.every(setting => contract.providerOverrides.includes(setting));
}

// Overrides are process local and appended last. A route contains only a
// loopback destination; the effective provider, auth and model stay untouched.
function prepareBackendLaunch({ executable, arguments: args, originalEnvironment, providerRoutes, platform = process.platform, compatibility }) {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string') || !args.includes('app-server') || !originalEnvironment || typeof originalEnvironment !== 'object' || !providerRoutes || typeof providerRoutes !== 'object') throw fail('invalid_backend_launch');
  const identity = verifyBackend(executable, platform), overrides = [];
  if (compatibility?.binarySha256 !== identity.binarySha256) throw fail('backend_identity_changed');
  if (!supportsBackendContract(compatibility.contract, Object.keys(providerRoutes))
    || compatibility.contract.routing === 'recorded' && !identity.recorded) throw fail('backend_contract_unavailable');
  for (const [setting, baseUrl] of Object.entries(providerRoutes)) {
    if (setting !== 'openai_base_url' && setting !== 'chatgpt_base_url' && !/^model_providers\.[A-Za-z0-9_-]+\.base_url$/u.test(setting)) throw fail('invalid_backend_route');
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash) throw fail('invalid_backend_route');
    overrides.push('-c', `${setting}=${toml(baseUrl)}`);
  }
  if (!overrides.length) throw fail('backend_route_unavailable');
  return Object.freeze({ executable, arguments: Object.freeze([...args, ...overrides]), environment: originalEnvironment, compatibility,
    status: Object.freeze({ available: true, backendProviderPrepared: true, coverage: ['owned-local-app-server-model-provider'] }) });
}
module.exports = { prepareBackendLaunch, verifyBackend, supportsBackendContract, toml };
