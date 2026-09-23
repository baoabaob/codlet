// Trusted Apple Silicon app updater copied from Core before the owner exits.
// The downloaded archive contributes data only. This script never kills a process.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile), self = fileURLToPath(import.meta.url);
const fail = (code, message) => Object.assign(new Error(message), { code });
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => path.resolve(a) === path.resolve(b);
function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') || value.split('/').some(p => p === '.' || p === '..')) throw fail('plan_path_invalid', 'Invalid update path.');
  return path.resolve(value);
}
function ordinary(file, directory = false) {
  absolute(file);
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) || !same(fs.realpathSync.native(file), file)) throw fail('plan_path_invalid', 'Update paths must be ordinary and cannot redirect.');
  return stat;
}
function ancestors(file) {
  for (let current = path.dirname(absolute(file)); ; current = path.dirname(current)) {
    if (fs.existsSync(current)) ordinary(current, true);
    if (path.dirname(current) === current) break;
  }
}
function read(file, limit = 256 * 1024) {
  ancestors(file);
  const before = ordinary(file);
  if (before.size > limit) throw fail('plan_size_limit', 'Update metadata is too large.');
  const bytes = fs.readFileSync(file), after = ordinary(file);
  if (bytes.length !== before.size || after.mtimeMs !== before.mtimeMs) throw fail('payload_changed', 'Update metadata changed during verification.');
  return bytes;
}
function digest(file) {
  ancestors(file);
  const before = ordinary(file);
  if (before.size > 512 * 1024 * 1024) throw fail('plan_size_limit', 'App file is too large.');
  const data = fs.readFileSync(file), after = ordinary(file);
  if (data.length !== before.size || after.mtimeMs !== before.mtimeMs) throw fail('payload_changed', 'App file changed during verification.');
  return { bytes: data.length, sha256: hash(data), mode: before.mode & 0o777 };
}
function verify(file, record) {
  if (!sha(record.sha256) || !Number.isSafeInteger(record.bytes) || record.bytes < 0 || ![0o644, 0o755].includes(record.mode)) throw fail('plan_invalid', 'Invalid app file identity.');
  const actual = digest(file);
  if (actual.bytes !== record.bytes || actual.sha256 !== record.sha256 || actual.mode !== record.mode) throw fail('payload_changed', 'App bytes or permissions differ from the checked manifest.');
}
function writeJson(file, value) {
  ancestors(file);
  if (fs.existsSync(file)) ordinary(file);
  const temporary = file + '.' + randomUUID() + '.tmp';
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
}
function inventory(root) {
  const pending = [path.join(root, 'Codlet.app')], found = [];
  ordinary(pending[0], true);
  while (pending.length) {
    const dir = pending.pop();
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), stat = fs.lstatSync(file);
      if (stat.isDirectory()) { ordinary(file, true); pending.push(file); }
      else { ordinary(file); found.push(path.relative(root, file).split(path.sep).join('/')); }
      if (found.length + pending.length > 4096) throw fail('plan_size_limit', 'App file count exceeds its limit.');
    }
  }
  return found.sort();
}
function records(files, runtime) {
  if (!Array.isArray(files) || files.length < 7 || files.length > 4096 || !runtime || !/^[0-9A-Za-z.-]{1,64}$/.test(runtime.version) || runtime.version.includes('..') || !sha(runtime.executableSha256) || !sha(runtime.licenseSha256)) throw fail('plan_invalid', 'Invalid app inventory or Node identity.');
  const paths = files.map(f => f.path);
  if (JSON.stringify(paths) !== JSON.stringify([...new Set(paths)].sort()) || paths.some(p => !/^Codlet\.app\/[A-Za-z0-9._/-]+$/.test(p) || p.split('/').some(s => !s || s === '.' || s === '..'))) throw fail('plan_path_invalid', 'App files must have unique sorted bundle paths.');
  const node = `Codlet.app/Contents/Resources/runtime/node-v${runtime.version}-darwin-arm64/bin/node`;
  const license = `Codlet.app/Contents/Resources/runtime/node-v${runtime.version}-darwin-arm64/LICENSE`;
  for (const required of ['Codlet.app/Contents/Info.plist', 'Codlet.app/Contents/MacOS/Codlet', 'Codlet.app/Contents/Resources/codlet', 'Codlet.app/Contents/Resources/runtime/node-runtime.json', 'Codlet.app/Contents/Resources/runtime/update-channel.json', node, license]) if (!paths.includes(required)) throw fail('plan_invalid', 'Signed app is missing a required file.');
  for (const file of files) if (!sha(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 512 * 1024 * 1024 || ![0o644, 0o755].includes(file.mode)) throw fail('plan_invalid', 'Invalid app file record.');
  if (files.find(f => f.path === node).sha256 !== runtime.executableSha256 || files.find(f => f.path === license).sha256 !== runtime.licenseSha256) throw fail('plan_invalid', 'Node files differ from their checked pins.');
}
async function codesign(root) {
  await exec('/usr/bin/codesign', ['--verify', '--strict', path.join(root, 'Codlet.app')], { timeout: 30000, maxBuffer: 1024 * 1024 });
}
async function verifyApp(root, files, runtime) {
  if (JSON.stringify(inventory(root)) !== JSON.stringify(files.map(f => f.path))) throw fail('payload_changed', 'Signed app inventory changed.');
  for (const file of files) verify(path.join(root, file.path), file);
  const pin = JSON.parse(read(path.join(root, 'Codlet.app/Contents/Resources/runtime/node-runtime.json'), 65536));
  const platform = pin.platforms?.['darwin-arm64'];
  if (pin.schema !== 1 || (platform?.version ?? pin.version) !== runtime.version || platform?.executableSha256 !== runtime.executableSha256 || platform?.licenseSha256 !== runtime.licenseSha256) throw fail('payload_changed', 'Bundled Node metadata changed.');
  await codesign(root);
}
async function probe(plan, pid) {
  try {
    const { stdout } = await exec(plan.identityProbe.path, ['__codlet_update_process_identity', String(pid)], { timeout: 5000, maxBuffer: 4096 });
    const value = JSON.parse(stdout);
    if (value.pid === pid && value.exited === true) return null;
    if (value.pid !== pid || !/^[0-9]{1,32}$/.test(value.creationTime) || value.uid !== process.geteuid()) throw fail('owner_identity_unavailable', 'Native process identity did not match the update owner.');
    return value;
  } catch (error) {
    try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') return null; }
    throw fail('owner_identity_unavailable', `Native process identity is unavailable: ${String(error.message).slice(0,256)}`);
  }
}
async function ownersAlive(plan) {
  for (const owner of plan.waitFor) if ((await probe(plan, owner.pid))?.creationTime === owner.creationTime) return true;
  return false;
}
async function bundleProcesses(plan) {
  const { stdout } = await exec(plan.identityProbe.path, ['__codlet_update_bundle_processes', path.join(plan.installRoot, 'Codlet.app')], { timeout: 5000, maxBuffer: 65536 });
  const processes = JSON.parse(stdout);
  if (!Array.isArray(processes) || processes.some(p => !Number.isInteger(p.pid) || p.uid !== process.geteuid())) throw fail('owner_identity_unavailable', 'Cannot verify running app processes.');
  return processes;
}
function lock(plan, planSha) {
  const file = path.join(plan.installRoot, '.codlet-runtime-update.lock.json');
  const fd = fs.openSync(file, 'wx', 0o600);
  const value = { schema: 1, kind: 'codlet-runtime-install-lock', id: plan.id, planSha256: planSha, nonce: randomUUID() };
  fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd);
  return { file, fd, value };
}
function unlock(held, remove) {
  try {
    if (!remove || JSON.stringify(JSON.parse(read(held.file, 4096))) !== JSON.stringify(held.value)) return false;
    if (fs.fstatSync(held.fd).ino !== ordinary(held.file).ino) return false;
    fs.closeSync(held.fd); held.fd = null; fs.unlinkSync(held.file); return true;
  } catch { return false; }
  finally { if (held.fd !== null) fs.closeSync(held.fd); }
}
function validate(plan, planPath, expectedSha) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || plan.schema !== 1 || plan.kind !== 'codlet-runtime-install-plan' || plan.platform !== 'darwin-arm64' || plan.profile !== 'macApp' || plan.officialUpdate !== false || plan.configPin !== null || !/^runtime-install-[A-Za-z0-9_-]+$/.test(plan.id) || !sha(expectedSha) || !sha(plan.manifestSha256)) throw fail('plan_invalid', 'Unsupported Mac app update plan.');
  const job = path.dirname(absolute(planPath));
  if (!same(job, path.join(absolute(plan.stateRoot), plan.id)) || path.basename(planPath) !== 'install-plan.json' || !same(plan.backupRoot, path.join(job, 'backup')) || !same(plan.handoffAckPath, path.join(job, 'handoff-ack.json')) || !same(plan.installReceiptPath, path.join(job, 'install-receipt.json')) || !same(plan.summaryReceiptPath, path.join(plan.stateRoot, 'runtime-update-install-receipt.json')) || !same(path.dirname(plan.stagedRoot), plan.stateRoot) || !path.basename(plan.stagedRoot).startsWith('runtime-payload-')) throw fail('plan_path_invalid', 'Update paths are outside their owned roots.');
  for (const dir of [plan.installRoot, plan.stateRoot, job, plan.stagedRoot]) ordinary(dir, true);
  if (!Number.isSafeInteger(plan.expiresAt) || plan.expiresAt <= Date.now() || plan.expiresAt - plan.createdAt > 1800000) throw fail('plan_expired', 'Update plan expired.');
  records(plan.currentFiles, plan.currentRuntime); records(plan.newFiles, plan.newRuntime);
  if (!Array.isArray(plan.waitFor) || !plan.waitFor.length || plan.waitFor.length > 17 || new Set(plan.waitFor.map(p => p.pid)).size !== plan.waitFor.length || plan.waitFor.some(p => !Number.isInteger(p.pid) || p.pid <= 0 || !/^[0-9]{1,32}$/.test(p.creationTime) || p.pid === process.pid)) throw fail('plan_invalid', 'Owner identities are invalid.');
  if (!plan.restart || !same(plan.restart.program, path.join(plan.installRoot, 'Codlet.app/Contents/MacOS/Codlet')) || plan.restart.args.length || !Number.isInteger(plan.restart.timeoutSeconds) || plan.restart.timeoutSeconds < 5 || plan.restart.timeoutSeconds > 180) throw fail('plan_invalid', 'Restart command is not the owned app launcher.');
  if (!same(plan.helperNode.path, process.execPath) || !same(plan.helperScript.path, self) || !same(plan.identityProbe.path, path.join(job, 'identity-core'))) throw fail('plan_invalid', 'Update helper paths changed.');
  for (const helper of [plan.helperNode, plan.helperScript, plan.identityProbe]) verify(helper.path, helper);
  if (plan.helperNode.sha256 !== plan.currentRuntime.executableSha256 || plan.identityProbe.sha256 !== plan.currentFiles.find(f => f.path === 'Codlet.app/Contents/Resources/codlet').sha256) throw fail('plan_invalid', 'Helper copies differ from the installed app.');
  const manifestBytes = read(path.join(plan.stagedRoot, 'runtime-update-manifest.json'), 2 * 1024 * 1024);
  if (hash(manifestBytes) !== plan.manifestSha256) throw fail('payload_changed', 'Downloaded manifest changed.');
  const manifest = JSON.parse(manifestBytes);
  if (manifest.schema !== 1 || manifest.kind !== 'codlet-runtime-update' || manifest.version !== plan.version || manifest.platform !== plan.platform || manifest.profile !== plan.profile || JSON.stringify(manifest.files) !== JSON.stringify(plan.newFiles) || JSON.stringify(manifest.runtime) !== JSON.stringify(plan.newRuntime)) throw fail('plan_invalid', 'Downloaded manifest differs from the owner plan.');
  if (JSON.stringify(fs.readdirSync(plan.stagedRoot).sort()) !== JSON.stringify(['Codlet.app', 'runtime-update-manifest.json'])) throw fail('plan_invalid', 'Staged archive contains unexpected top-level files.');
}
function ownerCleanupConfirmed(plan, expectedSha) {
  const file = path.join(plan.stateRoot, plan.id, 'owner-cleanup.json');
  if (!fs.existsSync(file)) throw fail('owner_cleanup_unconfirmed', 'The prior Core did not confirm Host and traffic retirement; no app files were changed.');
  const result = JSON.parse(read(file, 4096));
  if (result.schema !== 1 || result.id !== plan.id || result.planSha256 !== expectedSha || result.hostsRetired !== true || result.trafficRetired !== true) throw fail('owner_cleanup_unconfirmed', 'The prior Core cleanup receipt does not match this installation.');
}
async function restart(plan, files, version) {
  const core = path.join(plan.installRoot, 'Codlet.app/Contents/Resources/codlet');
  await codesign(plan.installRoot);
  const opener = spawn('/usr/bin/open', ['-a', path.join(plan.installRoot, 'Codlet.app'), '--args', '--codlet-update-restart'], { stdio: 'ignore', env: { ...process.env, ...plan.restart.environment } });
  const opened = await new Promise(resolve => { opener.once('error', () => resolve(false)); opener.once('exit', code => resolve(code === 0)); });
  if (!opened) return (await bundleProcesses(plan)).length ? 42 : 1;
  const deadline = Date.now() + plan.restart.timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await exec(core, ['status', '--json'], { timeout: 5000, maxBuffer: 1024 * 1024, env: { ...process.env, ...plan.restart.environment } });
      const report = JSON.parse(stdout);
      if (report.status === 'inspected' && report.inspection?.state === 'ready' && report.inspection?.codlet_version === version) return 0;
    } catch {}
    await delay(500);
  }
  return (await bundleProcesses(plan)).length ? 42 : 1;
}
export async function runInstall(planPath, expectedSha, onReady = () => {}, options = {}) {
  const bytes = read(planPath, 2 * 1024 * 1024);
  if (!sha(expectedSha) || hash(bytes) !== expectedSha) throw fail('plan_digest_mismatch', 'Owner plan digest changed.');
  const plan = JSON.parse(bytes); validate(plan, planPath, expectedSha);
  const receipt = { schema: 1, id: plan.id, planSha256: expectedSha, version: plan.version, phase: 'validating', movedOld: [], movedNew: [], configPatched: false, helperIdentity: null, error: null, updatedAt: Date.now() };
  const persist = () => { receipt.updatedAt = Date.now(); writeJson(plan.installReceiptPath, receipt); writeJson(plan.summaryReceiptPath, receipt); };
  if ([plan.installReceiptPath, plan.handoffAckPath, plan.backupRoot, path.join(plan.stateRoot, plan.id, 'owner-cleanup.json')].some(p => fs.existsSync(p))) throw fail('plan_already_used', 'Update plan was already armed.');
  let held, armed = false, mutated = false, ownersRetired = false, restartUnknown = false;
  try {
    held = lock(plan, expectedSha);
    const helperIdentity = await probe(plan, process.pid);
    if (!helperIdentity) throw fail('owner_identity_unavailable', 'Update helper identity cannot be established.');
    receipt.helperIdentity = { pid: helperIdentity.pid, creationTime: helperIdentity.creationTime };
    await verifyApp(plan.installRoot, plan.currentFiles, plan.currentRuntime);
    await verifyApp(plan.stagedRoot, plan.newFiles, plan.newRuntime);
    if (digest(plan.restart.program).sha256 !== plan.restartProgramSha256) throw fail('launcher_changed', 'Installed app launcher changed.');
    const writabilityProbe = path.join(plan.installRoot, '.codlet-update-probe-' + randomUUID());
    fs.writeFileSync(writabilityProbe, '', { flag: 'wx' }); fs.unlinkSync(writabilityProbe);
    receipt.phase = 'ready'; persist(); onReady({ schema: 1, event: 'runtime-update-helper-ready', id: plan.id, planSha256: expectedSha });
    const ackDeadline = Date.now() + 15000;
    while (Date.now() < ackDeadline) {
      if (fs.existsSync(plan.handoffAckPath)) {
        const ack = JSON.parse(read(plan.handoffAckPath, 4096));
        if (ack.id !== plan.id || ack.planSha256 !== expectedSha) throw fail('handoff_ack_invalid', 'Owner acknowledgment changed.');
        armed = true; break;
      }
      await delay(50);
    }
    if (!armed) throw fail('handoff_not_armed', 'Owner did not confirm helper readiness.');
    receipt.phase = 'waitingForExit'; persist();
    const exitDeadline = Date.now() + 180000;
    while (await ownersAlive(plan)) {
      if (Date.now() > exitDeadline) throw fail('owner_still_running', 'Original app is still running; no process was killed.');
      await delay(250);
    }
    // The Swift launcher and native Host owners execute from this bundle.
    // Each owner retires its private Node group before its own process exits.
    // Wait for every bundle owner, including one omitted from the initial PID
    // lease. The fixed deadline never signals any process.
    while ((await bundleProcesses(plan)).length) {
      if (Date.now() > exitDeadline) throw fail('owner_still_running', 'A process from the original Codlet.app is still running; no bundle was replaced.');
      await delay(250);
    }
    ownersRetired = true;
    ownerCleanupConfirmed(plan, expectedSha);
    await verifyApp(plan.installRoot, plan.currentFiles, plan.currentRuntime);
    await verifyApp(plan.stagedRoot, plan.newFiles, plan.newRuntime);
    if ((await bundleProcesses(plan)).length) throw fail('owner_still_running', 'An original Codlet process appeared during final verification; no bundle was replaced.');
    fs.mkdirSync(plan.backupRoot); ordinary(plan.backupRoot, true);
    receipt.phase = 'replacing'; persist();
    fs.renameSync(path.join(plan.installRoot, 'Codlet.app'), path.join(plan.backupRoot, 'Codlet.app')); mutated = true;
    receipt.movedOld.push('Codlet.app'); persist();
    fs.renameSync(path.join(plan.stagedRoot, 'Codlet.app'), path.join(plan.installRoot, 'Codlet.app'));
    receipt.movedNew.push('Codlet.app'); persist();
    await verifyApp(plan.installRoot, plan.newFiles, plan.newRuntime);
    receipt.phase = 'restarting'; persist();
    const result = await (options.restartApp ?? restart)(plan, plan.newFiles, plan.version);
    restartUnknown = result === 0 || result === 42;
    if (result === 42) { receipt.phase = 'rollbackBlocked'; receipt.error = { code: 'restart_owner_unknown', message: 'New app may still be running. Rollback requires owner attention.' }; persist(); return receipt; }
    if (result !== 0) throw fail('restart_failed', 'New app did not reach Core ready state.');
    receipt.phase = 'installed'; persist();
    // The new Core has proven ready. The old signed bundle has no remaining
    // mapped process and is no longer rollback authority; recover disk space.
    try {
      await verifyApp(plan.backupRoot, plan.currentFiles, plan.currentRuntime);
      fs.rmSync(path.join(plan.backupRoot, 'Codlet.app'), { recursive: true });
      fs.rmdirSync(plan.backupRoot);
      receipt.movedOld = []; persist();
    } catch (cleanupError) {
      receipt.backupCleanupError = String(cleanupError.message ?? cleanupError).slice(0, 4096);
      try { persist(); } catch {}
    }
    return receipt;
  } catch (error) {
    receipt.error = { code: error.code ?? 'runtime_update_failed', message: String(error.message ?? error).slice(0, 4096) };
    if (restartUnknown || error.code === 'owner_cleanup_unconfirmed') { receipt.phase = 'rollbackBlocked'; }
    else if (mutated) {
      try {
        receipt.phase = 'rollingBack'; persist();
        if ((await bundleProcesses(plan)).length) throw fail('rollback_blocked', 'An app process is still running.');
        if (fs.existsSync(path.join(plan.installRoot, 'Codlet.app'))) {
          await verifyApp(plan.installRoot, plan.newFiles, plan.newRuntime);
          if (fs.existsSync(path.join(plan.stagedRoot, 'Codlet.app'))) throw fail('rollback_blocked', 'Staged rollback destination is occupied.');
          fs.renameSync(path.join(plan.installRoot, 'Codlet.app'), path.join(plan.stagedRoot, 'Codlet.app'));
          receipt.movedNew = []; persist();
        }
        await verifyApp(plan.backupRoot, plan.currentFiles, plan.currentRuntime);
        fs.renameSync(path.join(plan.backupRoot, 'Codlet.app'), path.join(plan.installRoot, 'Codlet.app'));
        receipt.movedOld = []; persist();
        const result = await (options.restartApp ?? restart)(plan, plan.currentFiles, plan.currentVersion);
        receipt.phase = result === 0 ? 'rolledBack' : result === 42 ? 'rollbackBlocked' : 'rollbackRestartFailed';
      } catch (rollbackError) { receipt.phase = 'rollbackBlocked'; receipt.error = { code: rollbackError.code ?? 'rollback_blocked', message: String(rollbackError.message ?? rollbackError).slice(0, 4096) }; }
    } else if (ownersRetired) {
      try { const result = await (options.restartApp ?? restart)(plan, plan.currentFiles, plan.currentVersion); receipt.phase = result === 0 ? 'oldRuntimeRestarted' : result === 42 ? 'rollbackBlocked' : 'rollbackRestartFailed'; }
      catch (restartError) { receipt.phase = 'rollbackBlocked'; receipt.error = { code: 'old_restart_blocked', message: String(restartError.message ?? restartError).slice(0, 4096) }; }
    } else receipt.phase = 'failed';
    try { persist(); } catch {}
    throw Object.assign(error, { receipt });
  } finally {
    if (held) {
      receipt.lockRetained = !unlock(held, ['installed', 'rolledBack', 'oldRuntimeRestarted', 'failed'].includes(receipt.phase));
      try { persist(); } catch {}
    }
  }
}
if (process.argv[1] && same(process.argv[1], self)) {
  process.stdout.on('error', () => {});
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--plan' || args[2] !== '--sha256') process.exitCode = 1;
  else {
    let ready = false;
    try { const receipt = await runInstall(args[1], args[3], message => { ready = true; process.stdout.write(JSON.stringify(message) + '\n'); }); if (receipt.phase !== 'installed') process.exitCode = 1; }
    catch (error) { if (!ready) process.stdout.write(JSON.stringify({ schema: 1, event: 'runtime-update-helper-failed', error: { code: error.code ?? 'runtime_update_failed', message: String(error.message ?? error).slice(0,4096) } }) + '\n'); process.exitCode = 1; }
  }
}
