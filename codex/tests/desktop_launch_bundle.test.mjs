import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
test('Desktop combined manifest supplies only the generic launch capability and bundles both entry exports', async () => {
  const manifest = JSON.parse(await fs.readFile(new URL('../bundled/codex-desktop-adapter/codlet.json', import.meta.url)));
  assert.deepEqual(manifest.host, { entry: 'host.cjs', provides: [{ name: 'codlet.client.launch', api: 1, scope: 'runtime' }] });
  assert(manifest.permissions.includes('host.process')); assert(manifest.permissions.includes('cdp.raw')); assert(!manifest.permissions.includes('traffic.intercept'));
  assert(manifest.provides.some(value => value.name === 'codex.backend.write')); assert(!manifest.provides.some(value => value.name === 'codex.backend.transport'));
  const host = require('../bundled/codex-desktop-adapter/host.cjs'), signal = new AbortController().signal;
  const result = await host.prepareClientLaunch({ traffic: { source: {version:1,kind:'plaintext',endpoint:{host:'127.0.0.1',port:12345,token:'private'},routeBaseUrl:'http://127.0.0.1:12345/routes/' } }, signal });
  assert.deepEqual(result, { arguments: ['--inspect-brk=127.0.0.1:0'] });
  assert.equal(typeof host.attachClientLaunch, 'function'); assert.equal(typeof host.activate, 'function');
  const source = await fs.readFile(new URL('../bundled/codex-desktop-adapter/host.cjs', import.meta.url), 'utf8');
  assert(source.includes('installBackendSpawn')); assert(source.includes('runConfigProbe')); assert(source.includes('connectPlaintextSource')); assert(!source.includes('setCertificateVerifyProc'));
});
