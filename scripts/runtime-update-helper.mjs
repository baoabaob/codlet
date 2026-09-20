// Trusted Codlet update helper. This file is embedded in Core and copied outside
// the payload before handoff. It never executes code from the downloaded ZIP.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile), self = fileURLToPath(import.meta.url);
const MAX_FILE = 512 * 1024 * 1024;
const fail = (code, message) => Object.assign(new Error(message), { code });
const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const key = value => path.resolve(value).replace(/^\\\\\?\\/, '').toLowerCase();
const inside = (file, root) => key(file).startsWith(key(root) + path.sep);
function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') || value.split(/[\\/]/).some(p => p === '.' || p === '..')) throw fail('plan_path_invalid', 'Update plan contains an invalid absolute path.');
  return path.resolve(value);
}
function ordinary(file, directory = false, allowHardLinks = false) {
  absolute(file);
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || (!allowHardLinks && stat.nlink !== 1))) throw fail('plan_path_invalid', 'Update paths contain a link or special file.');
  if (key(fs.realpathSync.native(file)) !== key(file)) throw fail('plan_path_invalid', 'Update path redirects elsewhere.');
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
  if (before.size > limit) throw fail('plan_size_limit', 'Update metadata exceeds its limit.');
  const bytes = fs.readFileSync(file), after = ordinary(file);
  if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw fail('payload_changed', 'Update metadata changed while reading.');
  return bytes;
}
function digest(file, allowHardLinks = false) {
  ancestors(file);
  const before = ordinary(file, false, allowHardLinks);
  if (before.size > MAX_FILE) throw fail('plan_size_limit', 'Runtime payload file exceeds its limit.');
  const fd = fs.openSync(file, 'r'), hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
  let count = 0;
  try { for (;;) { const size = fs.readSync(fd, buffer, 0, buffer.length, null); if (!size) break; count += size; if (count > MAX_FILE) throw fail('plan_size_limit', 'Runtime payload grew beyond its limit.'); hash.update(buffer.subarray(0, size)); } }
  finally { fs.closeSync(fd); }
  const after = ordinary(file, false, allowHardLinks);
  if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw fail('payload_changed', 'Runtime payload changed while hashing.');
  return { bytes: count, sha256: hash.digest('hex') };
}
function verify(file, record) {
  if (!sha(record.sha256) || !Number.isSafeInteger(record.bytes) || record.bytes < 0) throw fail('plan_invalid', 'Invalid runtime file identity.');
  const actual = digest(file);
  if (actual.bytes !== record.bytes || actual.sha256 !== record.sha256) throw fail('payload_changed', 'Runtime payload no longer matches the checked installation plan.');
}
function writeJson(file, data) {
  ancestors(file);
  if (fs.existsSync(file)) ordinary(file);
  const temporary = file + '.' + randomUUID() + '.tmp';
  const fd = fs.openSync(temporary, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify(data, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
}
function parentFor(file, root) {
  if (!inside(file, root)) throw fail('plan_path_invalid', 'Update destination escaped its owned directory.');
  const relative = path.relative(root, path.dirname(file));
  let current = root; ordinary(current, true);
  for (const part of relative ? relative.split(path.sep) : []) { current = path.join(current, part); if (!fs.existsSync(current)) fs.mkdirSync(current); ordinary(current, true); }
}
function expectedPaths(profile, runtime, includeOther = false) {
  if (!['portable', 'isolatedClient'].includes(profile) || typeof runtime?.version !== 'string' || !/^[0-9A-Za-z.-]{1,64}$/.test(runtime.version) || runtime.version.includes('..') || !sha(runtime.executableSha256) || !sha(runtime.licenseSha256)) throw fail('plan_invalid', 'Invalid runtime profile or Node identity.');
  const node = `runtime/node-v${runtime.version}-win-x64`;
  return [profile === 'portable' ? 'codlet.exe' : 'codlet-lab.exe', 'runtime/node-runtime.json', `${node}/node.exe`, `${node}/LICENSE`, ...(includeOther ? [profile === 'portable' ? 'codlet-lab.exe' : 'codlet.exe'] : [])].sort();
}
function records(files, profile, runtime) {
  const other = profile === 'portable' ? 'codlet-lab.exe' : 'codlet.exe';
  if (!Array.isArray(files) || files.length > 8 || JSON.stringify(files.map(f => f.path).sort()) !== JSON.stringify(expectedPaths(profile, runtime, files.some(f => f.path === other)))) throw fail('plan_path_invalid', 'Update plan must name exactly the owned runtime files.');
  for (const file of files) if (!sha(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_FILE) throw fail('plan_invalid', 'Invalid runtime payload record.');
  const node = files.find(f => f.path.endsWith('/node.exe')), license = files.find(f => f.path.endsWith('/LICENSE'));
  if (node.sha256 !== runtime.executableSha256 || license.sha256 !== runtime.licenseSha256) throw fail('plan_invalid', 'Runtime records differ from the checked Node pins.');
}
function fileIn(root, relative) {
  const file = path.join(root, relative);
  if (!inside(file, root)) throw fail('plan_path_invalid', 'Runtime file escaped its owned directory.');
  ancestors(file); return file;
}
function validatePlan(plan, planPath, planSha) {
  if (plan.officialUpdate != null && typeof plan.officialUpdate !== 'boolean') throw fail('plan_invalid', 'Invalid official update gate.');
  if (plan.schema !== 1 || plan.kind !== 'codlet-runtime-install-plan' || plan.platform !== 'win-x64' || !/^runtime-install-[A-Za-z0-9_-]+$/.test(plan.id) || !sha(planSha) || !sha(plan.manifestSha256)) throw fail('plan_invalid', 'Unrecognized runtime installation plan.');
  const job = path.dirname(absolute(planPath));
  if (process.platform === 'win32' && path.parse(key(plan.installRoot)).root !== path.parse(key(plan.stateRoot)).root) throw fail('plan_cross_volume', 'Runtime staging and installation must be on the same volume before any owner is closed.');
  if (key(job) !== key(path.join(absolute(plan.stateRoot), plan.id)) || path.basename(planPath) !== 'install-plan.json') throw fail('plan_path_invalid', 'Install plan is outside its checked job directory.');
  for (const [field, relative] of [['backupRoot', 'backup'], ['handoffAckPath', 'handoff-ack.json'], ['installReceiptPath', 'install-receipt.json']]) if (key(absolute(plan[field])) !== key(path.join(job, relative))) throw fail('plan_path_invalid', 'Install plan redirected an owned transaction path.');
  if (key(absolute(plan.summaryReceiptPath)) !== key(path.join(plan.stateRoot, 'runtime-update-install-receipt.json'))) throw fail('plan_path_invalid', 'Install receipt is outside the update state directory.');
  ordinary(plan.stateRoot, true); ordinary(job, true); ordinary(plan.installRoot, true); ordinary(plan.stagedRoot, true);
  if (key(path.dirname(plan.stagedRoot)) !== key(plan.stateRoot) || !path.basename(plan.stagedRoot).startsWith('runtime-payload-') || key(plan.installRoot) === key(path.parse(plan.installRoot).root)) throw fail('plan_path_invalid', 'Runtime payload roots are not valid owned directories.');
  if (!Number.isSafeInteger(plan.createdAt) || !Number.isSafeInteger(plan.expiresAt) || plan.expiresAt <= Date.now() || plan.createdAt > Date.now() + 30000 || plan.expiresAt - plan.createdAt > 30 * 60 * 1000) throw fail('plan_expired', 'Runtime installation plan expired.');
  records(plan.currentFiles, plan.profile, plan.currentRuntime); records(plan.newFiles, plan.profile, plan.newRuntime);
  const otherExecutable = plan.profile === 'portable' ? 'codlet-lab.exe' : 'codlet.exe';
  if (plan.newFiles.some(f => f.path === otherExecutable) && !plan.currentFiles.some(f => f.path === otherExecutable)) throw fail('plan_invalid', 'Update cannot add another executable outside the existing owner profile.');
  if (!Array.isArray(plan.waitFor) || !plan.waitFor.length || plan.waitFor.length > 17 || new Set(plan.waitFor.map(p => p.pid)).size !== plan.waitFor.length || plan.waitFor.some(p => !Number.isSafeInteger(p.pid) || p.pid <= 0 || !/^[0-9]{1,32}$/.test(p.creationTime))) throw fail('plan_invalid', 'Invalid owner process identities.');
  for (const process of plan.waitFor) if (process.pid === globalThis.process.pid) throw fail('plan_invalid', 'Update helper cannot wait for its own exit.');
  const command = plan.restart;
  if (!command || !Array.isArray(command.args) || command.args.length > 128 || command.args.some(s => typeof s !== 'string' || s.includes('\0') || s.length > 16384) || !Number.isInteger(command.timeoutSeconds) || command.timeoutSeconds < 5 || command.timeoutSeconds > 180) throw fail('plan_invalid', 'Invalid owner restart command.');
  absolute(command.program); ordinary(command.workingDirectory, true);
  if (!Array.isArray(plan.launcherFiles) || plan.launcherFiles.length > 16 || !command.environment || typeof command.environment !== 'object' || Array.isArray(command.environment) || Object.keys(command.environment).length > 64 || Object.entries(command.environment).some(([k,v]) => !k || /[=\0]/.test(k) || typeof v !== 'string' || v.includes('\0') || v.length > 32768)) throw fail('plan_invalid', 'Invalid checked launcher files or environment.');
  if (key(plan.helperNode.path) !== key(process.execPath) || key(plan.helperScript.path) !== key(self)) throw fail('plan_invalid', 'Helper executable/script identity differs from the checked plan.');
  for (const helper of [plan.helperNode, plan.helperScript]) {
    if ([...plan.currentFiles, ...plan.newFiles].some(f => key(fileIn(plan.installRoot, f.path)) === key(helper.path))) throw fail('plan_invalid', 'Helper must run outside payload files being replaced.');
    verify(helper.path, helper);
  }
  const manifestBytes = read(path.join(plan.stagedRoot, 'runtime-update-manifest.json'));
  if (hashBytes(manifestBytes) !== plan.manifestSha256) throw fail('payload_changed', 'Runtime ZIP manifest changed after download.');
  const manifest = JSON.parse(manifestBytes);
  const fileValues = files => files.map(f => [f.path, f.bytes, f.sha256]);
  const runtimeValues = runtime => [runtime.version, runtime.executableSha256, runtime.licenseSha256];
  if (manifest.schema !== 1 || manifest.kind !== 'codlet-runtime-update' || manifest.version !== plan.version || manifest.platform !== plan.platform || manifest.profile !== plan.profile || JSON.stringify(fileValues(manifest.files)) !== JSON.stringify(fileValues(plan.newFiles)) || JSON.stringify(runtimeValues(manifest.runtime)) !== JSON.stringify(runtimeValues(plan.newRuntime))) throw fail('plan_invalid', 'Release manifest no longer matches the checked plan.');
  if (plan.configPin) {
    const pin = plan.configPin, oldLab = plan.currentFiles.find(f => f.path === 'codlet-lab.exe'), newLab = plan.newFiles.find(f => f.path === 'codlet-lab.exe');
    absolute(pin.path);
    if (!oldLab || !newLab || pin.field !== 'labBinarySha256' || typeof pin.oldValue !== 'string' || pin.oldValue.toLowerCase() !== oldLab.sha256 || pin.newValue !== newLab.sha256 || pin.newNodeRelative !== `runtime/node-v${plan.newRuntime.version}-win-x64/node.exe` || typeof pin.oldNodeRelative !== 'string' || pin.oldNodeRelative.replaceAll('\\', '/') !== `runtime/node-v${plan.currentRuntime.version}-win-x64/node.exe` || pin.bytes > 256 * 1024 || !sha(pin.sha256)) throw fail('plan_invalid', 'Launcher patch may change only the checked labBinarySha256 and nodeRelative pins.');
    if ([...plan.currentFiles, ...plan.newFiles].some(f => key(fileIn(plan.installRoot, f.path)) === key(pin.path))) throw fail('plan_invalid', 'Launcher pin patch overlaps payload.');
  }
}
function verifyCurrent(plan) {
  for (const file of plan.currentFiles) verify(fileIn(plan.installRoot, file.path), file);
  for (const file of plan.newFiles) if (!plan.currentFiles.some(old => old.path === file.path) && fs.existsSync(fileIn(plan.installRoot, file.path))) throw fail('file_conflict', 'An unowned file occupies a new runtime path.');
  if (plan.configPin) {
    verify(plan.configPin.path, plan.configPin);
    const config = JSON.parse(read(plan.configPin.path));
    if (config.labBinarySha256 !== plan.configPin.oldValue || config.nodeRelative !== plan.configPin.oldNodeRelative) throw fail('payload_changed', 'Launcher runtime pins changed after confirmation.');
  }
}
function verifyStaged(plan) { for (const file of plan.newFiles) verify(fileIn(plan.stagedRoot, file.path), file); }
function probeWritable(root) {
  const first = path.join(root, '.codlet-update-probe-' + randomUUID()), second = first + '.renamed';
  if (!inside(first, root)) throw fail('plan_path_invalid', 'Invalid installation write probe.');
  try { const fd = fs.openSync(first, 'wx'); fs.closeSync(fd); fs.renameSync(first, second); fs.unlinkSync(second); }
  finally { for (const file of [first, second]) if (fs.existsSync(file)) { ordinary(file); fs.unlinkSync(file); } }
}
async function acquireInstallLock(plan, planSha) {
  const file = path.join(plan.installRoot, '.codlet-runtime-update.lock.json');
  ancestors(file);
  const owner = await captureProcessIdentity(process.pid);
  if (!owner) throw fail('install_lock_identity', 'Cannot establish the update helper process identity.');
  const value = { schema: 1, kind: 'codlet-runtime-install-lock', id: plan.id, planSha256: planSha, pid: owner.pid, creationTime: owner.creationTime, nonce: randomUUID() };
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw fail('runtime_update_locked', 'Another transaction or unrecovered lock owns this installation. No owner was closed and no payload was changed.'); throw error; }
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); }
  catch (error) { fs.closeSync(fd); throw error; }
  return { file, fd, value };
}
function releaseInstallLock(lock, remove) {
  try {
    if (!remove) return false;
    const current = JSON.parse(read(lock.file, 4096));
    if (JSON.stringify(current) !== JSON.stringify(lock.value)) return false;
    const handle = fs.fstatSync(lock.fd), named = ordinary(lock.file);
    if (handle.ino !== named.ino || handle.dev !== named.dev) return false;
    fs.closeSync(lock.fd); lock.fd = null;
    fs.unlinkSync(lock.file); return true;
  } catch { return false; }
  finally { if (lock.fd !== null) { fs.closeSync(lock.fd); lock.fd = null; } }
}
function restartHash(plan, file, useNew, receipt) {
  if (plan.configPin && key(file) === key(plan.configPin.path)) return useNew ? receipt.configAfterSha : plan.configPin.sha256;
  const record = (useNew ? plan.newFiles : plan.currentFiles).find(f => key(fileIn(plan.installRoot, f.path)) === key(file));
  return record?.sha256;
}
function verifyLauncher(plan, useNew, receipt) {
  // A checked system restart executable can be hard-linked into WinSxS. It is
  // never a mutable payload member; payload/config/script checks remain strict.
  if (digest(plan.restart.program, true).sha256 !== (restartHash(plan, plan.restart.program, useNew, receipt) ?? plan.restartProgramSha256)) throw fail('launcher_changed', 'Owner restart executable changed after confirmation.');
  for (const file of plan.launcherFiles) if (digest(file.path).sha256 !== (restartHash(plan, file.path, useNew, receipt) ?? file.sha256)) throw fail('launcher_changed', 'An owner launcher file changed after confirmation.');
}
export async function captureProcessIdentity(pid) {
  if (process.platform !== 'win32') {
    try { const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return { pid, creationTime: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] }; } catch { return null; }
  }
  const powershell = path.join(process.env.SYSTEMROOT ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const { stdout } = await exec(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "$p=Get-Process -Id ([int]$env:CODLET_UPDATE_PROCESS_ID) -ErrorAction SilentlyContinue; if($null -ne $p){[pscustomobject]@{pid=$p.Id;creationTime=$p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()}|ConvertTo-Json -Compress}"], { windowsHide: true, env: { ...process.env, CODLET_UPDATE_PROCESS_ID: String(pid) }, timeout: 15000, maxBuffer: 4096 });
  return stdout.trim() ? JSON.parse(stdout) : null;
}
async function ownersAlive(identities) {
  if (process.platform !== 'win32') {
    const current = await Promise.all(identities.map(p => captureProcessIdentity(p.pid)));
    return current.some((p,i) => p?.creationTime === identities[i].creationTime);
  }
  const powershell = path.join(process.env.SYSTEMROOT ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const source = "$alive=$false; foreach($owner in ($env:CODLET_UPDATE_WAIT_FOR|ConvertFrom-Json)){ $p=Get-Process -Id ([int]$owner.pid) -ErrorAction SilentlyContinue; if($null -ne $p -and $p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -eq $owner.creationTime){$alive=$true} }; if($alive){'true'}else{'false'}";
  const { stdout } = await exec(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', source], { windowsHide: true, env: { ...process.env, CODLET_UPDATE_WAIT_FOR: JSON.stringify(identities) }, timeout: 15000, maxBuffer: 4096 });
  if (!['true', 'false'].includes(stdout.trim())) throw fail('owner_identity_unavailable', 'Cannot verify owner process retirement.');
  return stdout.trim() === 'true';
}
async function restart(plan, useNew, receipt) {
  verifyLauncher(plan, useNew, receipt);
  const command = plan.restart;
  return new Promise(resolve => {
    let settled = false;
    const finish = code => { if (settled) return; settled = true; clearTimeout(timer); resolve(code); };
    const child = spawn(command.program, command.args, { cwd: command.workingDirectory, env: { ...process.env, ...command.environment }, windowsHide: true, detached: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.unref(); finish(42); }, command.timeoutSeconds * 1000);
    child.once('error', () => finish(1));
    child.once('exit', code => finish(code === 0 ? 0 : code === 42 ? 42 : 1));
  });
}
function patchConfig(plan, receipt) {
  const pin = plan.configPin; if (!pin) return;
  verify(pin.path, pin);
  const beforeBytes = read(pin.path), before = JSON.parse(beforeBytes);
  if (before.labBinarySha256 !== pin.oldValue || before.nodeRelative !== pin.oldNodeRelative) throw fail('payload_changed', 'Launcher pins changed after confirmation.');
  const backup = path.join(plan.backupRoot, 'launcher-config.original');
  fs.writeFileSync(backup, beforeBytes, { flag: 'wx' });
  const after = { ...before, labBinarySha256: pin.newValue, nodeRelative: pin.newNodeRelative };
  const stripped = value => Object.fromEntries(Object.entries(value).filter(([k]) => !['labBinarySha256', 'nodeRelative'].includes(k)));
  if (JSON.stringify(stripped(after)) !== JSON.stringify(stripped(before))) throw fail('plan_invalid', 'Launcher patch changed an unapproved field.');
  writeJson(pin.path, after);
  receipt.configAfterSha = digest(pin.path).sha256; receipt.configPatched = true;
}
function rollback(plan, receipt, persist) {
  // Validate every surviving new file before the first rollback mutation. A user
  // edit or still-running new process must not be overwritten or force-killed.
  for (const relative of receipt.movedNew) verify(fileIn(plan.installRoot, relative), plan.newFiles.find(f => f.path === relative));
  for (const relative of receipt.movedOld) verify(fileIn(plan.backupRoot, relative), plan.currentFiles.find(f => f.path === relative));
  if (receipt.configPatched && digest(plan.configPin.path).sha256 !== receipt.configAfterSha) throw fail('rollback_blocked', 'Launcher configuration changed after the update; rollback requires attention.');
  for (const relative of [...receipt.movedNew].reverse()) {
    const source = fileIn(plan.installRoot, relative), target = fileIn(plan.stagedRoot, relative);
    if (fs.existsSync(target)) throw fail('rollback_blocked', 'Staged rollback destination is occupied.');
    parentFor(target, plan.stagedRoot); fs.renameSync(source, target);
    receipt.movedNew.splice(receipt.movedNew.indexOf(relative), 1); persist();
  }
  for (const relative of [...receipt.movedOld].reverse()) {
    const source = fileIn(plan.backupRoot, relative), target = fileIn(plan.installRoot, relative);
    if (fs.existsSync(target)) throw fail('rollback_blocked', 'Original rollback destination is occupied.');
    parentFor(target, plan.installRoot); fs.renameSync(source, target);
    receipt.movedOld.splice(receipt.movedOld.indexOf(relative), 1); persist();
  }
  if (receipt.configPatched) {
    const original = path.join(plan.backupRoot, 'launcher-config.original');
    verify(original, plan.configPin);
    const temporary = plan.configPin.path + '.' + randomUUID() + '.tmp';
    fs.writeFileSync(temporary, read(original), { flag: 'wx' }); fs.renameSync(temporary, plan.configPin.path);
    receipt.configPatched = false; persist();
  }
  verifyCurrent(plan);
}
export function officialResult(plan, expectedSha, required = false) {
  if (!plan.officialUpdate) return;
  const file = path.join(plan.stateRoot, plan.id, 'official-result.json');
  if (!fs.existsSync(file)) {
    if (required) throw fail('official_update_unconfirmed', 'The official installation was not confirmed; no Codlet files were changed.');
    return;
  }
  const result = JSON.parse(read(file, 8192));
  if (result.id !== plan.id || result.planSha256 !== expectedSha || typeof result.ready !== 'boolean') throw fail('official_update_gate_invalid', 'The official update result does not match this transaction.');
  if (!result.ready) throw fail('official_update_cancelled', String(result.detail ?? 'Official update cancelled').slice(0,4096));
}
export async function runInstall(planPath, expectedSha, onReady = () => {}) {
  const bytes = read(planPath);
  if (!sha(expectedSha) || hashBytes(bytes) !== expectedSha) throw fail('plan_digest_mismatch', 'Install plan SHA-256 differs from the owner handoff.');
  const plan = JSON.parse(bytes);
  validatePlan(plan, planPath, expectedSha);
  const receipt = { schema: 1, id: plan.id, planSha256: expectedSha, version: plan.version, phase: 'validating', movedOld: [], movedNew: [], configPatched: false, configAfterSha: null, updatedAt: Date.now(), error: null };
  const persist = () => { receipt.updatedAt = Date.now(); writeJson(plan.installReceiptPath, receipt); writeJson(plan.summaryReceiptPath, receipt); };
  if (fs.existsSync(plan.installReceiptPath) || fs.existsSync(plan.handoffAckPath) || fs.existsSync(plan.backupRoot)) throw fail('plan_already_used', 'Install plan already has a handoff or transaction receipt. Create a fresh owner request.');
  let armed = false, mutated = false, ownersRetired = false, restartMayBeRunning = false, installLock = null;
  try {
    installLock = await acquireInstallLock(plan, expectedSha);
    verifyCurrent(plan); verifyStaged(plan); verifyLauncher(plan, false, receipt); probeWritable(plan.installRoot);
    receipt.phase = 'ready'; persist(); onReady({ schema: 1, event: 'runtime-update-helper-ready', id: plan.id, planSha256: expectedSha });
    const ackDeadline = Date.now() + 15000;
    while (Date.now() < ackDeadline) {
      if (fs.existsSync(plan.handoffAckPath)) {
        const ack = JSON.parse(read(plan.handoffAckPath, 4096));
        if (ack.id !== plan.id || ack.planSha256 !== expectedSha) throw fail('handoff_ack_invalid', 'Install acknowledgement does not match this plan.');
        armed = true; break;
      }
      await delay(50);
    }
    if (!armed) throw fail('handoff_not_armed', 'Owner did not acknowledge the helper; no runtime files were changed.');
    receipt.phase = 'waitingForExit'; persist();
    const exitDeadline = Date.now() + (plan.officialUpdate ? 600000 : 180000);
    while (await ownersAlive(plan.waitFor)) {
      officialResult(plan, expectedSha);
      if (Date.now() >= exitDeadline) throw fail('owner_still_running', 'Original owner processes are still running. No process was killed and no runtime files were changed.');
      await delay(250);
    }
    officialResult(plan, expectedSha, true);
    ownersRetired = true;
    verifyCurrent(plan); verifyStaged(plan); verifyLauncher(plan, false, receipt);
    fs.mkdirSync(plan.backupRoot); ordinary(plan.backupRoot, true);
    receipt.phase = 'replacing'; persist();
    for (const file of plan.currentFiles) {
      const old = fileIn(plan.installRoot, file.path), backup = fileIn(plan.backupRoot, file.path);
      parentFor(backup, plan.backupRoot); fs.renameSync(old, backup); mutated = true;
      receipt.movedOld.push(file.path); persist();
    }
    for (const file of plan.newFiles) {
      const staged = fileIn(plan.stagedRoot, file.path), target = fileIn(plan.installRoot, file.path);
      if (fs.existsSync(target)) throw fail('file_conflict', 'A new runtime destination was occupied during installation.');
      parentFor(target, plan.installRoot); fs.renameSync(staged, target);
      receipt.movedNew.push(file.path); persist();
    }
    patchConfig(plan, receipt); persist();
    receipt.phase = 'restarting'; persist();
    const result = await restart(plan, true, receipt);
    // Once readiness succeeds or retirement is unknown, even a later journal
    // write failure cannot authorize touching files beneath that new owner.
    restartMayBeRunning = result === 0 || result === 42;
    if (result === 42) { receipt.phase = 'rollbackBlocked'; receipt.error = { code: 'restart_owner_unknown', message: 'The new launcher could not prove all owned processes are stopped. No rollback or second launcher was attempted.' }; persist(); return receipt; }
    if (result !== 0) throw fail('restart_failed', 'New runtime failed the owner readiness check.');
    receipt.phase = 'installed'; persist(); return receipt;
  } catch (error) {
    receipt.error = { code: error.code ?? 'runtime_update_failed', message: String(error.message ?? error).slice(0,4096) };
    if (restartMayBeRunning) {
      receipt.phase = 'rollbackBlocked';
      receipt.error = { code: 'receipt_failed_after_restart', message: 'The new owner may still be running and its final receipt could not be saved. No rollback or second launcher was attempted.' };
    } else if (mutated) {
      try {
        receipt.phase = 'rollingBack'; persist(); rollback(plan, receipt, persist);
        const restarted = await restart(plan, false, receipt);
        receipt.phase = restarted === 0 ? 'rolledBack' : restarted === 42 ? 'rollbackBlocked' : 'rollbackRestartFailed';
      } catch (rollbackError) { receipt.phase = 'rollbackBlocked'; receipt.error = { code: rollbackError.code ?? 'rollback_blocked', message: String(rollbackError.message ?? rollbackError).slice(0,4096) }; }
    } else if (ownersRetired) {
      try {
        verifyCurrent(plan); verifyLauncher(plan, false, receipt);
        const restarted = await restart(plan, false, receipt);
        receipt.phase = restarted === 0 ? 'oldRuntimeRestarted' : restarted === 42 ? 'rollbackBlocked' : 'rollbackRestartFailed';
      } catch (restartError) { receipt.phase = 'rollbackBlocked'; receipt.error = { code: restartError.code ?? 'old_restart_blocked', message: String(restartError.message ?? restartError).slice(0,4096) }; }
    } else receipt.phase = 'failed';
    try { persist(); } catch (receiptError) { receipt.persistenceError = String(receiptError.message ?? receiptError).slice(0,4096); }
    throw Object.assign(error, { receipt });
  } finally {
    if (installLock) {
      const safe = ['installed', 'rolledBack', 'oldRuntimeRestarted', 'failed'].includes(receipt.phase);
      receipt.lockRetained = !releaseInstallLock(installLock, safe);
      try { persist(); } catch {}
    }
  }
}

if (process.argv[1] && key(process.argv[1]) === key(self)) {
  process.stdout.on('error', () => {});
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--plan' || args[2] !== '--sha256') { process.stderr.write('Expected --plan PATH --sha256 SHA256\n'); process.exitCode = 1; }
  else {
    let ready = false, id = null;
    try {
      const result = await runInstall(args[1], args[3], message => { ready = true; id = message.id; process.stdout.write(JSON.stringify(message) + '\n'); });
      if (result.phase !== 'installed') process.exitCode = 1;
    } catch (error) {
      if (!ready) process.stdout.write(JSON.stringify({ schema:1,event:'runtime-update-helper-failed',id:error.receipt?.id??id,error:{code:error.code??'runtime_update_failed',message:String(error.message??error).slice(0,4096)} })+'\n');
      process.exitCode = 1;
    }
  }
}
