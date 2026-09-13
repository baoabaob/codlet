import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const windows = process.platform === 'win32';
const powershell = path.join(process.env.SYSTEMROOT ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const fakeCoordinator = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const config = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const directory = path.dirname(process.argv[3]);
fs.appendFileSync(path.join(directory, 'starts.jsonl'), JSON.stringify({ pid: process.pid, action: process.argv[2] }) + '\n');
const ps = path.join(process.env.SYSTEMROOT ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const created = JSON.parse(execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', '(Get-Process -Id ' + process.pid + ').StartTime.ToUniversalTime().ToString("o") | ConvertTo-Json -Compress'], { encoding: 'utf8', windowsHide: true }).trim());
const runId = Date.now() + '-' + process.pid;
const logs = path.join(config.labRoot, 'logs', 'coordinator-' + runId);
fs.mkdirSync(logs, { recursive: true });
const state = { schema: 1, runId, labRoot: config.labRoot, managerPid: process.pid, managerCreated: created, logs, state: 'preparing' };
const publish = value => fs.writeFileSync(path.join(logs, 'state.json'), JSON.stringify(value));
publish(state);
if (config.fixtureMode === 'ready') {
  state.state = 'ready';
  publish(state);
  fs.writeFileSync(path.join(config.labRoot, 'logs/manual-client.json'), JSON.stringify(state));
} else if (config.fixtureMode === 'stale') {
  fs.writeFileSync(path.join(config.labRoot, 'logs/manual-client.json'), JSON.stringify({ ...state, state: 'ready', managerCreated: '2000-01-01T00:00:00.0000000Z' }));
  setTimeout(() => { console.error('Fixture exited without current readiness'); process.exit(9); }, 500);
} else if (['failed', 'failed-clean'].includes(config.fixtureMode)) {
  state.state = 'failed'; state.error = 'Fixture backend startup failed'; publish(state);
  console.error('Fixture backend startup failed: backend-stderr.log');
}
setInterval(() => {
  if (config.fixtureMode === 'failed-clean' && fs.existsSync(path.join(logs, 'quit.request'))) {
    state.hostExit = { code: 0 }; publish(state);
    fs.writeFileSync(path.join(directory, 'fixture-stopped.json'), JSON.stringify({ pid: process.pid }));
    process.exit(0);
  }
  if (fs.existsSync(path.join(directory, 'fixture-stop.request'))) {
    fs.writeFileSync(path.join(directory, 'fixture-stopped.json'), JSON.stringify({ pid: process.pid }));
    process.exit(0);
  }
}, 50);
setTimeout(() => process.exit(0), 90000).unref();
`;

async function fixture(mode) {
    const base = await mkdtemp(path.join(os.tmpdir(), 'codlet-launcher-test-'));
    const directory = path.join(base, 'client with spaces 测试');
    const labRoot = path.join(base, 'owned lab 测试');
    await mkdir(directory); await mkdir(path.join(labRoot, 'logs'), { recursive: true });
    await copyFile(new URL('../scripts/Start-TestClient.ps1', import.meta.url), path.join(directory, 'Start-TestClient.ps1'));
    await copyFile(new URL('../scripts/Start-TestClient.cmd', import.meta.url), path.join(directory, 'Start-TestClient.cmd'));
    await copyFile(new URL('../scripts/Restart-TestClient.ps1', import.meta.url), path.join(directory, 'Restart-TestClient.ps1'));
    await writeFile(path.join(directory, 'isolated-client.mjs'), fakeCoordinator);
    await writeFile(path.join(directory, 'lab-config.json'), JSON.stringify({ schema: 1, labRoot, nodeRelative: path.relative(directory, process.execPath), officialCli: mode === 'missing-cli' ? path.join(base, 'removed-official-cli/codex.exe') : process.execPath, fixtureMode: mode }));
    return {
        directory, labRoot,
        async starts() {
            try { return (await readFile(path.join(directory, 'starts.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
            catch (error) { if (error.code === 'ENOENT') return []; throw error; }
        },
        async cleanup() {
            const starts = await this.starts();
            if (starts.length && mode !== 'stale') {
                await writeFile(path.join(directory, 'fixture-stop.request'), 'stop only the fixture created by this test');
                for (let attempt = 0; attempt < 60; attempt++) {
                    try { await readFile(path.join(directory, 'fixture-stopped.json')); break; }
                    catch (error) { if (error.code !== 'ENOENT') throw error; await delay(50); }
                }
            }
            assert.equal(path.dirname(path.resolve(base)), path.resolve(os.tmpdir()));
            assert.ok(path.basename(base).startsWith('codlet-launcher-test-'));
            await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    };
}

function launch(f, cmd = false, script = 'Start-TestClient.ps1') {
    const child = cmd
        ? spawn(process.env.COMSPEC ?? 'C:/Windows/System32/cmd.exe', ['/d', '/c', '"' + path.join(f.directory, 'Start-TestClient.cmd') + '" -StartupTimeoutSeconds 20'], { windowsHide: true, windowsVerbatimArguments: true, stdio: 'pipe' })
        : spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(f.directory, script), ...(script === 'Start-TestClient.ps1' ? ['-StartupTimeoutSeconds', '20'] : [])], { windowsHide: true, stdio: 'pipe' });
    let stdout = '', stderr = '', ended = false;
    child.stdout.on('data', bytes => { stdout += bytes.toString('utf8'); });
    child.stderr.on('data', bytes => { stderr += bytes.toString('utf8'); });
    const completion = new Promise((resolve, reject) => {
        child.once('error', reject);
        // A detached Windows descendant can retain inherited pipe handles after
        // the foreground launcher exits. Observe that launcher, then close only
        // this test's pipe readers; waiting for pipe EOF would wait for the service.
        child.once('exit', code => {
            ended = true;
            setTimeout(() => {
                child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
                resolve({ code, stdout, stderr });
            }, 50);
        });
    });
    return { child, completion, output: () => stdout + stderr, ended: () => ended };
}

test('missing pinned CLI reports the upgrade problem and the actual cmd pauses only on failure', { skip: !windows, timeout: 15000 }, async () => {
    const f = await fixture('missing-cli');
    try {
        const launched = launch(f, true);
        for (let attempt = 0; attempt < 100 && !launched.output().includes('Review the error and log paths above.'); attempt++) {
            if (launched.ended()) break;
            await delay(50);
        }
        assert.match(launched.output(), /configured official CLI no longer exists/);
        assert.match(launched.output(), /RecoverInterrupted does not approve an upgrade/);
        assert.match(launched.output(), /Review the error and log paths above/);
        assert.equal(launched.ended(), false, 'failed double-click entry should wait for a key');
        launched.child.stdin.end('x\r\n');
        const result = await launched.completion;
        assert.equal(result.code, 1); assert.deepEqual(await f.starts(), []);
        const logs = (await readdir(f.directory)).filter(name => name.endsWith('.stderr.log'));
        assert.equal(logs.length, 1); assert.match(await readFile(path.join(f.directory, logs[0]), 'utf8'), /official CLI no longer exists/);
    } finally { await f.cleanup(); }
});

test('matching ready state exits the real cmd successfully while its newly launched worker keeps running', { skip: !windows, timeout: 15000 }, async () => {
    const f = await fixture('ready');
    try {
        const result = await launch(f, true).completion;
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /Test client is ready/);
        assert.doesNotMatch(result.stdout, /Review the error and log paths above/);
        const starts = await f.starts(); assert.equal(starts.length, 1); assert.equal(starts[0].action, 'start');
        const state = JSON.parse(await readFile(path.join(f.labRoot, 'logs/manual-client.json'), 'utf8'));
        assert.equal(state.managerPid, starts[0].pid);
        assert.doesNotThrow(() => process.kill(starts[0].pid, 0));
    } finally { await f.cleanup(); }
});

test('an old ready record with the new PID but different creation time cannot mask this startup exit', { skip: !windows, timeout: 15000 }, async () => {
    const f = await fixture('stale');
    try {
        const result = await launch(f).completion;
        assert.equal(result.code, 1, result.stdout + result.stderr);
        assert.doesNotMatch(result.stdout, /Test client is ready/);
        assert.match(result.stderr, /manager exited before confirming readiness/);
        assert.match(result.stderr, /Fixture exited without current readiness/);
        assert.equal((await f.starts()).length, 1);
    } finally { await f.cleanup(); }
});

test('early coordinator failure is visible with its owned state and log paths before manual state publication', { skip: !windows, timeout: 15000 }, async () => {
    const f = await fixture('failed');
    try {
        const result = await launch(f).completion;
        assert.equal(result.code, 1, result.stdout + result.stderr);
        assert.match(result.stderr, /Fixture backend startup failed/);
        assert.match(result.stderr, /Coordinator state: .*coordinator-.*state.json/);
        assert.match(result.stderr, /Startup log: .*launch-.*stdout.log/);
        assert.match(result.stderr, /Error log: .*launch-.*stderr.log/);
        assert.equal((await f.starts()).length, 1);
    } finally { await f.cleanup(); }
});

test('startup wait is bounded and leaves the same pending worker intact without retry or recovery', { skip: !windows, timeout: 30000 }, async () => {
    const f = await fixture('timeout');
    try {
        const started = Date.now(); const result = await launch(f).completion;
        assert.equal(result.code, 1, result.stdout + result.stderr);
        assert.ok(Date.now() - started >= 19000); assert.ok(Date.now() - started < 26000);
        assert.match(result.stderr, /result is still unknown/);
        assert.match(result.stderr, /background manager was retained/);
        assert.match(result.stderr, /Do not start another copy/);
        assert.match(result.stderr, /No restart or recovery was attempted/);
        const starts = await f.starts(); assert.equal(starts.length, 1); assert.equal(starts[0].action, 'start');
        assert.doesNotThrow(() => process.kill(starts[0].pid, 0));
    } finally { await f.cleanup(); }
});

test('update restart wrapper returns ready only for its single fresh owner', { skip: !windows, timeout: 20000 }, async () => {
    const f = await fixture('ready');
    try {
        const result = await launch(f, false, 'Restart-TestClient.ps1').completion;
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.equal((await f.starts()).length, 1);
    } finally { await f.cleanup(); }
});

test('update restart wrapper confirms a failed fresh owner stopped through its own quit mailbox', { skip: !windows, timeout: 20000 }, async () => {
    const f = await fixture('failed-clean');
    try {
        const result = await launch(f, false, 'Restart-TestClient.ps1').completion;
        assert.equal(result.code, 1, result.stdout + result.stderr);
        const starts = await f.starts(); assert.equal(starts.length, 1);
        assert.equal(JSON.parse(await readFile(path.join(f.directory, 'fixture-stopped.json'), 'utf8')).pid, starts[0].pid);
        assert.throws(() => process.kill(starts[0].pid, 0), { code: 'ESRCH' });
    } finally { await f.cleanup(); }
});

test('update restart wrapper reports uncertain cleanup without starting a second owner', { skip: !windows, timeout: 20000 }, async () => {
    const f = await fixture('stale');
    try {
        const result = await launch(f, false, 'Restart-TestClient.ps1').completion;
        assert.equal(result.code, 42, result.stdout + result.stderr);
        assert.equal((await f.starts()).length, 1);
    } finally { await f.cleanup(); }
});
