import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fixtureRequestHandler, removeOwnedFixture, writeFixtureReport } from '../codex/scripts/owned-fixture.mjs';

test('fixture cleanup retains a live owner and rejects root and child links', async () => {
  const temporary = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(temporary, 'codlet-cleanup-test-'));
  const outside = await fs.mkdtemp(path.join(temporary, 'codlet-outside-test-'));
  const link = path.join(temporary, `codlet-cleanup-test-link-${path.basename(directory)}`);
  try {
    await fs.writeFile(path.join(outside, 'keep'), 'outside');
    await assert.rejects(removeOwnedFixture(directory, 'codlet-cleanup-test-', 1), /fixture_processes_remaining/u);
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(removeOwnedFixture(link, 'codlet-cleanup-test-', 0), /fixture_reparse/u);
    await fs.symlink(outside, path.join(directory, 'child'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(removeOwnedFixture(directory, 'codlet-cleanup-test-', 0), /fixture_reparse/u);
    assert.equal(await fs.readFile(path.join(outside, 'keep'), 'utf8'), 'outside');
    await fs.unlink(path.join(directory, 'child'));
    await removeOwnedFixture(directory, 'codlet-cleanup-test-', 0);
    await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
  } finally {
    await fs.unlink(link).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await removeOwnedFixture(directory, 'codlet-cleanup-test-', 0).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await removeOwnedFixture(outside, 'codlet-outside-test-', 0);
  }
});

test('reports preserve previous receipts while publishing the latest alias', async () => {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'codlet-receipt-test-'));
  try {
    await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify({ run: 'earlier' }));
    await writeFixtureReport(directory, 'result.json', { run: 'current' });
    const values = await Promise.all((await fs.readdir(directory)).map(async file => JSON.parse(await fs.readFile(path.join(directory, file), 'utf8'))));
    assert.equal(values.filter(value => value.run === 'earlier').length, 1);
    assert.equal(values.filter(value => value.run === 'current').length, 2);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'result.json'), 'utf8')), { run: 'current' });
  } finally { await removeOwnedFixture(directory, 'codlet-receipt-test-', 0); }
});

test('async fixture request errors are contained and observed', async () => {
  let observed;
  const server = http.createServer(fixtureRequestHandler(async () => { throw Error('malformed_fixture_request'); }, error => { observed = error.message; }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(fetch(`http://127.0.0.1:${server.address().port}/`));
    assert.equal(observed, 'malformed_fixture_request');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
