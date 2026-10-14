// Offline fixture author. Refuses to replace an existing output directory.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { HISTORY_SEED, HISTORY_SIZES, STREAM_MATRIX, historyFixture, streamNotifications, sha256 } from './synthetic-history.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const parent = path.join(repo, '.artifacts/workspace-history');
await fs.mkdir(parent, { recursive: true });
const directory = path.resolve(process.argv[2] ?? path.join(parent, 'data-' + randomUUID()));
await fs.mkdir(directory); // Exclusive creation: no silent overwrite or resume.
const manifest = { schema: 1, seed: HISTORY_SEED, createdAt: new Date().toISOString(), nativeClientTested: false, sentTurns: 0, history: [], streams: [] };
for (const size of HISTORY_SIZES) {
  const data = historyFixture(size), filename = `history-${size}.json`, text = JSON.stringify(data) + '\n';
  await fs.writeFile(path.join(directory, filename), text, { flag: 'wx' });
  manifest.history.push({ filename, items: size, turns: data.thread.turns.length, sha256: sha256(text), itemKinds: [...new Set(data.items.map(value => value.item.type))] });
}
for (const threads of STREAM_MATRIX.threads) {
  const rows = [...streamNotifications(threads)], filename = `stream-${threads}.jsonl`, text = rows.map(value => JSON.stringify(value)).join('\n') + '\n';
  await fs.writeFile(path.join(directory, filename), text, { flag: 'wx' });
  const { ratePerThread, deltaChars, durationMs } = STREAM_MATRIX;
  manifest.streams.push({ filename, threads, ratePerThread, deltaChars, durationMs, notifications: rows.length, deltas: 1200 * threads, sha256: sha256(text) });
}
await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ directory, seed: HISTORY_SEED, historyItems: HISTORY_SIZES, streamThreads: STREAM_MATRIX.threads, nativeClientTested: false }));
