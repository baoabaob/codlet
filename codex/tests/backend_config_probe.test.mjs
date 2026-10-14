import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { runConfigProbe } = createRequire(import.meta.url)('../host/backend-config-probe.cjs');

test('effective config probe projects only routing data and exits after its owned child', () => {
  const fixture = fileURLToPath(new URL('./fixtures/traffic/probe-app-server.cjs', import.meta.url));
  const plan = { executable: process.execPath, configArguments: [fixture], environment: process.env, cwd: process.cwd() };
  const result = spawnSync(process.execPath, ['--no-addons', '--no-global-search-paths', '--eval', `(${runConfigProbe.toString()})()`], {
    input: JSON.stringify(plan), env: process.env, cwd: process.cwd(), windowsHide: true, encoding: 'utf8', timeout: 2000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert(!result.stdout.includes('never-project-this-secret'));
  assert(!result.stdout.includes('never-project-this-email'));
  assert.deepEqual(JSON.parse(result.stdout), { modelProvider: 'openai', providerBaseUrls: { custom: 'https://custom.example/v1' },
    openaiBaseUrl: 'https://fixture.example/v1', accountType: 'apiKey' });
});
