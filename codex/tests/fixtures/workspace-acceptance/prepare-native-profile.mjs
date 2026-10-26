// Prepare a NEW profile with a real stdin pipe; cancel normally before start.
// This never launches Desktop/backend or copies session/credential data.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { finished } from 'node:stream/promises';

const [planPath, labBinary] = process.argv.slice(2);
if (!planPath || !labBinary) throw Error('Usage: prepare-native-profile.mjs <preflight.json> <reviewed-lab-binary>');
const directory = path.dirname(path.resolve(planPath)), plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const repo = fileURLToPath(new URL('../../../', import.meta.url));
if (!/^adapter-[a-f0-9-]{36}$/.test(plan.runId) || directory !== path.join(repo, '.artifacts/adapter-native', plan.runId) ||
    path.resolve(plan.planned.profileRoot) !== path.join(directory, 'profile')) throw Error('Explicit new Adapter run required');
if (plan.layer !== 'adapter' || plan.state !== 'planned' || plan.launched || plan.blockers.some(value => ![
  'fresh_profile_and_backend_effective_config_not_verified', 'run_pid_target_and_synthetic_data_not_verified',
].includes(value))) throw Error('Preflight is not eligible for fresh preparation');
if (fs.existsSync(plan.planned.profileRoot)) throw Error('Profile must be new; interrupted directories are retained');
if (createHash('sha256').update(fs.readFileSync(labBinary)).digest('hex') !== plan.hashes.expectedLabBinary) throw Error('Lab changed after preflight');
const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
const output = fs.createWriteStream(path.join(directory, 'prepare.stdout.jsonl'), { flags: 'wx' });
const errors = fs.createWriteStream(path.join(directory, 'prepare.stderr.log'), { flags: 'wx' });
const child = spawn(labBinary, ['--experimental-isolated-client', '--root', plan.planned.profileRoot,
  '--expected-package-version', plan.installedPackage.Version, '--app-server-url', 'ws://127.0.0.1:' + port],
  { cwd: directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = '', prepared, quitSent = false, preparationError;
const fail = error => {
  preparationError ??= error;
  child.stdin.destroy();
  if (child.pid && child.exitCode === null && child.signalCode === null) child.kill();
};
child.on('error', fail);
output.on('error', fail); errors.on('error', fail);
child.stderr.pipe(errors);
child.stdout.on('data', data => {
  try {
   output.write(data); buffer += data.toString('utf8'); let split;
   while ((split = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, split); buffer = buffer.slice(split + 1); let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.event === 'child_created') throw Error('Preparation unexpectedly launched a client');
    if (row.event === 'prepared') {
      if (row.detail.root.toLowerCase() !== plan.planned.profileRoot.toLowerCase() || row.detail.resumed_profile !== false) throw Error('Prepared ownership mismatch');
      prepared = row.detail;
    }
    if (row.event === 'awaiting_start' && prepared && !quitSent) { quitSent = true; child.stdin.write('quit\n'); }
   }
  } catch (error) { fail(error); }
});
child.stdin.on('error', error => { if (!quitSent) fail(error); });
const code = await new Promise(resolve => child.once('close', resolve));
output.end(); errors.end();
await Promise.all([finished(output), finished(errors)]);
if (preparationError) throw preparationError;
if (code !== 0 || !prepared || !quitSent) throw Error('Preparation did not end normally; inspect owned logs');
fs.writeFileSync(path.join(directory, 'prepared.json'), JSON.stringify({ schema: 1, runId: plan.runId,
  state: 'prepared_not_started', desktopStarted: false, backendStarted: false, prepared }, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ runId: plan.runId, state: 'prepared_not_started', registryScope: prepared.plugin_registry_scope }) + '\n');
