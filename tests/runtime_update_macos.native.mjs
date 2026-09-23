// Invoked by the Mac packager with an already sealed preview Codlet.app.
// Every transaction uses disposable copies and never launches the official client.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';

const app = path.resolve(process.argv[2] ?? '');
const version = process.argv[3];
const legacyApp = path.resolve(process.argv[4] ?? '');
const fallback = path.resolve(process.argv[5] ?? '');
const reviewed = process.argv[6] ? path.resolve(process.argv[6]) : null;
if (process.platform !== 'darwin' || process.arch !== 'arm64' || !app.endsWith('/Codlet.app') || !legacyApp.endsWith('/Codlet.app') || !version || !fallback) throw new Error('Run with signed managed and legacy Codlet apps and the pinned fallback on Apple Silicon.');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const checked = file => { const stat = fs.statSync(file); return { path: file, bytes: stat.size, sha256: sha(fs.readFileSync(file)), mode: stat.mode & 0o777 }; };
const pin = JSON.parse(fs.readFileSync(path.join(app, 'Contents/Resources/runtime/node-runtime.json')));
const runtimeFrom = value => {
  const platform = value.platforms['darwin-arm64'];
  return { version: platform.version ?? value.version, executableSha256: platform.executableSha256, licenseSha256: platform.licenseSha256, ...(value.mode === 'managed' ? { mode: 'managed' } : {}) };
};
const runtime = runtimeFrom(pin);
assert.equal(pin.mode, 'managed');
const fallbackNode = path.join(fallback, 'bin/node');
const fallbackLicense = path.join(fallback, 'LICENSE');
assert.equal(checked(fallbackNode).sha256, runtime.executableSha256);
assert.equal(checked(fallbackLicense).sha256, runtime.licenseSha256);
if (reviewed) {
  const profiles = JSON.parse(fs.readFileSync(path.join(app, 'Contents/Resources/runtime/client-node-profiles.json')));
  const profile = profiles.profiles.find(value => value.platform === 'darwin-arm64');
  assert.equal(checked(path.join(reviewed, 'bin/node')).sha256, profile.nodeSha256);
  assert.equal(checked(path.join(reviewed, 'LICENSE')).sha256, profile.licenseSha256);
  assert.notEqual(profile.nodeSha256, runtime.executableSha256, 'the fixture must exercise a client Node distinct from the fallback pin');
}
function inventory(root) {
  const pending = [path.join(root, 'Codlet.app')], files = [];
  while (pending.length) {
    const dir = pending.pop();
    for (const entry of fs.readdirSync(dir)) {
      const file = path.join(dir, entry), stat = fs.lstatSync(file);
      assert.ok(!stat.isSymbolicLink());
      if (stat.isDirectory()) pending.push(file);
      else files.push({ path: path.relative(root, file).split(path.sep).join('/'), bytes: stat.size, sha256: sha(fs.readFileSync(file)), mode: stat.mode & 0o777 });
    }
  }
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
function signed(root) {
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', path.join(root, 'Codlet.app')]);
}
async function scenario(mode) {
  const temp = fs.mkdtempSync(path.join(app, '../..', 'update-native-fixture-'));
  let lingering, owner, updater, releaseTimer, heldAtCheck;
  try {
    const install = path.join(temp, 'install'), state = path.join(temp, 'state');
    const staged = path.join(state, 'runtime-payload-fixture'), job = path.join(state, 'runtime-install-fixture');
    for (const dir of [install, staged, job]) fs.mkdirSync(dir, { recursive: true });
    fs.cpSync(mode === 'managed' ? app : legacyApp, path.join(install, 'Codlet.app'), { recursive: true });
    fs.cpSync(app, path.join(staged, 'Codlet.app'), { recursive: true });
    if (mode === 'linger') {
      for (const root of [install, staged]) {
        const sleeper = path.join(root, 'Codlet.app/Contents/MacOS/fixture-sleeper');
        fs.copyFileSync('/bin/sleep', sleeper); fs.chmodSync(sleeper, 0o755);
        execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', path.join(root, 'Codlet.app')]);
      }
    }
    signed(install);
    const marker = path.join(staged, 'Codlet.app/Contents/Resources/update-native-fixture.txt');
    fs.writeFileSync(marker, `signed update fixture ${mode}\n`, { mode: 0o644 });
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', path.join(staged, 'Codlet.app')]);
    signed(staged);
    const currentFiles = inventory(install), newFiles = inventory(staged);
    const currentPin = JSON.parse(fs.readFileSync(path.join(install, 'Codlet.app/Contents/Resources/runtime/node-runtime.json')));
    const currentRuntime = runtimeFrom(currentPin);
    const manifest = { schema: 1, kind: 'codlet-runtime-update', version, platform: 'darwin-arm64', profile: 'macApp', runtime, files: newFiles };
    const manifestBytes = Buffer.from(JSON.stringify(manifest) + '\n');
    fs.writeFileSync(path.join(staged, 'runtime-update-manifest.json'), manifestBytes);
    const originalCore = path.join(install, 'Codlet.app/Contents/Resources/codlet');
    const identity = path.join(job, 'identity-core'), helperNode = path.join(job, 'helper-node'), helper = path.join(job, 'runtime-update-helper-macos.mjs');
    const cache = path.join(state, 'prepared-node');
    fs.mkdirSync(cache);
    const preparedNode = path.join(cache, 'node'), preparedLicense = path.join(cache, 'LICENSE');
    fs.copyFileSync(fallbackNode, preparedNode); fs.chmodSync(preparedNode, 0o755);
    fs.copyFileSync(fallbackLicense, preparedLicense); fs.chmodSync(preparedLicense, 0o644);
    fs.copyFileSync(originalCore, identity); fs.chmodSync(identity, 0o755);
    const helperSource = mode === 'managed' && reviewed ? path.join(reviewed, 'bin/node')
      : currentPin.mode === 'managed' ? preparedNode
      : path.join(install, `Codlet.app/Contents/Resources/runtime/node-v${currentRuntime.version}-darwin-arm64/bin/node`);
    fs.copyFileSync(helperSource, helperNode); fs.chmodSync(helperNode, 0o755);
    fs.copyFileSync(new URL('../scripts/runtime-update-helper-macos.mjs', import.meta.url), helper); fs.chmodSync(helper, 0o644);
    const driver = path.join(job, 'runtime-update-macos-driver.mjs');
    fs.copyFileSync(new URL('./runtime_update_macos_driver.mjs', import.meta.url), driver);
    const child = owner = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    if (mode === 'linger') lingering = spawn(path.join(install, 'Codlet.app/Contents/MacOS/fixture-sleeper'), ['30'], { stdio: 'ignore' });
    if (mode === 'snapshot') {
      const snapshot = fs.mkdtempSync(path.join(temp, 'codlet-node-'));
      const executable = path.join(snapshot, 'node');
      fs.copyFileSync(fallbackNode, executable); fs.chmodSync(executable, 0o755);
      lingering = spawn(executable, ['-e', 'setTimeout(() => {}, 180000)'], { stdio: 'ignore' });
    }
    const processIdentity = JSON.parse(execFileSync(identity, ['__codlet_update_process_identity', String(child.pid)]));
    const plan = {
      schema: 1, kind: 'codlet-runtime-install-plan', id: path.basename(job), version,
      currentVersion: version, platform: 'darwin-arm64', profile: 'macApp', installRoot: install,
      stateRoot: state, stagedRoot: staged, backupRoot: path.join(job, 'backup'),
      manifestSha256: sha(manifestBytes), currentFiles, newFiles, currentRuntime, newRuntime: runtime,
      preparedNode: checked(preparedNode), preparedLicense: checked(preparedLicense),
      helperNode: checked(helperNode), helperScript: checked(helper), identityProbe: checked(identity),
      restart: { program: path.join(install, 'Codlet.app/Contents/MacOS/Codlet'), args: [], workingDirectory: install, environment: {}, timeoutSeconds: 10 },
      restartProgramSha256: sha(fs.readFileSync(path.join(install, 'Codlet.app/Contents/MacOS/Codlet'))),
      launcherFiles: [], configPin: null, waitFor: [{ pid: child.pid, creationTime: processIdentity.creationTime }],
      handoffAckPath: path.join(job, 'handoff-ack.json'), officialUpdate: false,
      installReceiptPath: path.join(job, 'install-receipt.json'),
      summaryReceiptPath: path.join(state, 'runtime-update-install-receipt.json'),
      createdAt: Date.now(), expiresAt: Date.now() + 30 * 60 * 1000,
    };
    const planPath = path.join(job, 'install-plan.json'), planBytes = Buffer.from(JSON.stringify(plan) + '\n');
    fs.writeFileSync(planPath, planBytes);
    const digest = sha(planBytes);
    if (mode === 'unprepared') fs.writeFileSync(preparedNode, 'candidate runtime changed after preparation');
    updater = spawn(helperNode, [driver, planPath, digest, mode, String(child.pid)], { stdio: ['ignore', 'pipe', 'pipe'] });
    const events = [];
    let pending = '', errors = '';
    updater.stdout.setEncoding('utf8'); updater.stderr.setEncoding('utf8');
    updater.stdout.on('data', chunk => {
      pending += chunk;
      while (pending.includes('\n')) {
        const index = pending.indexOf('\n'), line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        const event = JSON.parse(line); events.push(event);
        if (event.event === 'ready' && mode === 'linger') releaseTimer = setTimeout(() => {
          heldAtCheck = fs.existsSync(path.join(install, 'Codlet.app')) && !fs.existsSync(plan.backupRoot);
          lingering.kill('SIGTERM');
        }, 800);
      }
    });
    updater.stderr.on('data', chunk => errors += chunk);
    await new Promise((resolve, reject) => {
      updater.once('error', reject);
      updater.once('close', code => code === 0 ? resolve() : reject(new Error(`Native updater fixture exited ${code}: ${errors}`)));
    });
    const terminal = events.find(event => event.event === 'result' || event.event === 'error');
    assert.equal(events.some(event => event.event === 'ready'), mode !== 'unprepared');
    assert.ok(terminal);
    if (mode === 'rollback' || mode === 'unclean' || mode === 'unprepared') {
      assert.equal(terminal.event, 'error');
      assert.equal(fs.existsSync(path.join(install, 'Codlet.app/Contents/Resources/update-native-fixture.txt')), false);
      assert.equal(JSON.parse(fs.readFileSync(plan.installReceiptPath)).phase, mode === 'rollback' ? 'rolledBack' : mode === 'unclean' ? 'rollbackBlocked' : 'failed');
    } else {
      assert.equal(terminal.event, 'result');
      assert.equal(terminal.phase, mode === 'unknown' ? 'rollbackBlocked' : 'installed');
      assert.equal(fs.readFileSync(path.join(install, 'Codlet.app/Contents/Resources/update-native-fixture.txt'), 'utf8'), `signed update fixture ${mode}\n`);
      assert.equal(fs.existsSync(path.join(plan.backupRoot, 'Codlet.app')), mode === 'unknown');
      if (mode !== 'unknown') assert.equal(fs.existsSync(path.join(install, `Codlet.app/Contents/Resources/runtime/node-v${runtime.version}-darwin-arm64/bin/node`)), false, 'installed managed app must not embed Node');
    }
    signed(install);
    if (mode === 'linger') assert.equal(heldAtCheck, true, 'a live owned bundle process must prevent replacement');
    if (mode === 'snapshot') assert.equal(lingering.exitCode === null && lingering.signalCode === null, true, 'an unrelated Codlet Node snapshot must not block this app update');
    assert.equal(fs.existsSync(path.join(install, '.codlet-runtime-update.lock.json')), mode === 'unknown' || mode === 'unclean');
    assert.equal(terminal.calls, mode === 'rollback' ? 2 : mode === 'unclean' || mode === 'unprepared' ? 0 : 1);
  } catch (error) {
    console.error(`Native updater fixture ${mode} failed:`, error);
    throw error;
  } finally {
    if (releaseTimer) clearTimeout(releaseTimer);
    for (const child of [owner, lingering, updater]) {
      const active = () => child && child.exitCode === null && child.signalCode === null;
      if (active()) child.kill('SIGTERM');
      if (active()) await new Promise(resolve => child.once('exit', resolve));
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
await scenario('installed');
await scenario('managed');
await scenario('linger');
await scenario('snapshot');
await scenario('rollback');
await scenario('unknown');
await scenario('unclean');
await scenario('unprepared');
console.log(`Native Mac updater fixture: legacy-to-managed and managed-to-managed exchange, scoped wait, rollback, and pre-swap runtime failure passed${reviewed ? ' with the independently verified official CUA Node helper' : ''}.`);
