import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const reviewed = JSON.parse(readFileSync(new URL('./fixtures/traffic/mac-plaintext-reviewed.json', import.meta.url)));
const product = require('../bundled/codex-desktop-adapter/host.cjs');

test('product Host recognizes only the native-reviewed Apple Silicon backend and exact main modules', () => {
  assert.equal(reviewed.status, 'native-plaintext-reviewed');
  assert.equal(reviewed.platform, 'darwin');
  assert.equal(reviewed.architecture, 'arm64');
  assert.equal(product.probeCodexTraffic({ platform: 'darwin', binarySha256: reviewed.backend.sha256 }).fixtureVerified, true);
  assert.equal(product.probeCodexTraffic({ platform: 'win32', binarySha256: reviewed.backend.sha256 }).fixtureVerified, false);
  assert.equal(product.probeCodexTraffic({ platform: 'darwin', binarySha256: '0'.repeat(64) }).fixtureVerified, false);
  const bundled = readFileSync(new URL('../bundled/codex-desktop-adapter/host.cjs', import.meta.url), 'utf8');
  for (const profile of Object.values(reviewed.main)) {
    assert(bundled.includes(profile.name));
    assert(bundled.includes(profile.sha256));
  }
});
