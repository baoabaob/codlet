import { readdir, symlink, lstat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const base = dirname(fileURLToPath(import.meta.url)), root = resolve(base, '..');
// Implementation tests retain their local import paths. Reuse Core's build
// dependencies; this development link is ignored and is never shipped.
const link = resolve(base, 'frontend/node_modules');
try { await lstat(link); } catch (error) { if (error.code !== 'ENOENT') throw error; await symlink(resolve(root, 'frontend/node_modules'), link, process.platform === 'win32' ? 'junction' : 'dir'); }
const requested = process.argv.slice(2);
const paths = requested.length ? requested.map(name => resolve(base, 'tests', name)) : (await readdir(resolve(base, 'tests'))).filter(name => name.endsWith('.test.mjs')).sort().map(name => resolve(base, 'tests', name));
const child = spawn(process.execPath, ['--expose-gc', '--test', ...paths], { cwd: root, env: { ...process.env, CODLET_CORE_ROOT: root }, stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
