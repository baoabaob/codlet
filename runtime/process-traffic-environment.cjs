'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { X509Certificate } = require('node:crypto');
const proxyNames = /^(https?_proxy|all_proxy|no_proxy)$/i;
const error = code => Object.assign(new Error(code), { code });

// Returns a child-only environment and the original routing configuration. The
// owner must resolve upstream routes from `upstreamEnvironment`, never the new
// environment. No process.env, system proxy, keychain, or certificate store edits.
async function prepareProcessTrafficEnvironment({ platform = process.platform, environment, directory, proxyUrl, additionalCaPem, trustInputs = [], trustOutputs = [] }) {
  if (!['win32', 'darwin'].includes(platform)) throw error('platform_unsupported');
  if (!environment || !path.isAbsolute(directory) || !Array.isArray(trustInputs) || !Array.isArray(trustOutputs) || !trustOutputs.length || trustInputs.length > 8 || trustOutputs.length > 8) throw error('invalid_launch_configuration');
  const proxy = new URL(proxyUrl);
  if (proxy.protocol !== 'http:' || proxy.hostname !== '127.0.0.1' || !proxy.port || !proxy.username || !proxy.password || proxy.pathname !== '/' || proxy.search || proxy.hash) throw error('invalid_process_proxy');
  if (trustOutputs.some(name => !/^[A-Z][A-Z0-9_]{0,127}$/u.test(name) || proxyNames.test(name))) throw error('invalid_trust_variable');
  const upstreamEnvironment = Object.freeze({ ...environment });
  const certificates = new Map();
  const append = pem => {
    if (typeof pem !== 'string' || Buffer.byteLength(pem) > 128 * 1024) throw error('invalid_ca_bundle');
    const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu);
    if (!blocks?.length || pem.replace(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu, '').trim()) throw error('invalid_ca_bundle');
    for (const block of blocks) {
      let cert; try { cert = new X509Certificate(block); } catch { throw error('invalid_ca_bundle'); }
      certificates.set(cert.fingerprint256, block);
    }
  };
  // The adapter chooses fallback/precedence; Core only merges the selected PEMs.
  for (const input of new Set(trustInputs)) {
    if (typeof input !== 'string' || !path.isAbsolute(input)) throw error('invalid_ca_bundle');
    const handle = await fs.open(input, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 128 * 1024) throw error('invalid_ca_bundle');
      append(await handle.readFile('utf8'));
    } finally { await handle.close(); }
  }
  append(additionalCaPem);
  const merged = [...certificates.values()].join('\n') + '\n';
  if (Buffer.byteLength(merged) > 128 * 1024) throw error('invalid_ca_bundle');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const owned = await fs.mkdtemp(path.join(directory, 'process-trust-'));
  const bundlePath = path.join(owned, 'ca.pem');
  const removeOwned = async () => { await fs.rm(bundlePath, { force: true }); await fs.rmdir(owned); };
  try { await fs.writeFile(bundlePath, merged, { flag: 'wx', mode: 0o600 }); }
  catch (reason) { await removeOwned(); throw reason; }
  const next = { ...environment };
  for (const key of Object.keys(next)) if (/^(https?_proxy|all_proxy)$/i.test(key)) delete next[key];
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) next[key] = proxyUrl;
  for (const key of trustOutputs) {
    if (platform === 'win32') for (const existing of Object.keys(next)) if (existing.toUpperCase() === key) delete next[existing];
    next[key] = bundlePath;
  }
  // Preserve NO_PROXY exactly; a destination bypassed by the child is not covered.
  let closed = false, closing;
  return Object.freeze({ environment: Object.freeze(next), upstreamEnvironment, bundlePath,
    status: () => ({ prepared: !closed && !closing, coverage: 'process-configuration-only', inheritedBypass: Object.keys(environment).some(key => /^no_proxy$/i.test(key) && environment[key]) }),
    close() { return closing ??= removeOwned().then(() => { closed = true; }); },
  });
}
module.exports = { prepareProcessTrafficEnvironment };
