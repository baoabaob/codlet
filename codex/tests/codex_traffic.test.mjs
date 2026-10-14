import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { gzipSync, zstdCompressSync } from 'node:zlib';
const require = createRequire(import.meta.url);
const { probeCodexTraffic, classifyCodexTraffic } = require('../host/codex-traffic.cjs');
const { readCodexJsonBody, rewrittenCodexJsonBody } = require('../host/codex-traffic.cjs');
test('fixture evidence never upgrades automatic/OAuth/desktop/attachment coverage', () => {
  const verified = probeCodexTraffic({ platform: 'win32', binarySha256: 'BC45017E8239DC150258F69309CED9DF6BBCDF5B8E4F346DECF780AC0999E226' });
  assert.equal(verified.fixtureVerified, true); assert.equal(verified.available, false); assert.equal(verified.officialOAuth, false); assert.equal(verified.existingLoadedThreads, false); assert.equal(verified.attachments, false);
  assert.equal(probeCodexTraffic({ platform:'win32',binarySha256:'97d4d67419d0ac2f71342f9a5e850f9468aa622618de8ea823223edb9a91926a' }).fixtureVerified,true);
  for (const platform of ['darwin', 'linux']) assert.equal(probeCodexTraffic({ platform }).fixtureVerified, false);
  assert.equal(probeCodexTraffic({ platform: 'win32', binarySha256: 'changed' }).reason, 'backend_build_unverified');
});

test('Codex HTTP JSON rewrites decode gzip/zstd with limits and remove stale representation headers', async () => {
  for (const [encoding, encode] of [['gzip', gzipSync], ['zstd', zstdCompressSync]]) {
    const request = { headers: [['content-encoding', encoding], ['content-length', '100'], ['content-digest', 'stale'], ['authorization', 'Bearer fixture'], ['content-type', 'application/json']], body: [encode(Buffer.from('{"model":"fixture"}'))] };
    assert.deepEqual(await readCodexJsonBody(request), { model: 'fixture' });
    const result = rewrittenCodexJsonBody(request, { model: 'rewritten' });
    assert.equal(result.body, '{"model":"rewritten"}');
    assert.deepEqual(result.headers, [['authorization', 'Bearer fixture'], ['content-type', 'application/json']]);
    await assert.rejects(readCodexJsonBody(request, 5), { code: 'codex_body_too_large' });
    await assert.rejects(readCodexJsonBody({ headers: [['content-encoding', encoding]], body: [encode(Buffer.alloc(4096, 32))] }, 128), { code: 'codex_body_invalid' });
  }
});
test('semantic metadata uses verified endpoints and leaves associations unknown', () => {
  assert.deepEqual(classifyCodexTraffic({ method: 'POST', url: 'https://chatgpt.com/backend-api/codex/responses?thread_id=do-not-trust' }), { kind: 'model.responses', threadId: null, model: null });
  assert.equal(classifyCodexTraffic({ method: 'GET', url: 'wss://api.openai.com/v1/responses' }).kind, 'model.responses');
  assert.equal(classifyCodexTraffic({ method: 'GET', url: 'https://chatgpt.com/backend-api/codex/models?client_version=fixture' }).kind, 'model.list');
  for (const url of ['https://api.openai.com.attacker.invalid/v1/responses', 'http://api.openai.com/v1/responses', 'https://chatgpt.com/attachments', 'https://api.openai.com:8443/v1/responses']) assert.equal(classifyCodexTraffic({ method: 'POST', url }).kind, 'unknown');
});
