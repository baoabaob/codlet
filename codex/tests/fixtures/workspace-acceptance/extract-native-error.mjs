// Offline extraction of the exact old owned Native error-boundary log entry.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url)), directory = path.resolve(process.argv[2] ?? '');
const runId = path.basename(directory);
if (!/^adapter-[a-f0-9-]{36}$/.test(runId) || directory !== path.join(repo, '.artifacts/adapter-native', runId)) throw Error('Explicit owned run required');
const coordinator = '1791713757017-31524';
const state = JSON.parse(fs.readFileSync(path.join(directory, 'profile/logs/coordinator-' + coordinator + '/state.json'), 'utf8'));
if (state.desktopPid !== 34516 || path.resolve(state.labRoot) !== path.join(directory, 'profile')) throw Error('Historical Native identity differs');
const filename = path.join(directory, 'profile/home/AppData/Local/Codex/Logs/2026/10/11/codex-desktop-12200178-a893-4a3d-8365-724ac7c8d8a1-34516-t0-i1-101608-0.log');
const lines = fs.readFileSync(filename, 'utf8').split(/\r?\n/);
const index = lines.findIndex(line => line.startsWith('2026-10-11T11:48:51.307Z error ') && line.includes('error boundary'));
if (index < 0) throw Error('Exact historical Native boundary event missing');
const line = lines[index], field = name => {
  const match = new RegExp('(?:^| )' + name + '=("(?:\\\\.|[^"\\\\])*"|[^ ]+)').exec(line);
  if (!match) return null;
  return match[1].startsWith('"') ? JSON.parse(match[1]) : match[1];
};
const shared = path.join(repo, '.artifacts/composer-native-26.1007/app-shared-737655e1fb23.js');
const bytes = fs.readFileSync(shared), hash = createHash('sha256').update(bytes).digest('hex');
if (hash !== 'a1daa891e89a395b8db399ff6eaa365f12a86880c3d8cf891caf4ccbcb9eebf5') throw Error('Historical shared source pin differs');
const sourceLines = bytes.toString('utf8').split(/\r?\n/), sourceLine = sourceLines[170];
const sourcePosition = 35587 - 1;
const evidence = { schema: 1, runId, coordinatorRunId: coordinator, nativePid: state.desktopPid,
  timestamp: '2026-10-11T11:48:51.307Z', logPath: filename, logLine: index + 1,
  logEntrySha256: createHash('sha256').update(line).digest('hex'), errorMessage: field('errorMessage'), errorName: field('errorName'),
  errorStack: field('errorStack'), componentStack: field('componentStack'), boundary: field('name'),
  rendererWebContentsId: field('rendererWebContentsId'), windowVisible: field('rendererWindowVisible'), windowFocused: field('rendererWindowFocused'),
  source: { sha256: hash, resource: 'app://-/assets/app-shared-737655e1fb23.js', line: 171, column: 35587,
    excerpt: sourceLine.slice(Math.max(0, sourcePosition - 250), sourcePosition + 250) },
  decodedError: { reference: 'https://react.dev/errors/185', category: 'maximum nested update depth' },
  causality: 'The Native error and Popper anchor update frame are established; sequence reproduction is recorded separately and the initiating reference cycle is not isolated.' };
fs.writeFileSync(path.join(directory, 'native-error-185-evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ timestamp: evidence.timestamp, error: evidence.errorMessage, stack: evidence.errorStack, excerpt: evidence.source.excerpt }) + '\n');
