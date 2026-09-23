import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { runInstall, captureProcessIdentity } from '../scripts/runtime-update-helper.mjs';

const helper = fileURLToPath(new URL('../scripts/runtime-update-helper.mjs', import.meta.url));
// Production plans are emitted from canonical Rust paths. GitHub's Windows
// runner exposes TEMP through an 8.3 alias, so canonicalize the fixture parent
// before deriving any path identities that the helper intentionally pins.
const temporaryRoot = fs.realpathSync.native(os.tmpdir());
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const record = (root, relative) => { const bytes = fs.readFileSync(path.join(root, relative)); return { path: relative, bytes: bytes.length, sha256: sha(bytes) }; };
const checked = file => { const bytes = fs.readFileSync(file); return { path: file, bytes: bytes.length, sha256: sha(bytes) }; };
function materialize(root, nodeVersion, label, profile = 'isolatedClient', mode = 'bundled') {
  const node = Buffer.from('fixture Node payload ' + nodeVersion), license = Buffer.from('fixture license');
  const runtime = { version: nodeVersion, executableSha256: sha(node), licenseSha256: sha(license), ...(mode === 'managed' ? { mode } : {}) };
  const pin = { schema: 1, version: nodeVersion, ...(mode === 'managed' ? { mode } : {}), platforms: { 'win-x64': { executableSha256: runtime.executableSha256, licenseSha256: runtime.licenseSha256 } } };
  const files = new Map([[profile === 'portable' ? 'codlet.exe' : 'codlet-lab.exe', Buffer.from(label)], ['runtime/node-runtime.json', Buffer.from(JSON.stringify(pin))], ...(mode === 'bundled' ? [[`runtime/node-v${nodeVersion}-win-x64/node.exe`, node], [`runtime/node-v${nodeVersion}-win-x64/LICENSE`, license]] : [])]);
  fs.mkdirSync(root, { recursive: true });
  for (const [relative, bytes] of files) { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
  return { runtime, files: [...files.keys()].sort().map(name => record(root, name)), node, license };
}
async function fixture(mode = 'success', profile = 'isolatedClient', nextMode = 'bundled', oldMode = 'bundled') {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(temporaryRoot, 'codlet-update-helper-')));
  const state = path.join(root, 'updates'), install = path.join(root, 'installed'), id = 'runtime-install-' + randomUUID(), job = path.join(state, id), staged = path.join(state, 'runtime-payload-' + randomUUID());
  fs.mkdirSync(job, { recursive: true });
  const old = materialize(install, '24.21.0', 'old runtime', profile, oldMode), next = materialize(staged, '25.0.0', 'new runtime', profile, nextMode);
  const binary = profile === 'portable' ? 'codlet.exe' : 'codlet-lab.exe';
  const configPath = path.join(install, 'lab-config.json');
  const originalConfig = Buffer.from(JSON.stringify({ schema: 1, labBinary: binary, labBinarySha256: old.files.find(f => f.path === binary).sha256.toUpperCase(), nodeRelative: 'runtime/node-v24.21.0-win-x64/node.exe', officialCli: 'never-touched', userData: { theme: 'dark', plugins: ['user plugin'] } }, null, 4));
  fs.writeFileSync(configPath, originalConfig);
  fs.mkdirSync(path.join(install, 'plugins')); fs.writeFileSync(path.join(install, 'plugins/user.txt'), 'author files stay unchanged'); fs.writeFileSync(path.join(install, 'auth.json'), 'user authentication stays unchanged');
  const launcher = path.join(job, 'restart-fixture.mjs'), log = path.join(root, 'restarts.jsonl');
  fs.writeFileSync(launcher, `import fs from 'node:fs';import path from 'node:path';const [root,config,log,mode]=process.argv.slice(2);const current=fs.readFileSync(path.join(root,'${binary}'),'utf8');fs.appendFileSync(log,JSON.stringify({current,config:JSON.parse(fs.readFileSync(config,'utf8')),inherited:process.env.CODLET_UPDATE_FIXTURE_INHERITED,override:process.env.CODLET_UPDATE_FIXTURE_OVERRIDE})+'\\n');if(current==='new runtime'&&mode==='fail')process.exitCode=1;if(current==='new runtime'&&mode==='unknown')process.exitCode=42;`);
  const owner = spawn(process.execPath, ['-e', "process.stdin.resume(); process.stdin.on('end',()=>process.exit(0)); setInterval(()=>{},1000);"], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  await new Promise((resolve, reject) => { owner.once('spawn', resolve); owner.once('error', reject); });
  const ownerExited = new Promise(resolve => owner.once('exit', resolve));
  const identity = await captureProcessIdentity(owner.pid); assert.ok(identity);
  const manifest = { schema: 1, kind: 'codlet-runtime-update', version: '9.0.0', platform: 'win-x64', profile, runtime: next.runtime, files: next.files };
  const manifestBytes = Buffer.from(JSON.stringify(manifest)); fs.writeFileSync(path.join(staged, 'runtime-update-manifest.json'), manifestBytes);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(SYSTEMROOT|WINDIR|PATH|TEMP|TMP|SYSTEMDRIVE|COMSPEC)$/i.test(name)));
  // One clock sample: two Date.now() calls can make this exceed the helper's
  // strict 30-minute maximum by a millisecond under concurrent test load.
  const createdAt = Date.now();
  const plan = { schema: 1, kind: 'codlet-runtime-install-plan', id, version: '9.0.0', currentVersion: '0.1.0', platform: 'win-x64', profile, installRoot: install, stateRoot: state, stagedRoot: staged, backupRoot: path.join(job, 'backup'), manifestSha256: sha(manifestBytes), currentFiles: old.files, newFiles: next.files, currentRuntime: old.runtime, newRuntime: next.runtime, helperNode: checked(process.execPath), helperScript: checked(helper), restart: { program: process.execPath, args: [launcher, install, configPath, log, mode], workingDirectory: install, environment, timeoutSeconds: 15 }, restartProgramSha256: checked(process.execPath).sha256, launcherFiles: [checked(launcher), checked(configPath)], configPin: profile === 'isolatedClient' ? { ...checked(configPath), field: 'labBinarySha256', oldValue: JSON.parse(originalConfig).labBinarySha256, newValue: next.files.find(f => f.path === 'codlet-lab.exe').sha256, oldNodeRelative: 'runtime/node-v24.21.0-win-x64/node.exe', newNodeRelative: 'runtime/node-v25.0.0-win-x64/node.exe' } : null, waitFor: [identity], handoffAckPath: path.join(job, 'handoff-ack.json'), installReceiptPath: path.join(job, 'install-receipt.json'), summaryReceiptPath: path.join(state, 'runtime-update-install-receipt.json'), createdAt, expiresAt: createdAt + 30 * 60 * 1000 };
  if (nextMode === 'managed') {
    const cache = path.join(root, 'private-cache'); fs.mkdirSync(cache);
    const node = path.join(cache, 'node.exe'), license = path.join(cache, 'LICENSE');
    fs.writeFileSync(node, next.node); fs.writeFileSync(license, next.license);
    plan.preparedNode = checked(node); plan.preparedLicense = checked(license);
  }
  const planPath = path.join(job, 'install-plan.json'); let planSha;
  function save() { const bytes = Buffer.from(JSON.stringify(plan)); fs.writeFileSync(planPath, bytes); planSha = sha(bytes); return planSha; }
  save();
  function armed(message) { assert.equal(message.event, 'runtime-update-helper-ready'); assert.equal(message.id, id); assert.equal(message.planSha256, planSha); assert.equal(fs.readFileSync(path.join(install, binary), 'utf8'), 'old runtime'); fs.writeFileSync(plan.handoffAckPath, JSON.stringify({ id, planSha256: planSha }), { flag: 'wx' }); owner.stdin.end(); }
  async function cleanup() { owner.stdin.end(); await ownerExited; assert.ok(path.resolve(root).startsWith(path.resolve(temporaryRoot) + path.sep)); fs.rmSync(root, { recursive: true, force: true }); }
  return { root, install, state, job, staged, owner, ownerExited, originalConfig, configPath, binary, plan, planPath, get planSha() { return planSha; }, save, armed, cleanup, log };
}

test('helper waits for checked owner exit, replaces payload, patches only fixed pins and confirms the owner restart', async () => {
  const f = await fixture();
  try {
    const result = await runInstall(f.planPath, f.planSha, f.armed);
    assert.equal(result.phase, 'installed');
    assert.equal(fs.readFileSync(path.join(f.install, 'codlet-lab.exe'), 'utf8'), 'new runtime');
    const config = JSON.parse(fs.readFileSync(f.configPath)); assert.equal(config.labBinarySha256, f.plan.configPin.newValue); assert.equal(config.nodeRelative, f.plan.configPin.newNodeRelative); assert.deepEqual(config.userData, JSON.parse(f.originalConfig).userData); assert.equal(config.officialCli, 'never-touched');
    assert.equal(fs.readFileSync(path.join(f.install, 'plugins/user.txt'), 'utf8'), 'author files stay unchanged'); assert.equal(fs.readFileSync(path.join(f.install, 'auth.json'), 'utf8'), 'user authentication stays unchanged');
    assert.equal(JSON.parse(fs.readFileSync(f.log, 'utf8').trim()).current, 'new runtime');
    assert.equal(JSON.parse(fs.readFileSync(f.plan.summaryReceiptPath)).phase, 'installed');
  } finally { await f.cleanup(); }
});

test('failed owner readiness rolls back exact old payload and original config bytes, then starts the old runtime once', async () => {
  const f = await fixture('fail');
  try {
    await assert.rejects(runInstall(f.planPath, f.planSha, f.armed), error => error.code === 'restart_failed' && error.receipt.phase === 'rolledBack');
    assert.equal(fs.readFileSync(path.join(f.install, 'codlet-lab.exe'), 'utf8'), 'old runtime'); assert.deepEqual(fs.readFileSync(f.configPath), f.originalConfig);
    const restarts = fs.readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse); assert.deepEqual(restarts.map(r => r.current), ['new runtime', 'old runtime']);
    assert.equal(restarts[1].config.nodeRelative, 'runtime/node-v24.21.0-win-x64/node.exe');
    assert.equal(fs.readFileSync(path.join(f.staged, 'codlet-lab.exe'), 'utf8'), 'new runtime');
  } finally { await f.cleanup(); }
});

test('exit 42 retains backups and never starts a second owner when new process retirement is unknown', async () => {
  const f = await fixture('unknown');
  try { const result = await runInstall(f.planPath, f.planSha, f.armed); assert.equal(result.phase, 'rollbackBlocked'); assert.equal(fs.readFileSync(path.join(f.install, 'codlet-lab.exe'), 'utf8'), 'new runtime'); assert.equal(fs.readFileSync(f.log, 'utf8').trim().split('\n').length, 1); assert.equal(fs.readFileSync(path.join(f.plan.backupRoot, 'codlet-lab.exe'), 'utf8'), 'old runtime'); }
  finally { await f.cleanup(); }
});

test('a final receipt write failure after owner restart never rolls back or starts a second owner', async () => {
  for (const mode of ['success', 'unknown']) {
    const f = await fixture(mode), originalRename = fs.renameSync;
    let injected = false;
    fs.renameSync = (from, to) => {
      if (!injected && to === f.plan.installReceiptPath) {
        const next = JSON.parse(fs.readFileSync(from));
        if (next.phase === 'installed' || (next.phase === 'rollbackBlocked' && next.error?.code === 'restart_owner_unknown')) {
          injected = true;
          throw Object.assign(new Error('fixture final receipt write failed'), { code: 'EIO' });
        }
      }
      return originalRename(from, to);
    };
    try {
      await assert.rejects(runInstall(f.planPath, f.planSha, f.armed), error => error.code === 'EIO' && error.receipt.phase === 'rollbackBlocked' && error.receipt.lockRetained === true);
      assert.equal(injected, true);
      assert.equal(fs.readFileSync(path.join(f.install, 'codlet-lab.exe'), 'utf8'), 'new runtime');
      assert.equal(fs.readFileSync(path.join(f.plan.backupRoot, 'codlet-lab.exe'), 'utf8'), 'old runtime');
      assert.equal(fs.readFileSync(f.log, 'utf8').trim().split('\n').length, 1);
      const receipt = JSON.parse(fs.readFileSync(f.plan.installReceiptPath));
      assert.equal(receipt.phase, 'rollbackBlocked');
      assert.equal(receipt.error.code, 'receipt_failed_after_restart');
      assert.equal(fs.existsSync(path.join(f.install, '.codlet-runtime-update.lock.json')), true);
    } finally { fs.renameSync = originalRename; await f.cleanup(); }
  }
});

test('a pinned system PowerShell restart executable may retain its WinSxS hard link', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture();
  try {
    const powershell = path.join(process.env.SYSTEMROOT, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    f.plan.restart.program = powershell;
    f.plan.restart.args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'];
    f.plan.restartProgramSha256 = checked(powershell).sha256;
    f.save();
    const result = await runInstall(f.planPath, f.planSha, f.armed);
    assert.equal(result.phase, 'installed');
    assert.equal(fs.readFileSync(path.join(f.install, 'codlet-lab.exe'), 'utf8'), 'new runtime');
  } finally { await f.cleanup(); }
});

test('restart inherits the original helper environment and applies only explicit owner overrides', async () => {
  const oldInherited = process.env.CODLET_UPDATE_FIXTURE_INHERITED, oldOverride = process.env.CODLET_UPDATE_FIXTURE_OVERRIDE;
  process.env.CODLET_UPDATE_FIXTURE_INHERITED = 'inherited owner environment';
  process.env.CODLET_UPDATE_FIXTURE_OVERRIDE = 'original value';
  const f = await fixture();
  try {
    f.plan.restart.environment = { CODLET_UPDATE_FIXTURE_OVERRIDE: 'explicit owner override' };
    f.save();
    const result = await runInstall(f.planPath, f.planSha, f.armed);
    assert.equal(result.phase, 'installed');
    const observed = JSON.parse(fs.readFileSync(f.log, 'utf8').trim());
    assert.equal(observed.inherited, 'inherited owner environment');
    assert.equal(observed.override, 'explicit owner override');
  } finally {
    await f.cleanup();
    if (oldInherited === undefined) delete process.env.CODLET_UPDATE_FIXTURE_INHERITED; else process.env.CODLET_UPDATE_FIXTURE_INHERITED = oldInherited;
    if (oldOverride === undefined) delete process.env.CODLET_UPDATE_FIXTURE_OVERRIDE; else process.env.CODLET_UPDATE_FIXTURE_OVERRIDE = oldOverride;
  }
});

test('a first replacement failure after owner retirement safely restarts the unchanged old runtime', async () => {
  const f = await fixture(), originalRename = fs.renameSync;
  const source = path.join(f.install, 'codlet-lab.exe'), target = path.join(f.plan.backupRoot, 'codlet-lab.exe');
  fs.renameSync = (from, to) => {
    if (from === source && to === target) throw Object.assign(new Error('fixture first payload rename failed'), { code: 'EXDEV' });
    return originalRename(from, to);
  };
  try {
    await assert.rejects(runInstall(f.planPath, f.planSha, f.armed), error => error.code === 'EXDEV' && error.receipt.phase === 'oldRuntimeRestarted');
    assert.equal(fs.readFileSync(source, 'utf8'), 'old runtime');
    assert.deepEqual(fs.readFileSync(f.configPath), f.originalConfig);
    assert.deepEqual(fs.readFileSync(f.log, 'utf8').trim().split('\n').map(line => JSON.parse(line).current), ['old runtime']);
  } finally { fs.renameSync = originalRename; await f.cleanup(); }
});

test('different registry plans cannot concurrently mutate a shared installation', async () => {
  const first = await fixture(), second = await fixture();
  let readyCount = 0;
  try {
    second.plan.installRoot = first.install;
    second.plan.configPin.path = first.configPath;
    second.plan.restart.workingDirectory = first.install;
    second.plan.restart.args[1] = first.install;
    second.plan.restart.args[2] = first.configPath;
    second.plan.launcherFiles[1].path = first.configPath;
    second.save();
    const firstReady = message => { readyCount++; first.armed(message); };
    const secondReady = message => { readyCount++; second.armed(message); };
    const results = await Promise.allSettled([runInstall(first.planPath, first.planSha, firstReady), runInstall(second.planPath, second.planSha, secondReady)]);
    assert.equal(readyCount, 1);
    assert.equal(results.filter(r => r.status === 'fulfilled' && r.value.phase === 'installed').length, 1);
    assert.equal(results.filter(r => r.status === 'rejected' && ['runtime_update_locked', 'payload_changed'].includes(r.reason.code)).length, 1);
    assert.equal(fs.readFileSync(path.join(first.install, 'codlet-lab.exe'), 'utf8'), 'new runtime');
    assert.equal(fs.existsSync(path.join(first.install, '.codlet-runtime-update.lock.json')), false);
    assert.equal([first.log, second.log].filter(file => fs.existsSync(file)).length, 1);
  } finally { await first.cleanup(); await second.cleanup(); }
});

test('tampered staged bytes and arbitrary non-owned paths fail before helper ready or any installation', async () => {
  for (const mode of ['tamper', 'path', 'pin', 'payload-hardlink']) {
    const f = await fixture(); let ready = false;
    try {
      if (mode === 'tamper') fs.writeFileSync(path.join(f.staged, 'codlet-lab.exe'), 'modified bytes');
      if (mode === 'path') { f.plan.newFiles[0].path = '../auth.json'; f.save(); }
      if (mode === 'pin') { f.plan.configPin.newValue = '0'.repeat(64); f.save(); }
      if (mode === 'payload-hardlink') fs.linkSync(path.join(f.install, 'codlet-lab.exe'), path.join(f.root, 'external-hardlink'));
      await assert.rejects(runInstall(f.planPath, f.planSha, () => { ready = true; })); assert.equal(ready, false); assert.equal(fs.readFileSync(path.join(f.install, 'codlet-lab.exe'), 'utf8'), 'old runtime'); assert.deepEqual(fs.readFileSync(f.configPath), f.originalConfig); assert.equal(fs.existsSync(f.log), false);
    } finally { await f.cleanup(); }
  }
});

test('managed portable update keeps Node in verified cache and removes only old bundled Node after success', async () => {
  const f = await fixture('success', 'portable', 'managed');
  try {
    const custom = path.join(f.install, 'runtime/node-v24.21.0-win-x64/custom.note');
    fs.writeFileSync(custom, 'owner file, not in the runtime manifest');
    const result = await runInstall(f.planPath, f.planSha, f.armed);
    assert.equal(result.phase, 'installed');
    assert.equal(fs.readFileSync(path.join(f.install, f.binary), 'utf8'), 'new runtime');
    assert.equal(fs.existsSync(path.join(f.install, 'runtime/node-v25.0.0-win-x64/node.exe')), false);
    assert.equal(fs.existsSync(path.join(f.install, 'runtime/node-v24.21.0-win-x64/node.exe')), false);
    assert.equal(fs.existsSync(path.join(f.plan.backupRoot, 'runtime/node-v24.21.0-win-x64/node.exe')), false);
    assert.equal(fs.readFileSync(custom, 'utf8'), 'owner file, not in the runtime manifest');
    assert.equal(fs.readFileSync(f.plan.preparedNode.path, 'utf8'), 'fixture Node payload 25.0.0');
    assert.deepEqual(fs.readFileSync(f.configPath), f.originalConfig);
    assert.equal(fs.readFileSync(path.join(f.install, 'plugins/user.txt'), 'utf8'), 'author files stay unchanged');
    assert.equal(fs.readFileSync(path.join(f.install, 'auth.json'), 'utf8'), 'user authentication stays unchanged');
  } finally { await f.cleanup(); }
});

test('managed portable update rolls back old bundled Node when new owner readiness fails', async () => {
  const f = await fixture('fail', 'portable', 'managed');
  try {
    await assert.rejects(runInstall(f.planPath, f.planSha, f.armed), error => error.code === 'restart_failed' && error.receipt.phase === 'rolledBack');
    assert.equal(fs.readFileSync(path.join(f.install, f.binary), 'utf8'), 'old runtime');
    assert.equal(fs.readFileSync(path.join(f.install, 'runtime/node-v24.21.0-win-x64/node.exe'), 'utf8'), 'fixture Node payload 24.21.0');
    assert.deepEqual(fs.readFileSync(f.configPath), f.originalConfig);
    assert.equal(fs.readFileSync(f.plan.preparedNode.path, 'utf8'), 'fixture Node payload 25.0.0');
  } finally { await f.cleanup(); }
});

test('managed cache tampering or missing cache pin blocks handoff before owner exit', async () => {
  for (const change of ['tamper', 'missing', 'wrong-path']) {
    const f = await fixture('success', 'portable', 'managed'); let ready = false;
    try {
      if (change === 'tamper') fs.writeFileSync(f.plan.preparedNode.path, 'modified');
      if (change === 'missing') { delete f.plan.preparedLicense; f.save(); }
      if (change === 'wrong-path') { f.plan.preparedNode.path = path.join(f.install, 'runtime/node-v24.21.0-win-x64/node.exe'); f.save(); }
      await assert.rejects(runInstall(f.planPath, f.planSha, () => { ready = true; }));
      assert.equal(ready, false);
      assert.equal(fs.readFileSync(path.join(f.install, f.binary), 'utf8'), 'old runtime');
      assert.equal(fs.existsSync(f.log), false);
    } finally { await f.cleanup(); }
  }
});

test('managed-to-managed portable update has no install-root Node path dependency', async () => {
  const f = await fixture('success', 'portable', 'managed', 'managed');
  try {
    assert.equal((await runInstall(f.planPath, f.planSha, f.armed)).phase, 'installed');
    assert.equal(fs.readFileSync(path.join(f.install, f.binary), 'utf8'), 'new runtime');
    assert.equal(fs.existsSync(path.join(f.install, 'runtime/node-v24.21.0-win-x64/node.exe')), false);
  } finally { await f.cleanup(); }
});

test('helper binds a Core-verified client Node whose bytes differ from the fallback pin', async () => {
  const f = await fixture('success', 'portable', 'managed');
  try {
    fs.writeFileSync(f.plan.preparedNode.path, 'reviewed client Node fixture');
    fs.writeFileSync(f.plan.preparedLicense.path, 'reviewed client license fixture');
    f.plan.preparedNode = checked(f.plan.preparedNode.path);
    f.plan.preparedLicense = checked(f.plan.preparedLicense.path);
    assert.notEqual(f.plan.preparedNode.sha256, f.plan.newRuntime.executableSha256);
    assert.notEqual(f.plan.preparedLicense.sha256, f.plan.newRuntime.licenseSha256);
    f.save();
    assert.equal((await runInstall(f.planPath, f.planSha, f.armed)).phase, 'installed');
    assert.equal(fs.readFileSync(path.join(f.install, f.binary), 'utf8'), 'new runtime');
  } finally { await f.cleanup(); }
});

test('combined install requires a matching successful official result before replacing any payload or restarting',async()=>{
  for(const kind of ['confirmed','missing','cancelled','wrong-job']) {
    const f=await fixture();
    try {
      f.plan.officialUpdate=true;f.save();
      const start=message=>{if(kind!=='missing')fs.writeFileSync(path.join(f.job,'official-result.json'),JSON.stringify({id:kind==='wrong-job'?'stale':f.plan.id,planSha256:f.planSha,ready:kind!=='cancelled',detail:'Installation cancelled'}));f.armed(message);};
      if(kind==='confirmed'){assert.equal((await runInstall(f.planPath,f.planSha,start)).phase,'installed');assert.equal(fs.readFileSync(path.join(f.install,'codlet-lab.exe'),'utf8'),'new runtime');}
      else {await assert.rejects(runInstall(f.planPath,f.planSha,start),error=>error.code.startsWith('official_update_')&&error.receipt.phase==='failed');assert.equal(fs.readFileSync(path.join(f.install,'codlet-lab.exe'),'utf8'),'old runtime');assert.equal(fs.existsSync(f.log),false);}
    } finally {await f.cleanup();}
  }
});
test('expired, future and overlong plans fail before helper readiness or installation',async()=>{
  for(const mode of ['expired','future','overlong']) {
    const f=await fixture();let ready=false;
    try {
      const now=Date.now();
      if(mode==='expired'){f.plan.createdAt=now-60000;f.plan.expiresAt=now-1;}
      if(mode==='future'){f.plan.createdAt=now+60000;f.plan.expiresAt=now+120000;}
      if(mode==='overlong'){f.plan.createdAt=now;f.plan.expiresAt=now+30*60*1000+1;}
      f.save();await assert.rejects(runInstall(f.planPath,f.planSha,()=>{ready=true;}),{code:'plan_expired'});
      assert.equal(ready,false);assert.equal(fs.readFileSync(path.join(f.install,'codlet-lab.exe'),'utf8'),'old runtime');assert.deepEqual(fs.readFileSync(f.configPath),f.originalConfig);assert.equal(fs.existsSync(f.log),false);
    } finally {await f.cleanup();}
  }
});

test('an unacknowledged ready helper exits without a delayed update even if its original owner closes', async () => {
  const f = await fixture();
  try {
    await assert.rejects(runInstall(f.planPath, f.planSha, () => { f.owner.stdin.end(); }), { code: 'handoff_not_armed' });
    assert.equal(fs.readFileSync(path.join(f.install, 'codlet-lab.exe'), 'utf8'), 'old runtime'); assert.equal(fs.existsSync(f.log), false);
    const receipt = JSON.parse(fs.readFileSync(f.plan.installReceiptPath)); assert.equal(receipt.phase, 'failed'); assert.deepEqual(receipt.movedOld, []); assert.deepEqual(receipt.movedNew, []);
  } finally { await f.cleanup(); }
});
