import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { command } from '../scripts/native-core/command.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codlet-cost-command-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const read = () => JSON.parse(fs.readFileSync(path.join(root, 'command.json')));
  const reply = input => fs.writeFileSync(path.join(root, `response-${input.id}.json`), JSON.stringify({ id: input.id, ok: true, result: input.action }));
  return { root, read, reply };
}

test('unknown command remains queryable and blocks a new command until its original receipt arrives', async t => {
  const f = fixture(t);
  await assert.rejects(command(f.root, 'runCase', {}, 1), /timed out/);
  const original = f.read();
  await assert.rejects(command(f.root, 'setup', {}, 1), /remains unresolved/);
  assert.deepEqual(f.read(), original);
  assert.equal(fs.existsSync(path.join(f.root, 'command-writer.lock')), false);
  f.reply(original);
  const next = command(f.root, 'cleanup');
  f.reply(f.read());
  assert.equal(await next, 'cleanup');
  assert.equal(fs.existsSync(path.join(f.root, 'pending-command.json')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'command-writer.lock')), false);
});

test('concurrent writers cannot overwrite an admitted command', async t => {
  const f = fixture(t), first = command(f.root, 'runCase');
  const original = f.read();
  await assert.rejects(command(f.root, 'cleanup'), { code: 'EEXIST' });
  assert.deepEqual(f.read(), original);
  f.reply(original);
  assert.equal(await first, 'runCase');
});
