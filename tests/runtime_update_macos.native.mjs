// Invoked by the Mac packager with an already sealed preview Codlet.app.
// Every transaction uses disposable copies and never launches the official client.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';

const app = path.resolve(process.argv[2] ?? '');
const version = process.argv[3];
if (process.platform !== 'darwin' || process.arch !== 'arm64' || !app.endsWith('/Codlet.app') || !version) throw new Error('Run with a signed Codlet.app and version on Apple Silicon.');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const checked = file => { const stat = fs.statSync(file); return { path: file, bytes: stat.size, sha256: sha(fs.readFileSync(file)), mode: stat.mode & 0o777 }; };
const pin = JSON.parse(fs.readFileSync(path.join(app, 'Contents/Resources/runtime/node-runtime.json')));
const node = pin.platforms['darwin-arm64'];
const runtime = { version: node.version ?? pin.version, executableSha256: node.executableSha256, licenseSha256: node.licenseSha256 };
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
    fs.cpSync(app, path.join(install, 'Codlet.app'), { recursive: true });
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
    const manifest = { schema: 1, kind: 'codlet-runtime-update', version, platform: 'darwin-arm64', profile: 'macApp', runtime, files: newFiles };
    const manifestBytes = Buffer.from(JSON.stringify(manifest) + '\n');
    fs.writeFileSync(path.join(staged, 'runtime-update-manifest.json'), manifestBytes);
    const originalCore = path.join(install, 'Codlet.app/Contents/Resources/codlet');
    const originalNode = path.join(install, `Codlet.app/Contents/Resources/runtime/node-v${runtime.version}-darwin-arm64/bin/node`);
    const identity = path.join(job, 'identity-core'), helperNode = path.join(job, 'helper-node'), helper = path.join(job, 'runtime-update-helper-macos.mjs');
    fs.copyFileSync(originalCore, identity); fs.chmodSync(identity, 0o755);
    fs.copyFileSync(originalNode, helperNode); fs.chmodSync(helperNode, 0o755);
    fs.copyFileSync(new URL('../scripts/runtime-update-helper-macos.mjs', import.meta.url), helper); fs.chmodSync(helper, 0o644);
    const driver = path.join(job, 'runtime-update-macos-driver.mjs');
    fs.copyFileSync(new URL('./runtime_update_macos_driver.mjs', import.meta.url), driver);
    const child = owner = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    if (mode === 'linger') lingering = spawn(path.join(install, 'Codlet.app/Contents/MacOS/fixture-sleeper'), ['30'], { stdio: 'ignore' });
    if (mode === 'snapshot') {
      const snapshot = fs.mkdtempSync(path.join(temp, 'codlet-node-'));
      const executable = path.join(snapshot, 'node');
      fs.copyFileSync(originalNode, executable); fs.chmodSync(executable, 0o755);
      lingering = spawn(executable, ['-e', 'setTimeout(() => {}, 180000)'], { stdio: 'ignore' });
    }
    const processIdentity = JSON.parse(execFileSync(identity, ['__codlet_update_process_identity', String(child.pid)]));
    const plan = {
      schema: 1, kind: 'codlet-runtime-install-plan', id: path.basename(job), version,
      currentVersion: version, platform: 'darwin-arm64', profile: 'macApp', installRoot: install,
      stateRoot: state, stagedRoot: staged, backupRoot: path.join(job, 'backup'),
      manifestSha256: sha(manifestBytes), currentFiles, newFiles, currentRuntime: runtime, newRuntime: runtime,
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
    assert.ok(events.some(event => event.event === 'ready'));
    assert.ok(terminal);
    if (mode === 'rollback' || mode === 'unclean') {
      assert.equal(terminal.event, 'error');
      assert.equal(fs.existsSync(path.join(install, 'Codlet.app/Contents/Resources/update-native-fixture.txt')), false);
      assert.equal(JSON.parse(fs.readFileSync(plan.installReceiptPath)).phase, mode === 'rollback' ? 'rolledBack' : 'rollbackBlocked');
    } else {
      assert.equal(terminal.event, 'result');
      assert.equal(terminal.phase, mode === 'unknown' ? 'rollbackBlocked' : 'installed');
      assert.equal(fs.readFileSync(path.join(install, 'Codlet.app/Contents/Resources/update-native-fixture.txt'), 'utf8'), `signed update fixture ${mode}\n`);
      assert.equal(fs.existsSync(path.join(plan.backupRoot, 'Codlet.app')), mode === 'unknown');
    }
    signed(install);
    if (mode === 'linger') assert.equal(heldAtCheck, true, 'a live owned bundle process must prevent replacement');
    if (mode === 'snapshot') assert.equal(lingering.exitCode === null && lingering.signalCode === null, true, 'an unrelated Codlet Node snapshot must not block this app update');
    assert.equal(fs.existsSync(path.join(install, '.codlet-runtime-update.lock.json')), mode === 'unknown' || mode === 'unclean');
    assert.equal(terminal.calls, mode === 'rollback' ? 2 : mode === 'unclean' ? 0 : 1);
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
await scenario('linger');
await scenario('snapshot');
await scenario('rollback');
await scenario('unknown');
await scenario('unclean');
console.log('Native Mac updater fixture: scoped wait, signed bundle exchange, rollback, and failed cleanup retention passed.');
