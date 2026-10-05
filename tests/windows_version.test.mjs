import test from 'node:test';
import assert from 'node:assert/strict';
import {windowsVersion} from '../scripts/windows-version.mjs';

test('stable MSI upgrades existing Preview and orders subsequent patch releases', () => {
  assert.equal(windowsVersion('0.2.0-preview.29').msiVersion, '0.2.29');
  assert.deepEqual(windowsVersion('0.2.0'), {msiVersion: '0.2.1000', fileVersion: '0.2.0.0'});
  assert.equal(windowsVersion('0.2.1').msiVersion, '0.2.1001');
  assert.equal(windowsVersion('1.0.0').msiVersion, '1.0.1000');
});

test('Windows version fields reject overflow and ambiguous prerelease order', () => {
  assert.equal(windowsVersion('255.255.64535').msiVersion, '255.255.65535');
  for (const version of ['256.0.0', '1.256.0', '1.0.64536', '0.2.1-preview.1',
    '0.2.0-preview.1000', '0.02.0', '0.2.0-beta.1', '0.2.0+local']) {
    assert.throws(() => windowsVersion(version));
  }
});
