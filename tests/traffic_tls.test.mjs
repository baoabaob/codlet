import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const execute = promisify(execFile);
for (const trusted of [false, true]) test(`HTTPS/WSS ${trusted ? 'validate and use the explicitly trusted test CA' : 'reject an untrusted certificate'}`, { timeout: 15000 }, async () => {
  const env = { ...process.env };
  delete env.NODE_TLS_REJECT_UNAUTHORIZED;
  delete env.NODE_EXTRA_CA_CERTS;
  if (trusted) env.NODE_EXTRA_CA_CERTS = fileURLToPath(new URL('./fixtures/traffic-tls/localhost-cert.pem', import.meta.url));
  const result = await execute(process.execPath, [fileURLToPath(new URL('./fixtures/traffic-tls/runner.cjs', import.meta.url)), trusted ? 'trusted' : 'untrusted'], { env, timeout: 12000, windowsHide: true });
  assert.deepEqual(JSON.parse(result.stdout), { https: true, wss: true, trusted });
});
