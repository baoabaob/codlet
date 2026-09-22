import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { prepareProcessTrafficEnvironment } = require('../runtime/process-traffic-environment.cjs');
const caPath = fileURLToPath(new URL('./fixtures/process-traffic/ca.pem', import.meta.url));
const ca = await fs.readFile(caPath, 'utf8');
test('Windows and macOS child trust merges preserve saved proxy, bypass and unrelated environment', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codlet-process-environment-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const platform of ['win32', 'darwin']) {
    const environment = { HTTPS_PROXY: 'http://corporate.invalid:3128', no_proxy: 'internal.invalid', EXISTING_TRUST: caPath, UNRELATED: 'unchanged' };
    const original = { ...environment };
    const result = await prepareProcessTrafficEnvironment({ platform, environment, directory, proxyUrl: 'http://codlet:fixture@127.0.0.1:8123', additionalCaPem: ca, trustInputs: [caPath], trustOutputs: ['OWNED_TRUST'] });
    assert.deepEqual(environment, original); assert.deepEqual(result.upstreamEnvironment, original);
    assert.equal(result.environment.no_proxy, original.no_proxy); assert.equal(result.environment.UNRELATED, 'unchanged');
    assert.equal(result.environment.HTTPS_PROXY, 'http://codlet:fixture@127.0.0.1:8123');
    const patched = Object.fromEntries(Object.entries(original).filter(([key]) => !result.environmentPatch.removeCaseInsensitive.includes(key.toLowerCase())));
    Object.assign(patched, result.environmentPatch.set);
    assert.deepEqual(patched, result.environment);
    assert.equal(result.environmentPatch.set.UNRELATED, undefined);
    assert.equal(result.environmentPatch.set.no_proxy, undefined);
    assert.equal((await fs.readFile(result.bundlePath, 'utf8')).match(/BEGIN CERTIFICATE/gu).length, 1);
    assert.equal(result.status().inheritedBypass, true);
    await Promise.all([result.close(), result.close()]); await assert.rejects(fs.stat(result.bundlePath), { code: 'ENOENT' });
  }
});
test('invalid trust and unsupported platforms fail before a launch environment is returned', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codlet-process-environment-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const options = { platform: 'win32', environment: {}, directory, proxyUrl: 'http://codlet:fixture@127.0.0.1:8123', additionalCaPem: 'not a certificate', trustOutputs: ['OWNED_TRUST'] };
  await assert.rejects(prepareProcessTrafficEnvironment(options), { code: 'invalid_ca_bundle' });
  await assert.rejects(prepareProcessTrafficEnvironment({ ...options, platform: 'linux', additionalCaPem: ca }), { code: 'platform_unsupported' });
  assert.deepEqual(await fs.readdir(directory), []);
});
