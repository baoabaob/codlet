import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { domFixture } from './support/dom-fixture.mjs';
import { appearance, withUi } from './support/ui-fixture.mjs';

const source = readFileSync(new URL('../bundled/codlet/dist/renderer.js', import.meta.url), 'utf8');
const token = 'codex.ui.titlebar.afterMenu@1';
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
};

const localPreview = () => ({
    schema: 1, kind: 'codlet.local-import-preview', path: 'C:/author 测试/plugin', contentDigest: 'a'.repeat(64), registrationDigest: 'b'.repeat(64),
    ownership: 'development-directory', existingRegistration: null, existingEnabled: true, watchEnabled: false,
    manifest: { schema: 1, id: 'dev.import', name: 'Local Import', version: '1', renderer: { entry: 'renderer.js', world: 'isolated' }, permissions: ['ui.dom'], requires: [], provides: [] }
});

function localManagement(f, plugins = []) {
    f.override('list', () => ({ plugins, localManagement: { available: true, watchEnabled: false, folderPicker: true } }));
}

const githubSource = (tag = 'v2') => ({
    repositoryUrl: 'https://github.com/author/plugin', owner: 'author', repository: 'plugin', releaseId: 20,
    tag, assetId: 30, assetName: 'plugin-win-x64.zip', assetUrl: 'https://github.com/author/plugin/releases/download/v2/plugin-win-x64.zip',
    assetSize: 2048, sha256: 'c'.repeat(64), upstreamDigestVerified: false
});
const githubCatalog = () => ({
    repository: { owner: 'author', name: 'plugin', url: 'https://github.com/author/plugin' },
    releases: [{ id: 20, tag: 'v2', name: 'Version 2', url: 'https://github.com/author/plugin/releases/tag/v2', prerelease: false, publishedAt: null,
        assets: [{ id: 30, name: 'plugin-win-x64.zip', size: 2048, contentType: 'application/zip', downloadUrl: githubSource().assetUrl, digest: null }, { id: 31, name: 'checksums.txt', size: 64 }] }],
    truncated: false, requestedTag: 'v2', requestedAsset: null
});
const managedPreview = (operation = 'install') => ({
    ...localPreview(), kind: 'codlet.managed-preview', ownership: 'core-managed-github', operation, path: 'C:/Codlet/managed/package',
    source: githubSource(), metadata: null, currentVersion: null, history: [], existingEnabled: false,
    changes: { permissionsAdded: ['ui.dom'], permissionsRemoved: [], requirementsAdded: [], requirementsRemoved: [], providesAdded: [], providesRemoved: [] }
});
function githubManagement(f, plugins = []) {
    f.override('list', () => ({ plugins, githubManagement: { available: true }, localManagement: { available: true, folderPicker: true, watchEnabled: false } }));
    f.override('githubReleases', () => ({ jobId: 'catalog-1', kind: 'releases', status: 'completed', result: githubCatalog() }));
    f.override('githubPrepare', () => ({ jobId: 'package-1', kind: 'package', status: 'completed', result: managedPreview() }));
    f.override('cancelGitHubJob', args => ({ jobId: args.jobId, kind: 'package', status: 'cancelled' }));
}
async function chooseGitHubAsset(f) {
    f.control('GitHub release').value = '20'; await f.control('GitHub release').emit('change');
    f.control('GitHub ZIP asset').value = '30'; await f.control('GitHub ZIP asset').emit('change');
}
async function openGitHub(f) {
    await f.plugin.activate(f.context); await f.open(); await f.control('Import from GitHub').emit('click');
    f.control('GitHub repository or release URL').value = 'https://github.com/author/plugin/releases/tag/v2';
    await f.control('Read GitHub releases').emit('click');
}

test('GitHub import requires an exact release and ZIP, fresh trust and grants, then submits one receipt', async () => {
    const f = fixture(); githubManagement(f);
    let operation, request;
    f.override('prepare', args => { request = JSON.parse(JSON.stringify(args)); operation = { operation_id: 'github-import', request }; return { status: 'prepared', operation }; });
    f.override('submit', () => { throw new Error('Lost submit reply'); });
    f.override('operation', args => { assert.equal(args.operationId, 'github-import'); return { status: 'completed', operation: { ...operation, completion: { kind: 'report', report: { outcome: 'applied', desired_enabled: false } } } }; });
    await openGitHub(f);
    assert.equal(f.control('GitHub release').value, '');
    assert.equal(f.control('Download selected GitHub asset').disabled, true);
    assert.equal(f.control('Confirm GitHub import').disabled, true);
    await chooseGitHubAsset(f);
    assert.equal(f.control('GitHub ZIP asset').children.some(option => option.value === '31'), false);
    await f.control('Download selected GitHub asset').emit('click');
    assert.match(f.panel().textContent, /Runtime compatibility: unknown \(not declared\)/);
    assert.match(f.panel().textContent, /Platforms: unknown \(not declared\)/);
    assert.match(f.panel().textContent, /SHA-256: c{64}/);
    assert.equal(f.control('Trust this GitHub source').checked, false);
    assert.equal(f.control('Grant ui.dom').checked, false);
    assert.equal(f.control('Enable after import').checked, false);
    f.control('Trust this GitHub source').checked = true; await f.control('Trust this GitHub source').emit('change');
    assert.equal(f.control('Confirm GitHub import').disabled, true);
    f.control('Grant ui.dom').checked = true; await f.control('Grant ui.dom').emit('change');
    const confirm = f.control('Confirm GitHub import'); await confirm.emit('click'); await confirm.emit('click');
    assert.deepEqual(request, { action: 'import', plugin_id: 'dev.import', local_import: { path: 'C:/Codlet/managed/package', contentDigest: 'a'.repeat(64), registrationDigest: 'b'.repeat(64), trusted: true, grants: ['ui.dom'], brokerPolicy: {}, enable: false, managed: 'install' } });
    assert.equal(f.calls.filter(method => method === 'submit').length, 1);
    assert.equal(f.calls.filter(method => method === 'prepare').length, 1);
    assert.match(f.byClass('codlet-status').textContent, /imported, disabled/);
    f.plugin.deactivate(); assert.equal(f.timerCount(), 0);
});

test('GitHub source and asset edits invalidate candidate trust and ignore old downloads', async () => {
    const f = fixture(); githubManagement(f); await openGitHub(f); await chooseGitHubAsset(f);
    const pending = deferred(); f.override('githubPrepare', () => pending.promise);
    const download = f.control('Download selected GitHub asset').emit('click');
    f.control('GitHub repository or release URL').value = 'https://github.com/new/author';
    await f.control('GitHub repository or release URL').emit('input');
    pending.resolve({ jobId: 'old', kind: 'package', status: 'completed', result: managedPreview() }); await download;
    assert.equal(f.control('Trust this GitHub source'), undefined);
    assert.equal(f.control('Confirm GitHub import').disabled, true);
    assert.equal(f.calls.includes('prepare'), false);
    await f.control('Read GitHub releases').emit('click'); await chooseGitHubAsset(f);
    f.override('githubPrepare', () => ({ jobId: 'new', kind: 'package', status: 'completed', result: managedPreview() }));
    await f.control('Download selected GitHub asset').emit('click');
    f.control('Trust this GitHub source').checked = true; f.control('Grant ui.dom').checked = true;
    await f.control('GitHub ZIP asset').emit('change');
    assert.equal(f.control('Trust this GitHub source'), undefined);
    assert.equal(f.control('Confirm GitHub import').disabled, true);
    f.plugin.deactivate();
});

test('cancelling a background GitHub task ignores a late poll result without registering', async () => {
    const f = fixture(); githubManagement(f); await openGitHub(f); await chooseGitHubAsset(f);
    f.override('githubPrepare', () => ({ jobId: 'cancel-me', kind: 'package', status: 'running', stage: 'download' }));
    const poll = deferred(); f.override('githubJob', args => { assert.equal(args.jobId, 'cancel-me'); return poll.promise; });
    await f.control('Download selected GitHub asset').emit('click');
    await new Promise(resolve => setTimeout(resolve, 330));
    await f.control('Cancel GitHub task').emit('click');
    assert.equal(f.calls.filter(method => method === 'cancelGitHubJob').length, 1);
    poll.resolve({ jobId: 'cancel-me', kind: 'package', status: 'completed', result: managedPreview() });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(f.control('Trust this GitHub source'), undefined);
    assert.equal(f.control('Confirm GitHub import').disabled, true);
    assert.match(f.panel().textContent, /Late results will be ignored/);
    assert.equal(f.calls.includes('prepare'), false); assert.equal(f.timerCount(), 0);
    f.plugin.deactivate();
});

test('a failed GitHub status read checks the same job without repeating download or trusting a mismatched job', async () => {
    const f = fixture(); githubManagement(f); await openGitHub(f); await chooseGitHubAsset(f);
    f.override('githubPrepare', () => ({ jobId: 'read-only', kind: 'package', status: 'running' }));
    f.override('githubJob', () => { throw new Error('Network interrupted'); });
    await f.control('Download selected GitHub asset').emit('click');
    await new Promise(resolve => setTimeout(resolve, 330));
    assert.equal(f.control('Check GitHub task status').hidden, false);
    f.override('githubJob', () => ({ jobId: 'wrong', kind: 'package', status: 'completed', result: managedPreview() }));
    await f.control('Check GitHub task status').emit('click');
    assert.equal(f.control('Confirm GitHub import').disabled, true);
    f.override('githubJob', args => { assert.equal(args.jobId, 'read-only'); return { jobId: 'read-only', kind: 'package', status: 'completed', result: managedPreview() }; });
    await f.control('Check GitHub task status').emit('click');
    assert.equal(f.control('Trust this GitHub source').checked, false);
    assert.equal(f.calls.filter(method => method === 'githubPrepare').length, 1);
    assert.equal(f.calls.includes('prepare'), false);
    f.plugin.deactivate();
});

test('GitHub task failures and missing ZIP assets explain recovery without displaying an install success', async () => {
    const f = fixture(); githubManagement(f);
    f.override('githubReleases', () => ({ jobId: 'failed', kind: 'releases', status: 'failed', error: { code: 'github_rate_limit', message: 'GitHub rate limit reached' } }));
    await openGitHub(f);
    assert.match(f.panel().textContent, /GitHub rate limit reached/);
    assert.equal(f.control('Confirm GitHub import').disabled, true);
    const catalog = githubCatalog(); catalog.releases[0].assets = [];
    f.override('githubReleases', () => ({ jobId: 'empty', kind: 'releases', status: 'completed', result: catalog }));
    await f.control('Read GitHub releases').emit('click');
    f.control('GitHub release').value = '20'; await f.control('GitHub release').emit('change');
    assert.match(f.panel().textContent, /no ZIP assets/);
    assert.equal(f.control('Download selected GitHub asset').disabled, true);
    assert.equal(f.calls.includes('prepare'), false);
    f.plugin.deactivate();
});

test('closing or disposing GitHub work cancels known jobs and rejects late starts and previews', async () => {
    const f = fixture(); githubManagement(f); await openGitHub(f); await chooseGitHubAsset(f);
    f.override('githubPrepare', () => ({ jobId: 'close-me', kind: 'package', status: 'running' }));
    await f.control('Download selected GitHub asset').emit('click');
    await f.close().emit('click');
    assert.equal(f.timerCount(), 0); assert.equal(f.calls.filter(method => method === 'cancelGitHubJob').length, 1);
    await f.open(); await f.control('Import from GitHub').emit('click');
    const late = deferred(); f.override('githubReleases', () => late.promise);
    const start = f.control('Read GitHub releases').emit('click');
    f.plugin.deactivate(); const mutations = f.mutations(), calls = f.calls.length;
    late.resolve({ jobId: 'late', kind: 'releases', status: 'completed', result: githubCatalog() }); await start;
    assert.equal(f.mutations(), mutations); assert.equal(f.calls.length, calls); assert.equal(f.timerCount(), 0);
});

test('managed update and rollback review version permission changes and require new trust with explicit enable state', async () => {
    const f = fixture();
    const plugin = { id: 'dev.import', name: 'Managed Plugin', version: '1', source: 'local', ownership: 'core-managed-github', managedSource: githubSource('v1'), enabled: true, registered: true, active: true, grants: ['ui.dom'], disableDependents: [] };
    const oldVersion = { versionKey: 'old-key', packagePath: 'C:/Codlet/managed/old', contentDigest: 'e'.repeat(64), source: githubSource('v1'), manifest: { ...localPreview().manifest, version: '1' } };
    githubManagement(f, [plugin]);
    f.override('permissions', () => ({ pluginId: plugin.id, registration: { path: 'C:/Codlet/managed/current', grants: ['ui.dom'] }, ownership: 'core-managed-github', managedSource: plugin.managedSource }));
    f.override('managedHistory', () => ({ pluginId: plugin.id, currentVersion: 'new-key', history: [oldVersion] }));
    f.override('githubPrepare', args => {
        assert.deepEqual(JSON.parse(JSON.stringify(args)), { repositoryUrl: 'https://github.com/author/plugin', releaseId: 20, assetId: 30, operation: 'update', pluginId: plugin.id });
        return { jobId: 'update', kind: 'package', status: 'completed', result: { ...managedPreview('update'), manifest: { ...localPreview().manifest, version: '2', permissions: ['ui.dom', 'host.system'] }, currentVersion: oldVersion, existingEnabled: true, metadata: { schema: 1, runtimeApi: 1, platforms: ['windows-x86_64'] }, changes: { permissionsAdded: ['host.system'], permissionsRemoved: [], requirementsAdded: [], requirementsRemoved: [] } } };
    });
    let operation; const requests = [];
    f.override('prepare', args => { requests.push(JSON.parse(JSON.stringify(args))); operation = { operation_id: `managed-${requests.length}`, request: args }; return { status: 'prepared', operation }; });
    f.override('submit', () => { throw new Error('Lost reply'); });
    f.override('operation', () => ({ status: 'completed', operation: { ...operation, completion: { kind: 'report', report: { outcome: 'applied', desired_enabled: operation.request.local_import.enable } } } }));
    await f.plugin.activate(f.context); await f.open(); await f.control('Details for Managed Plugin').emit('click');
    assert.match(f.panel().textContent, /Codlet managed GitHub package/);
    assert.ok(f.control('Review rollback old-key'));
    await f.control('Check GitHub versions').emit('click'); await chooseGitHubAsset(f); await f.control('Download selected GitHub asset').emit('click');
    assert.match(f.panel().textContent, /Version: 1 → 2/);
    assert.match(f.panel().textContent, /Permissions added: host.system/);
    assert.match(f.panel().textContent, /author declared API 1/);
    assert.match(f.panel().textContent, /Runtime declaration: unknown → author declared API 1/);
    assert.match(f.panel().textContent, /Platform declaration: unknown → author declared windows-x86_64/);
    assert.match(f.panel().textContent, /leaves the plugin disabled/);
    assert.equal(f.control('Trust this GitHub source').checked, false); assert.equal(f.control('Enable after import').checked, false);
    for (const label of ['Trust this GitHub source', 'Grant ui.dom', 'Grant host.system']) { f.control(label).checked = true; await f.control(label).emit('change'); }
    await f.control('Confirm managed update').emit('click');
    assert.equal(requests[0].action, 'update'); assert.equal(requests[0].local_import.managed, 'update'); assert.equal(requests[0].local_import.enable, false);
    assert.match(f.byClass('codlet-status').textContent, /updated, disabled/);
    await f.control('Details for Managed Plugin').emit('click');
    f.override('previewRollback', args => { assert.deepEqual(JSON.parse(JSON.stringify(args)), { pluginId: plugin.id, versionKey: 'old-key' }); return { ...managedPreview('rollback'), currentVersion: oldVersion }; });
    await f.control('Review rollback old-key').emit('click');
    assert.equal(f.control('Trust this GitHub source').checked, false); assert.equal(f.control('Confirm managed rollback').disabled, true);
    for (const label of ['Trust this GitHub source', 'Grant ui.dom', 'Enable after import']) { f.control(label).checked = true; await f.control(label).emit('change'); }
    await f.control('Confirm managed rollback').emit('click');
    assert.equal(requests[1].action, 'rollback'); assert.equal(requests[1].local_import.managed, 'rollback'); assert.equal(requests[1].local_import.enable, true);
    assert.equal(f.calls.filter(method => method === 'submit').length, 2);
    assert.match(f.byClass('codlet-status').textContent, /rolled back and enabled/);
    f.plugin.deactivate();
});

test('GitHub preview rejects malformed metadata bindings and unknown permissions before showing grants', async () => {
    for (const change of [{ source: { ...githubSource(), sha256: 'wrong' } }, { source: { ...githubSource(), repositoryUrl: 'https://github.com/other/repository' } }, { source: { ...githubSource(), assetId: 999 } }, { manifest: { ...localPreview().manifest, permissions: ['future.permission'] } }, { operation: 'update' }]) {
        const f = fixture(); githubManagement(f); await openGitHub(f); await chooseGitHubAsset(f);
        f.override('githubPrepare', () => ({ jobId: 'invalid', kind: 'package', status: 'completed', result: { ...managedPreview(), ...change } }));
        await f.control('Download selected GitHub asset').emit('click');
        assert.equal(f.control('Confirm GitHub import').disabled, true); assert.equal(f.control('Trust this GitHub source'), undefined);
        assert.match(f.panel().textContent, /preview is incomplete/); assert.equal(f.calls.includes('prepare'), false);
        f.plugin.deactivate();
    }
});

test('managed update exposes backend identity errors and rejects a different plugin ID without inheriting trust', async () => {
    const f = fixture(), plugin = { id: 'managed.expected', name: 'Expected', ownership: 'core-managed-github', source: 'local', managedSource: githubSource(), registered: true, grants: ['ui.dom'], enabled: true };
    githubManagement(f, [plugin]);
    f.override('permissions', () => ({ pluginId: plugin.id, registration: { path: 'C:/managed/expected', grants: ['ui.dom'] } }));
    f.override('managedHistory', () => ({ pluginId: plugin.id, currentVersion: null, history: [] }));
    await f.plugin.activate(f.context); await f.open(); await f.control('Details for Expected').emit('click');
    await f.control('Check GitHub versions').emit('click'); await chooseGitHubAsset(f);
    f.override('githubPrepare', () => ({ jobId: 'wrong-id', kind: 'package', status: 'failed', error: { code: 'plugin_identity_changed', message: 'The selected release contains a different plugin ID.' } }));
    await f.control('Download selected GitHub asset').emit('click');
    assert.match(f.panel().textContent, /different plugin ID/); assert.equal(f.control('Confirm managed update').disabled, true);
    f.override('githubPrepare', () => ({ jobId: 'wrong-preview', kind: 'package', status: 'completed', result: managedPreview('update') }));
    await f.control('Download selected GitHub asset').emit('click');
    assert.match(f.panel().textContent, /does not match the selected plugin/); assert.equal(f.control('Trust this GitHub source'), undefined);
    assert.equal(f.calls.includes('prepare'), false); assert.equal(f.calls.includes('submit'), false);
    f.plugin.deactivate();
});

function pagedHistoryFixture() {
    const f = fixture();
    const plugin = { id: 'dev.import', name: 'History Plugin', source: 'local', ownership: 'core-managed-github', managedSource: githubSource(), registered: true, grants: [], enabled: false };
    githubManagement(f, [plugin, { ...plugin, id: 'managed.other', name: 'Other History' }]);
    f.override('permissions', args => ({ pluginId: args.pluginId, registration: { path: 'C:/managed/history', grants: [] } }));
    const version = index => ({ versionKey: `version-${index}`, packagePath: `C:/managed/version-${index}`, contentDigest: 'a'.repeat(64), source: githubSource(`v${index}`), manifest: { ...localPreview().manifest, version: String(index) } });
    const page = (history, nextCursor, pluginId = plugin.id) => ({ pluginId, currentVersion: 'version-3', history: history.map(version), nextCursor });
    return { f, plugin, page };
}

test('managed history loads pages explicitly, preserves the current version, and ignores duplicate clicks and entries', async () => {
    const { f, page } = pagedHistoryFixture(); const calls = [];
    const later = deferred();
    f.override('managedHistory', args => { calls.push(JSON.parse(JSON.stringify(args))); return args.cursor ? later.promise : page([3, 2], 2); });
    await f.plugin.activate(f.context); await f.open(); await f.control('Details for History Plugin').emit('click');
    assert.equal(f.control('Review rollback version-3'), undefined);
    assert.ok(f.control('Review rollback version-2')); assert.equal(f.control('Load more versions').hidden, false);
    const more = f.control('Load more versions'), load = more.emit('click'); await more.emit('click');
    assert.equal(more.disabled, true); assert.equal(calls.length, 2);
    later.resolve(page([2, 1], null)); await load;
    assert.deepEqual(calls, [{ pluginId: 'dev.import' }, { pluginId: 'dev.import', cursor: 2 }]);
    assert.equal(f.control('Load more versions').hidden, true); assert.ok(f.control('Review rollback version-1'));
    assert.equal(f.nodes().filter(node => node.getAttribute('aria-label') === 'Review rollback version-2').length, 1);
    assert.match(f.panel().textContent, /3 · v3 · Current/);
    f.plugin.deactivate();
});

test('a failed history page retries the same cursor and rejects invalid cursors without losing loaded rows', async () => {
    const { f, page } = pagedHistoryFixture(); const calls = [];
    f.override('managedHistory', args => { calls.push(args.cursor ?? 0); if (args.cursor) throw new Error('History read failed'); return page([3], 1); });
    await f.plugin.activate(f.context); await f.open(); await f.control('Details for History Plugin').emit('click');
    await f.control('Load more versions').emit('click');
    assert.match(f.panel().textContent, /History read failed/); assert.match(f.panel().textContent, /3 · v3 · Current/);
    f.override('managedHistory', args => { calls.push(args.cursor); return page([2], 1); });
    await f.control('Load more versions').emit('click');
    assert.match(f.panel().textContent, /cursor is invalid/); assert.equal(f.control('Review rollback version-2'), undefined);
    f.override('managedHistory', args => { calls.push(args.cursor); return page([2], null); });
    await f.control('Load more versions').emit('click');
    assert.deepEqual(calls, [0, 1, 1, 1]); assert.ok(f.control('Review rollback version-2'));
    f.plugin.deactivate();
});

test('closing or switching details rejects late history pages and each opening restarts at the first page', async () => {
    const { f, page } = pagedHistoryFixture(); const requests = [];
    const lateClosed = deferred(), lateSwitched = deferred();
    let phase = 'closed';
    f.override('managedHistory', args => {
        requests.push(JSON.parse(JSON.stringify(args)));
        if (args.cursor) return phase === 'closed' ? lateClosed.promise : lateSwitched.promise;
        return page([3], args.pluginId === 'managed.other' ? null : 1, args.pluginId);
    });
    await f.plugin.activate(f.context); await f.open(); await f.control('Details for History Plugin').emit('click');
    const closingLoad = f.control('Load more versions').emit('click'); await f.close().emit('click');
    const mutations = f.mutations(); lateClosed.resolve(page([2], null)); await closingLoad;
    assert.equal(f.mutations(), mutations);
    await f.open(); await f.control('Details for History Plugin').emit('click');
    phase = 'switched'; const switchingLoad = f.control('Load more versions').emit('click');
    const details = f.nodes().find(node => node.className === 'codlet-local-page' && !node.hidden && node.textContent.includes('Loading more retained versions'));
    await details.children.find(node => node.tagName === 'button' && node.getAttribute('aria-label') === 'Back').emit('click');
    await f.control('Details for Other History').emit('click');
    lateSwitched.resolve(page([2], null)); await switchingLoad;
    assert.equal(f.control('Review rollback version-2'), undefined); assert.equal(f.panel().getAttribute('aria-label'), 'Other History');
    assert.deepEqual(requests, [{ pluginId: 'dev.import' }, { pluginId: 'dev.import', cursor: 1 }, { pluginId: 'dev.import' }, { pluginId: 'dev.import', cursor: 1 }, { pluginId: 'managed.other' }]);
    f.plugin.deactivate();
});

test('compact public managed previews work without a full history payload', async () => {
    const f = fixture(); githubManagement(f); await openGitHub(f); await chooseGitHubAsset(f);
    const preview = managedPreview(); delete preview.history; preview.historyCount = 64;
    f.override('githubPrepare', () => ({ jobId: 'compact', kind: 'package', status: 'completed', result: preview }));
    await f.control('Download selected GitHub asset').emit('click');
    assert.equal(f.control('Trust this GitHub source').checked, false);
    assert.equal(f.control('Confirm GitHub import').disabled, true); assert.equal(f.calls.includes('prepare'), false);
    f.plugin.deactivate();
});

test('community discovery is one compact link on import only and never grants trust', async () => {
    const f = fixture(); localManagement(f); await f.plugin.activate(f.context); await f.open();
    const link = f.nodes().find(node => node.tagName === 'a' && node.textContent.includes('Browse community plugins'));
    assert.equal(link.getAttribute('href'), 'https://github.com/topics/codlet-plugin');
    assert.equal(link.getAttribute('target'), '_blank'); assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(f.byClass('codlet-settings-section').contains(link), false);
    await f.control('Import plugins').emit('click');
    assert.equal(f.control('Confirm local import').disabled, true);
    assert.equal(link.children.some(node => node.tagName === 'svg'), true);
    assert.equal(f.calls.includes('prepare'), false); f.plugin.deactivate(); assert.equal(link.isConnected, false);
});

test('local import requires a current preview, explicit trust and every permission, then submits once', async () => {
    const f = fixture(); localManagement(f);
    const preview = localPreview();
    f.override('previewLocal', args => { assert.equal(args.path, 'C:/author input'); return preview; });
    let operation, request;
    f.override('prepare', args => { request = JSON.parse(JSON.stringify(args)); operation = { operation_id: 'import-one', request }; return { status: 'prepared', operation }; });
    f.override('submit', () => { throw new Error('Lost response'); });
    f.override('operation', () => ({ status: 'completed', operation: { ...operation, completion: { kind: 'report', report: { action: 'import', outcome: 'applied', desired_enabled: false } } } }));
    await f.plugin.activate(f.context); await f.open();
    await f.control('Import plugins').emit('click');
    const confirm = f.control('Confirm local import');
    assert.equal(confirm.disabled, true);
    f.control('Plugin folder').value = 'C:/author input';
    await f.control('Plugin folder').emit('input'); await new Promise(resolve => setTimeout(resolve, 430));
    assert.match(f.panel().textContent, /Plugin recognized/);
    assert.doesNotMatch(f.panel().textContent, /Automatic reload:/);
    assert.equal(confirm.disabled, true);
    f.control('Trust this local plugin').checked = true;
    await f.control('Trust this local plugin').emit('change');
    assert.equal(confirm.disabled, true);
    f.control('Grant ui.dom').checked = true;
    await f.control('Grant ui.dom').emit('change');
    assert.equal(confirm.disabled, false);
    await confirm.emit('click'); await confirm.emit('click');
    assert.deepEqual(request, { action: 'import', plugin_id: 'dev.import', local_import: { path: preview.path, contentDigest: preview.contentDigest, registrationDigest: preview.registrationDigest, trusted: true, grants: ['ui.dom'], brokerPolicy: {}, enable: false } });
    assert.equal(f.calls.filter(method => method === 'prepare').length, 1);
    assert.equal(f.calls.filter(method => method === 'submit').length, 1);
    assert.match(f.byClass('codlet-status').textContent, /imported, disabled/);
    f.plugin.deactivate();
});

test('editing the selected path invalidates grants and ignores a late preview', async () => {
    const f = fixture(); localManagement(f);
    const pending = deferred(); f.override('previewLocal', () => pending.promise);
    await f.plugin.activate(f.context); await f.open(); await f.control('Import plugins').emit('click');
    const path = f.control('Plugin folder'); path.value = 'C:/first';
    await path.emit('input'); await new Promise(resolve => setTimeout(resolve, 430));
    path.value = 'C:/second'; await path.emit('input');
    pending.resolve(localPreview()); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(f.control('Grant ui.dom'), undefined);
    assert.equal(f.control('Confirm local import').disabled, true);
    assert.equal(f.calls.includes('prepare'), false);
    f.override('previewLocal', () => localPreview()); await path.emit('input'); await new Promise(resolve => setTimeout(resolve, 430));
    f.control('Grant ui.dom').checked = true; f.control('Trust this local plugin').checked = true;
    await path.emit('input');
    assert.equal(f.control('Grant ui.dom'), undefined);
    assert.equal(f.control('Confirm local import').disabled, true);
    f.plugin.deactivate();
});

test('native folder cancellation and a late result after closing never import or inspect a directory', async () => {
    const f = fixture(); localManagement(f);
    f.override('chooseLocalFolder', () => ({ selectionId: 'folder-1', status: 'cancelled' }));
    await f.plugin.activate(f.context); await f.open(); await f.control('Import plugins').emit('click');
    await f.control('Choose plugin folder').emit('click');
    assert.match(f.panel().textContent, /Folder selection cancelled/);
    assert.equal(f.calls.includes('previewLocal'), false);
    const pending = deferred(); f.override('chooseLocalFolder', () => pending.promise);
    const waiting = f.control('Choose plugin folder').emit('click');
    await f.close().emit('click');
    pending.resolve({ selectionId: 'folder-2', status: 'selected', path: 'C:/late' }); await waiting;
    assert.equal(f.calls.includes('previewLocal'), false);
    assert.equal(f.calls.includes('prepare'), false);
    f.plugin.deactivate();
});

test('a selected native folder is inspected before any grant or mutation', async () => {
    const f = fixture(); localManagement(f);
    f.override('chooseLocalFolder', () => ({ selectionId: 'folder-3', status: 'selected', path: 'C:/chosen' }));
    f.override('previewLocal', args => { assert.equal(args.path, 'C:/chosen'); return localPreview(); });
    await f.plugin.activate(f.context); await f.open(); await f.control('Import plugins').emit('click');
    await f.control('Choose plugin folder').emit('click');
    assert.equal(f.control('Grant ui.dom').checked, false);
    assert.equal(f.control('Trust this local plugin').checked, false);
    assert.equal(f.control('Enable after import').checked, false);
    assert.equal(f.control('Confirm local import').disabled, true);
    assert.equal(f.calls.includes('prepare'), false);
    f.plugin.deactivate();
});

test('permissions are read fresh and revoke requires confirmation before using the common receipt', async () => {
    const f = fixture();
    const plugin = { id: 'dev.local', name: 'Local', source: 'local', enabled: true, registered: true, active: true, grants: ['ui.dom'], disableDependents: [] };
    localManagement(f, [plugin]);
    f.override('permissions', args => { assert.equal(args.pluginId, plugin.id); return { pluginId: plugin.id, registration: { path: 'C:/confirmed folder', grants: ['ui.dom'], brokerPolicy: {} }, enabled: true }; });
    let operation;
    f.override('prepare', request => { assert.deepEqual(JSON.parse(JSON.stringify(request)), { action: 'revoke', plugin_id: plugin.id, permission: 'ui.dom' }); operation = { operation_id: 'revoke-one', request }; return { status: 'prepared', operation }; });
    f.override('submit', () => ({ status: 'queued', operation }));
    f.override('operation', () => ({ status: 'completed', operation: { ...operation, completion: { kind: 'report', report: { outcome: 'applied' } } } }));
    await f.plugin.activate(f.context); await f.open(); await f.control('Details for Local').emit('click');
    assert.doesNotMatch(f.panel().textContent, /C:\/confirmed folder/);
    assert.ok(f.control('Open plugin folder'));
    await f.control('Revoke ui.dom').emit('click');
    assert.match(f.panel().getAttribute('aria-label'), /Revoke permission/);
    assert.equal(f.calls.includes('prepare'), false);
    await f.cancel().emit('click');
    assert.equal(f.panel().getAttribute('data-codlet-view'), 'details');
    await f.control('Revoke ui.dom').emit('click'); await f.confirm().emit('click');
    assert.equal(f.calls.filter(method => method === 'submit').length, 1);
    assert.match(f.byClass('codlet-status').textContent, /permission revoked/);
    f.plugin.deactivate();
});

test('remove explains preserved files and confirms dependent disable as one operation', async () => {
    const f = fixture();
    const plugin = { id: 'dev.local', name: 'Local', source: 'local', enabled: true, registered: true, grants: [], disableDependents: ['dev.consumer'] };
    localManagement(f, [plugin, { id: 'dev.consumer', name: 'Consumer', enabled: true }]);
    f.override('permissions', () => ({ pluginId: plugin.id, registration: { path: 'C:/author files', grants: [] } }));
    let operation;
    f.override('prepare', request => { assert.deepEqual(JSON.parse(JSON.stringify(request)), { action: 'remove', plugin_id: plugin.id, cascade: true }); operation = { operation_id: 'remove-one', request }; return { status: 'prepared', operation }; });
    f.override('submit', () => ({ status: 'queued', operation }));
    f.override('operation', () => ({ status: 'completed', operation: { ...operation, completion: { kind: 'report', report: { outcome: 'applied' } } } }));
    await f.plugin.activate(f.context); await f.open(); await f.control('Details for Local').emit('click');
    await f.control('Remove Local').emit('click');
    assert.match(f.byClass('codlet-confirmation-copy').textContent, /Source files and plugin data are kept by default/);
    assert.match(f.byClass('codlet-confirmation-copy').textContent, /Also disable: Consumer/);
    assert.equal(f.calls.includes('prepare'), false);
    await f.confirm().emit('click');
    assert.equal(f.calls.filter(method => method === 'submit').length, 1);
    assert.match(f.byClass('codlet-status').textContent, /removed; files kept/);
    f.plugin.deactivate();
});

test('a timed-out plugin list shows a retry action and a later refresh can succeed', async () => {
    const f = fixture();
    await f.plugin.activate(f.context);
    f.override('list', () => { throw Object.assign(new Error('RPC deadline'), { code: 'rpc_timeout' }); });
    await f.open();
    assert.equal(f.byClass('codlet-status').textContent, 'Plugin list timed out. Refresh to try again.');
    assert.equal(f.byClass('codlet-plugin-list').getAttribute('aria-busy'), 'false');
    f.override('list', () => ({ plugins: [{ id: 'recovered' }] }));
    await f.refresh().emit('click');
    assert.equal(f.byClass('codlet-plugin-list').hidden, false);
    f.plugin.deactivate();
});

test('localized metadata is searchable by both languages while list hover shows description only', async () => {
    const f = fixture({ locale: 'zh' });
    localManagement(f, [{ id: 'private.id', name: 'Workspace Notes', description: 'Draft notes safely', version: '1.2', source: 'local', path: 'C:/secret/source', enabled: false,
        i18n: { zh: { name: '工作区笔记', description: '记录工作区里的内容' }, en: { name: 'Workspace Notes', description: 'Draft notes safely' } } }, { id: 'other', name: 'Other', enabled: false }]);
    await f.plugin.activate(f.context); await f.open();
    assert.ok(f.control('导入插件')); assert.ok(f.control('搜索插件')); assert.ok(f.control('刷新插件'));
    const list = f.byClass('codlet-plugin-list'); assert.doesNotMatch(list.textContent, /private\.id|C:\/secret/);
    const copy = list.children[0].children[0]; await copy.emit('pointerenter'); await new Promise(resolve => setTimeout(resolve, 310));
    assert.equal(f.byClass('codlet-tooltip').textContent, '记录工作区里的内容'); await copy.emit('pointerleave');
    const search = f.control('搜索插件'); search.value = 'draft workspace'; await search.emit('input');
    assert.equal(list.children.length, 1); assert.match(list.textContent, /工作区笔记/);
    search.value = 'private.id'; await search.emit('input'); assert.equal(list.children.length, 1);
    f.setLocale('en'); assert.equal(search.value, 'private.id'); assert.ok(f.control('Details for Workspace Notes'));
    search.value = '工作区 内容'; await search.emit('input'); assert.equal(list.children.length, 1);
    f.setLocale('ja'); assert.ok(f.control('Search plugins')); assert.equal(f.control('导入插件'), undefined);
    f.plugin.deactivate(); assert.equal(f.languageListenerCount(), 0);
});

test('language changes preserve an import preview, text input, trust and grants and translate native folder selection', async () => {
    const f = fixture({ locale: 'zh' }); localManagement(f);
    f.override('chooseLocalFolder', args => { assert.deepEqual(JSON.parse(JSON.stringify(args)), { locale: 'zh' }); return { selectionId: 'localized', status: 'selected', path: 'C:/插件目录' }; });
    f.override('previewLocal', () => ({ ...localPreview(), manifest: { ...localPreview().manifest, i18n: { zh: { name: '本地工具' }, en: { name: 'Local tools' } } } }));
    await f.plugin.activate(f.context); await f.open(); await f.control('导入插件').emit('click');
    await f.control('选择插件文件夹').emit('click');
    const field = f.control('插件文件夹'), trust = f.control('信任这个本地插件'), grant = f.control('授予 ui.dom');
    trust.checked = true; await trust.emit('change'); grant.checked = true; await grant.emit('change');
    assert.equal(f.control('确认导入本地插件').disabled, false);
    assert.match(f.panel().textContent, /本地工具|读取和修改页面界面/);
    f.setLocale('en');
    assert.equal(f.control('Plugin folder'), field); assert.equal(field.value, 'C:/插件目录');
    assert.equal(f.control('Trust this local plugin'), trust); assert.equal(trust.checked, true); assert.equal(grant.checked, true);
    assert.equal(f.control('Confirm local import').disabled, false);
    assert.match(f.panel().textContent, /Local tools/); assert.equal(f.calls.filter(method => method === 'previewLocal').length, 1);
    assert.equal(f.calls.includes('prepare'), false); f.plugin.deactivate();
});

test('automatic local preview debounces paths, keeps typing focus and cancels before leaving import', async () => {
    const f = fixture(); localManagement(f); const paths = [];
    f.override('previewLocal', args => { paths.push(args.path); return localPreview(); });
    await f.plugin.activate(f.context); await f.open(); await f.control('Import plugins').emit('click');
    assert.equal(f.nodes().some(node => node.tagName === 'button' && node.textContent === 'Inspect folder'), false);
    const field = f.control('Plugin folder'); field.focus();
    field.value = 'relative'; await field.emit('input'); assert.equal(f.timerCount(), 0);
    field.value = 'C:/first'; await field.emit('input');
    field.value = 'C:/second'; await field.emit('input');
    assert.equal(paths.length, 0); await new Promise(resolve => setTimeout(resolve, 440));
    assert.deepEqual(paths, ['C:/second']); assert.equal(f.document.activeElement, field);
    field.value = 'C:/late'; await field.emit('input'); await f.close().emit('click');
    assert.equal(f.timerCount(), 0); await new Promise(resolve => setTimeout(resolve, 430));
    assert.deepEqual(paths, ['C:/second']); f.plugin.deactivate();
});

test('invalid local paths use localized guidance and preserve the backend error in collapsed details', async () => {
    const f = fixture({ locale: 'zh' }); localManagement(f);
    const original = 'local_import_error: Failed to read C:/missing/codlet.json (os error 3)';
    f.override('previewLocal', () => { throw Object.assign(new Error(original), { code: 'local_import_error' }); });
    await f.plugin.activate(f.context); await f.open(); await f.control('导入插件').emit('click');
    const field = f.control('插件文件夹'); field.value = 'relative'; await field.emit('input');
    assert.match(f.byClass('codlet-import-error').parentElement.textContent, /请输入插件文件夹的完整路径/);
    assert.equal(f.calls.includes('previewLocal'), false);
    field.value = 'C:/missing'; await field.emit('input'); await new Promise(resolve => setTimeout(resolve, 430));
    const details = f.byClass('codlet-import-error');
    assert.equal(details.hidden, false); assert.equal(details.open, false);
    assert.equal(details.children[0].textContent, '错误详情'); assert.equal(details.children[1].textContent, original);
    assert.match(details.parentElement.textContent, /无法识别此文件夹中的插件，请检查路径和 codlet\.json/);
    assert.equal(f.control('确认导入本地插件').disabled, true);
    f.setLocale('en'); assert.equal(details.children[0].textContent, 'Error details'); assert.equal(details.children[1].textContent, original);
    field.value = ''; await field.emit('input'); assert.equal(details.hidden, true); assert.equal(details.children[1].textContent, '');
    f.plugin.deactivate(); assert.equal(f.timerCount(), 0);
});

test('list entry focuses search without refresh stealing focus and source tabs support keyboard navigation', async () => {
    const f = fixture();
    f.override('list', () => ({ plugins: [], localManagement: { available: true, folderPicker: true }, githubManagement: { available: true } }));
    f.override('previewLocal', () => localPreview());
    f.override('chooseLocalFolder', () => ({ selectionId: 'tabs-folder', status: 'selected', path: 'C:/chosen' }));
    await f.plugin.activate(f.context); await f.open();
    const search = f.control('Search plugins'); assert.equal(f.document.activeElement, search);
    f.refresh().focus(); await f.refresh().emit('click'); assert.equal(f.document.activeElement, f.refresh());
    await f.control('Import plugins').emit('click'); await f.control('Choose plugin folder').emit('click');
    const trust = f.control('Trust this local plugin'); trust.checked = true; await trust.emit('change');
    const local = f.control('Local folder'), github = f.control('Import from GitHub');
    await local.emit('click'); assert.equal(f.control('Trust this local plugin'), trust); assert.equal(trust.checked, true);
    local.focus(); const right = await local.emit('keydown', { key: 'ArrowRight' });
    assert.equal(right.defaultPrevented, true); assert.equal(f.document.activeElement, github);
    assert.equal(github.getAttribute('aria-selected'), 'true'); assert.equal(github.tabIndex, 0); assert.equal(local.tabIndex, -1);
    await github.emit('keydown', { key: 'Home' }); assert.equal(f.document.activeElement, local);
    assert.equal(local.getAttribute('aria-selected'), 'true'); assert.equal(f.control('Plugin folder').value, 'C:/chosen');
    await new Promise(resolve => setTimeout(resolve, 430));
    assert.equal(f.control('Trust this local plugin').checked, false); assert.equal(f.document.activeElement, local);
    const back = f.nodes().find(node => node.getAttribute('aria-label') === 'Back' && !node.parentElement.hidden);
    await back.emit('click'); assert.equal(f.document.activeElement, search);
    assert.equal(f.calls.includes('prepare'), false); f.plugin.deactivate(); assert.equal(f.timerCount(), 0);
});

test('details show only granted permissions and open the registered folder by plugin ID', async () => {
    const f = fixture(); localManagement(f, [{ id: 'folder.plugin', name: 'Folder plugin', source: 'local', enabled: false, registered: true }]);
    f.override('permissions', () => ({ pluginId: 'folder.plugin', registration: { path: 'C:/author/secret-folder', grants: [], brokerPolicy: {} } }));
    f.override('openFolder', args => { assert.deepEqual(JSON.parse(JSON.stringify(args)), { pluginId: 'folder.plugin' }); return { pluginId: 'folder.plugin', opened: true }; });
    await f.plugin.activate(f.context); await f.open(); await f.control('Details for Folder plugin').emit('click');
    const details = f.nodes().find(node => node.className === 'codlet-local-page' && !node.hidden);
    assert.match(details.textContent, /folder.plugin/);
    assert.doesNotMatch(details.textContent, /secret-folder|No permissions|None|Removing the plugin keeps/);
    await f.control('Open plugin folder').emit('click'); assert.equal(f.calls.filter(method => method === 'openFolder').length, 1);
    f.plugin.deactivate();
});

test('source deletion is unchecked until explicitly selected and shares the original remove receipt', async () => {
    const f = fixture(); localManagement(f, [{ id: 'remove.plugin', name: 'Remove plugin', source: 'local', enabled: false, registered: true }]);
    f.override('permissions', () => ({ pluginId: 'remove.plugin', registration: { path: 'C:/owned/source', grants: [] } }));
    f.override('sourceRemovalPreview', args => { assert.equal(args.pluginId, 'remove.plugin'); return { pluginId: 'remove.plugin', status: 'available', path: 'C:/owned/source', registrationDigest: 'a'.repeat(64), sourceIdentity: 'identity-token' }; });
    let operation, request;
    f.override('prepare', args => { request = JSON.parse(JSON.stringify(args)); operation = { operation_id: 'remove-source', request }; return { status: 'prepared', operation }; });
    f.override('submit', () => { throw new Error('Lost response'); });
    f.override('operation', () => ({ status: 'completed', operation: { ...operation, completion: { kind: 'report', report: { outcome: 'applied', message: 'Source folder deleted.' } } } }));
    await f.plugin.activate(f.context); await f.open(); await f.control('Details for Remove plugin').emit('click'); await f.control('Remove Remove plugin').emit('click');
    const choice = f.control('Delete source files'); assert.equal(choice.checked, false); assert.equal(choice.disabled, false);
    assert.equal(f.calls.includes('prepare'), false); choice.checked = true; await choice.emit('change');
    await f.confirm().emit('click');
    assert.deepEqual(request, { action: 'remove', plugin_id: 'remove.plugin', remove_source: { registrationDigest: 'a'.repeat(64), sourceIdentity: 'identity-token' } });
    assert.equal(f.calls.filter(method => method === 'submit').length, 1); assert.match(f.byClass('codlet-status').textContent, /Source folder deleted/);
    assert.doesNotMatch(f.byClass('codlet-status').textContent, /files kept/); f.plugin.deactivate();
});

test('missing source remains removable without deletion and cancelled source previews cannot re-enable deletion', async () => {
    const f = fixture(); localManagement(f, [{ id: 'missing', name: 'Missing', source: 'local', registered: true }]);
    f.override('permissions', () => ({ pluginId: 'missing', registration: { path: 'C:/missing', grants: [] } }));
    const pending = deferred(); f.override('sourceRemovalPreview', () => pending.promise);
    await f.plugin.activate(f.context); await f.open(); await f.control('Details for Missing').emit('click');
    const opening = f.control('Remove Missing').emit('click'); assert.equal(f.confirm().disabled, true); await f.cancel().emit('click');
    pending.resolve({ pluginId: 'missing', status: 'available', path: 'C:/old', registrationDigest: 'a'.repeat(64), sourceIdentity: 'old' }); await opening;
    assert.equal(f.panel().getAttribute('data-codlet-view'), 'details'); assert.equal(f.control('Delete source files').parentElement.hidden, true);
    f.override('sourceRemovalPreview', () => ({ pluginId: 'missing', status: 'missing', path: 'C:/missing', sourceIdentity: null }));
    await f.control('Remove Missing').emit('click');
    assert.equal(f.control('Delete source files').disabled, true); assert.equal(f.confirm().disabled, false); assert.match(f.byClass('codlet-confirmation-copy').textContent, /missing or moved/);
    f.plugin.deactivate();
});

const runtimeUpdate = phase => ({ currentVersion: '0.1.0', phase, configured: phase !== 'development', channel: 'stable', lastCheckedAt: null, nextCheckAt: null,
    candidate: { id: 'release', version: '0.2.0', platform: 'win-x64', size: 100, sha256: 'a'.repeat(64), releaseUrl: null }, downloadedBytes: 50, totalBytes: 100, installAvailable: true, unavailableReason: null, error: null });

test('unconfigured development hides update actions while the client compatibility line follows verified status', async () => {
    const f = fixture({ locale: 'zh' });
    f.override('list', () => ({ plugins: [], runtimeVersion: '0.1.0', clientStatus: { status: 'unmatched', officialUpdateAvailable: true } }));
    f.override('runtimeUpdateStatus', args => { assert.deepEqual(JSON.parse(JSON.stringify(args)), {}); return runtimeUpdate('development'); });
    await f.plugin.activate(f.context); await f.open();
    assert.equal(f.control('检查更新').hidden, true); assert.match(f.panel().textContent, /开发版/);
    assert.equal(f.byClass('codlet-panel-title').textContent, 'Codlet');
    assert.match(f.byClass('codlet-client-status').textContent, /官方客户端可更新/);
    assert.match(f.byClass('codlet-client-status').textContent, /当前Codlet未匹配客户端最新版本/);
    assert.equal(f.calls.includes('checkRuntimeUpdate'), false); assert.equal(f.calls.includes('downloadRuntimeUpdate'), false);
    f.plugin.deactivate(); assert.equal(f.timerCount(), 0);
});

test('update header downloads once, displays progress, and installs only after its separate explicit click', async () => {
    const f = fixture(); let phase = 'available';
    f.override('list', () => ({ plugins: [], runtimeVersion: '0.1.0' }));
    f.override('runtimeUpdateStatus', () => runtimeUpdate(phase));
    const pending = deferred(); f.override('downloadRuntimeUpdate', args => { assert.deepEqual(JSON.parse(JSON.stringify(args)), {}); return pending.promise; });
    f.override('installRuntimeUpdate', () => runtimeUpdate('installRequested'));
    await f.plugin.activate(f.context); await f.open();
    const download = f.control('Download update'); assert.equal(download.hidden, false);
    const downloading = download.emit('click'); await download.emit('click');
    assert.equal(f.calls.filter(method => method === 'downloadRuntimeUpdate').length, 1);
    phase = 'downloading'; pending.resolve(runtimeUpdate(phase)); await downloading;
    assert.equal(f.control('Downloading update: 50%').disabled, true); assert.equal(f.calls.includes('installRuntimeUpdate'), false);
    phase = 'downloaded'; await f.refresh().emit('click');
    assert.ok(f.control('Install and restart')); await f.control('Install and restart').emit('click');
    assert.match(f.panel().getAttribute('aria-label'), /Install and restart Codlet/);
    assert.match(f.byClass('codlet-confirmation-copy').textContent, /running local tasks will be interrupted/);
    assert.equal(f.calls.includes('installRuntimeUpdate'), false); await f.cancel().emit('click');
    assert.equal(f.calls.includes('installRuntimeUpdate'), false);
    await f.control('Install and restart').emit('click'); const confirm = f.confirm(); await confirm.emit('click'); await confirm.emit('click');
    assert.equal(f.calls.filter(method => method === 'installRuntimeUpdate').length, 1);
    f.plugin.deactivate(); assert.equal(f.timerCount(), 0);
});

function fixture({ mounted = true, ready = true, locale = 'en' } = {}) {
    const dom = domFixture({ mounted, ready });
    const { scope, document, body, mount, toolbar, editor, window, descendants, observers, modalDialogs, timers, closeEvents } = dom;
    vm.runInNewContext(source, scope, { filename: 'codlet-renderer.js' });
    const plugin = scope.module.exports;
    let active = false;
    const overrides = {};
    const calls = [];
    const languageListeners = new Set();
    const context = {
        pluginId: 'codlet-gui', generation: 1,
        i18n: {
            get locale() { return locale; },
            t(messages, key, values = {}) { return (messages[locale]?.[key] ?? messages.en?.[key] ?? key).replace(/\{(\w+)\}/g, (token, name) => Object.hasOwn(values, name) ? String(values[name]) : token); },
            onChange(callback) { languageListeners.add(callback); return () => languageListeners.delete(callback); }
        },
        rpc: { async request(capability, method, args) {
            const name = method === 'ping' ? 'codlet.runtime.ping'
                : method === 'getMount' ? 'codex.ui.titlebar.afterMenu' : method === 'describe' ? 'codex.ui.appearance' : 'codlet.runtime.manage';
            assert.deepEqual(JSON.parse(JSON.stringify(capability)), { name, api: 1, scope: 'target' });
            if (['ping', 'getMount', 'describe', 'list', 'disableSelf'].includes(method)) assert.equal(args, null);
            calls.push(method);
            if (overrides[method]) return overrides[method](args);
            if (method === 'ping') return { pong: true, abi: 1 };
            if (method === 'getMount') return { available: mount.isConnected, token };
            if (method === 'describe') return appearance;
            if (method === 'list') return { plugins: [
                { id: 'codlet-gui', name: 'Codlet GUI', version: '1', source: 'bundled', enabled: true, active, validation: { status: 'ok' } },
                { id: 'dev.broken', version: null, source: 'local', path: 'C:/fixture/missing', enabled: false, active: false,
                    validation: { status: 'failed', error: { message: 'Missing renderer entry' } } }
            ] };
            if (method === 'disableSelf') {
                plugin.deactivate();
                return { pluginId: 'codlet-gui', enabled: false };
            }
            throw new Error('Unexpected method');
        } }
    };
    withUi(scope, context);
    const nodes = () => descendants(document.documentElement);
    const byClass = className => nodes().find(element => element.className === className);
    const control = label => nodes().find(element => element.getAttribute('aria-label') === label);
    return {
        plugin, context, calls, document, mount, toolbar, editor, window,
        nodes, byClass, control,
        button: () => nodes().find(element => element.attributes.has('data-codlet-titlebar-button')),
        panel: () => nodes().find(element => element.attributes.has('data-codlet-panel')),
        refresh: () => control('Refresh plugins'),
        close: () => control('Close Codlet'),
        toggle: () => control('Enable Codlet GUI'),
        confirm: () => byClass('codlet-confirm'),
        cancel: () => nodes().find(element => element.tagName === 'button' && element.textContent === 'Cancel'),
        setActive(value) { active = value; },
        setLocale(value) { locale = /^zh(?:-|$)/i.test(value) ? 'zh' : 'en'; for (const callback of languageListeners) callback(locale); },
        languageListenerCount: () => languageListeners.size,
        override(method, handler) { overrides[method] = handler; },
        mutations: dom.mutations,
        layoutReads: dom.layoutReads,
        observerCount: () => observers.size,
        modalCount: () => modalDialogs.size,
        timerCount: () => timers.size,
        async flushCloseEvents() { for (const notify of closeEvents.splice(0)) await notify(); },
        flushObserver() { for (const observer of observers) observer.callback(); },
        async ready() { document.body = body; await document.emit('DOMContentLoaded'); },
        async open() { this.button().focus(); await this.button().emit('click'); },
        async requestDisable() { this.toggle().focus(); this.toggle().checked = false; await this.toggle().emit('change'); }
    };
}

test('activation mounts before list; opening uses the current Host Active snapshot', async () => {
    const f = fixture();
    await f.plugin.activate(f.context);
    assert.deepEqual(f.calls, ['ping', 'getMount', 'describe']);
    assert.equal(f.toggle(), undefined);
    await f.open();
    assert.match(f.panel().textContent, /Not active/);
    assert.equal(f.toggle().checked, true);
    assert.ok(f.control('Start Codlet GUI'));
    await f.close().emit('click');
    f.setActive(true);
    await f.open();
    assert.ok(f.toggle());
    const selfRow = f.byClass('codlet-plugin-list').children[0];
    assert.equal(selfRow.children[1].className, 'codlet-plugin-actions');
    assert.equal(selfRow.children[1].children.find(node => node.className === 'codlet-plugin-state').textContent, 'Active');
    assert.doesNotMatch(f.panel().textContent, /undefined|null|Runtime connected/);
    assert.match(f.panel().textContent, /Missing renderer entry/);
    assert.equal(f.panel().getAttribute('role'), 'dialog');
    assert.equal(f.panel().tagName, 'dialog');
    assert.equal(f.panel().getAttribute('aria-modal'), 'true');
    assert.equal(f.panel().open, true);
    assert.equal(f.modalCount(), 1);
    assert.equal(f.panel().getAttribute('data-codlet-ui-theme'), appearance.themeToken);
    assert.equal(f.panel().getAttribute('data-codlet-generation'), '1');
    assert.equal(f.button().getAttribute('aria-controls'), f.panel().id);
    assert.equal(f.button().getAttribute('aria-haspopup'), 'dialog');
    assert.equal(f.button().getAttribute('aria-expanded'), 'true');
    f.plugin.deactivate();
});

test('GUI self reload submits once and tolerates retiring before the submit reply', async () => {
    const f = fixture();
    const operation = { operation_id: 'fixture-self-reload', request: { action: 'reload', plugin_id: 'codlet-gui' } };
    f.override('prepare', args => {
        assert.deepEqual(JSON.parse(JSON.stringify(args)), operation.request);
        return { status: 'prepared', operation };
    });
    f.override('submit', args => {
        assert.equal(args.operationId, operation.operation_id);
        f.plugin.deactivate();
        return { status: 'queued', operation };
    });
    await f.plugin.activate(f.context);
    f.setActive(true);
    await f.open();
    await f.control('Reload Codlet GUI').emit('click');
    assert.equal(f.panel(), undefined);
    assert.equal(f.calls.filter(method => method === 'prepare').length, 1);
    assert.equal(f.calls.filter(method => method === 'submit').length, 1);
    assert.equal(f.calls.includes('operation'), false);
    assert.equal(f.calls.includes('disableSelf'), false);
    await f.plugin.activate({ ...f.context, generation: 2 });
    await f.open();
    assert.equal(f.control('Reload Codlet GUI').disabled, false);
    f.plugin.deactivate();
});

test('refresh keeps populated rows visible and only replaces changed plugins', async () => {
    const f = fixture();
    let plugins = [
        { id: 'codlet-gui', name: 'Codlet GUI', enabled: true, active: true },
        { id: 'dev.worker', name: 'Usage Banner Hider', enabled: false, active: false }
    ];
    f.override('list', () => ({ plugins }));
    await f.plugin.activate(f.context);
    await f.open();
    const list = f.byClass('codlet-plugin-list');
    const selfRow = list.children[0];
    const toggle = f.toggle();
    toggle.focus();
    const waiting = deferred();
    f.override('list', () => waiting.promise);
    const refresh = f.refresh().emit('click');
    assert.equal(list.hidden, false);
    assert.equal(list.getAttribute('aria-busy'), 'true');
    assert.equal(list.children[0], selfRow);
    assert.equal(toggle.disabled, true);
    plugins = [plugins[0], { ...plugins[1], enabled: true, active: true }];
    waiting.resolve({ plugins });
    await refresh;
    assert.equal(list.children[0], selfRow);
    assert.equal(f.toggle(), toggle);
    assert.equal(f.document.activeElement, toggle);
    assert.equal(f.control('Enable Usage Banner Hider').checked, true);
    assert.equal(list.getAttribute('aria-busy'), 'false');
    assert.equal(toggle.disabled, false);
    f.override('list', () => { throw new Error('temporary failure'); });
    await f.refresh().emit('click');
    assert.equal(list.hidden, false);
    assert.equal(list.children[0], selfRow);
    assert.equal(toggle.disabled, false);
    assert.match(f.byClass('codlet-status').textContent, /temporary failure/);
    f.plugin.deactivate();
});

test('the first list failure leaves an entry and recovers through the visible refresh control', async () => {
    const f = fixture();
    const pending = deferred();
    f.override('list', () => pending.promise);
    await f.plugin.activate(f.context);
    const opening = f.open();
    assert.equal(f.panel().hidden, false);
    assert.match(f.byClass('codlet-status').textContent, /Loading plugins/);
    assert.equal(f.byClass('codlet-plugin-list').getAttribute('aria-busy'), 'true');
    pending.reject(new Error('List failed'));
    await opening;
    assert.ok(f.button());
    assert.equal(f.byClass('codlet-status').textContent, 'List failed');
    assert.equal(f.byClass('codlet-plugin-list').getAttribute('aria-busy'), 'false');
    f.override('list', undefined);
    f.setActive(true);
    await f.refresh().emit('click');
    assert.ok(f.toggle());
    assert.equal(f.byClass('codlet-status').hidden, true);
    f.plugin.deactivate();
});

test('empty and malformed lists report honest recoverable states', async () => {
    const f = fixture();
    await f.plugin.activate(f.context);
    for (const invalid of [null, {}, { plugins: null }, { plugins: [null] }, { plugins: [{ id: '' }] }]) {
        f.override('list', () => invalid);
        await f.open();
        assert.equal(f.byClass('codlet-status').textContent, 'Plugin list unavailable');
        assert.equal(f.byClass('codlet-plugin-list').hidden, true);
        await f.close().emit('click');
    }
    f.override('list', () => ({ plugins: [] }));
    await f.open();
    assert.equal(f.byClass('codlet-status').textContent, 'No plugins');
    assert.equal(f.byClass('codlet-plugin-list').hidden, false);
    f.plugin.deactivate();
});

test('refresh removes forgotten rows and distinguishes an unregistered loaded plugin', async () => {
    const f = fixture();
    let rows = [
        { id: 'codlet-gui', enabled: true, active: true, source: 'bundled' },
        { id: 'dev.removed', enabled: false, active: false, source: 'local' }
    ];
    f.override('list', () => ({ plugins: rows }));
    await f.plugin.activate(f.context);
    await f.open();
    assert.match(f.panel().textContent, /codlet-gui/);
    assert.match(f.panel().textContent, /dev\.removed/);
    rows = [rows[0],
        { id: 'dev.still-running', enabled: false, active: true, loaded: true, registered: false,
            source: 'local', loadedPath: 'C:/fixture/loaded', validation: { status: 'ok' } },
        { id: 'dev.new', enabled: true, active: false, loaded: false, registered: true,
            source: 'local', validation: { status: 'not_loaded' } }
    ];
    await f.refresh().emit('click');
    assert.doesNotMatch(f.panel().textContent, /dev\.removed/);
    assert.match(f.panel().textContent, /dev\.still-running/);
    assert.match(f.panel().textContent, /Registration removed; still loaded/);
    assert.match(f.panel().textContent, /Registered, not loaded/);
    assert.doesNotMatch(f.panel().textContent, /Plugin validation failed/);
    const unregisteredRow = f.nodes().find(element => element.className === 'codlet-plugin-row' && element.textContent.includes('dev.still-running'));
    assert.equal(unregisteredRow.children[0].title, undefined);
    await f.requestDisable();
    assert.match(f.panel().textContent, /from the launcher/);
    f.plugin.deactivate();
});

test('host execution observations retain lifecycle facts alongside public management controls', async () => {
    const f = fixture();
    const rows = [
        { id: 'codlet-gui', enabled: true, active: true, source: 'bundled' },
        { id: 'dev.starting', enabled: true, active: false, execution: { kind: 'host', state: 'starting', processId: 41, error: null } },
        { id: 'dev.stopping', enabled: false, active: false, loaded: true, registered: false,
            execution: { kind: 'host', state: 'stopping', processId: 45, error: 'Stopping after worker failure' } },
        { id: 'dev.running', enabled: false, active: true, loaded: true, registered: false,
            execution: { kind: 'host', state: 'active', processId: 42, error: null } },
        { id: 'dev.combined-waiting', enabled: true, active: false,
            execution: { kind: 'host', state: 'active', rendererActive: false, processId: 46, error: null } },
        { id: 'dev.combined-active', enabled: true, active: true,
            execution: { kind: 'host', state: 'active', rendererActive: true, processId: 47, error: null } },
        { id: 'dev.failed', enabled: true, active: false, loaded: false,
            validation: { status: 'failed', error: { message: 'Older catalog problem' } },
            execution: { kind: 'host', state: 'failed', processId: 43, error: 'Worker exited with code 12' } },
        { id: 'dev.exited', enabled: true, active: false, loaded: false,
            execution: { kind: 'host', state: 'exited', processId: 44, error: null } },
        { id: 'dev.renderer', enabled: false, active: false,
            validation: { status: 'failed', error: { message: 'Missing renderer entry' } } }
    ];
    f.override('list', () => ({ plugins: rows }));
    await f.plugin.activate(f.context);
    await f.open();
    const pluginRow = id => f.nodes().find(element => element.className === 'codlet-plugin-row'
        && element.children[0].textContent.includes(id));
    for (const [id, state] of [['dev.starting', 'Starting'], ['dev.stopping', 'Stopping'], ['dev.running', 'Active'], ['dev.combined-waiting', 'Waiting for renderer'], ['dev.combined-active', 'Active'], ['dev.failed', 'Failed'], ['dev.exited', 'Exited'], ['dev.renderer', 'Unavailable']]) {
        assert.equal(f.nodes().find(element => element.className === 'codlet-plugin-state' && pluginRow(id).contains(element)).textContent, state);
        assert.ok(pluginRow(id).children.some(element => element.className === 'codlet-plugin-actions'));
    }
    assert.match(pluginRow('dev.running').textContent, /Registration removed; still loaded/);
    assert.match(pluginRow('dev.stopping').textContent, /Registration removed; still loaded/);
    assert.match(pluginRow('dev.stopping').textContent, /Stopping after worker failure/);
    assert.match(pluginRow('dev.failed').textContent, /Worker exited with code 12/);
    assert.doesNotMatch(pluginRow('dev.failed').textContent, /Older catalog problem/);
    assert.match(pluginRow('dev.renderer').textContent, /Missing renderer entry/);
    assert.ok(f.toggle());
    assert.deepEqual(f.calls, ['ping', 'getMount', 'describe', 'list']);
    f.plugin.deactivate();
});

test('overlapping refreshes commit only the latest response without moving focus', async () => {
    const f = fixture();
    await f.plugin.activate(f.context);
    const old = deferred();
    f.override('list', () => old.promise);
    const opening = f.open();
    f.override('list', () => ({ plugins: [{ id: 'latest', active: true }] }));
    await f.refresh().emit('click');
    f.refresh().focus();
    const mutations = f.mutations();
    old.resolve({ plugins: [{ id: 'obsolete' }] });
    await opening;
    assert.equal(f.mutations(), mutations);
    assert.match(f.panel().textContent, /latest/);
    assert.doesNotMatch(f.panel().textContent, /obsolete/);
    assert.equal(f.document.activeElement, f.refresh());
    f.plugin.deactivate();
});

test('closing and reopening invalidates both old list successes and failures', async () => {
    for (const fails of [false, true]) {
        const f = fixture();
        await f.plugin.activate(f.context);
        const old = deferred();
        f.override('list', () => old.promise);
        const opening = f.open();
        await f.close().emit('click');
        assert.equal(f.panel().hidden, true);
        f.override('list', () => ({ plugins: [{ id: 'reopened' }] }));
        await f.open();
        const mutations = f.mutations();
        if (fails) old.reject(new Error('Obsolete failure'));
        else old.resolve({ plugins: [] });
        await opening;
        assert.equal(f.mutations(), mutations);
        assert.equal(f.panel().hidden, false);
        assert.match(f.panel().textContent, /reopened/);
        f.plugin.deactivate();
    }
});

test('unload and reactivation reject list callbacks from the old lifecycle', async () => {
    const f = fixture();
    await f.plugin.activate(f.context);
    const old = deferred();
    f.override('list', () => old.promise);
    const opening = f.open();
    f.plugin.deactivate();
    f.override('list', undefined);
    await f.plugin.activate({ ...f.context, generation: 2 });
    await f.open();
    const mutations = f.mutations();
    old.resolve({ plugins: [{ id: 'obsolete' }] });
    await opening;
    assert.equal(f.mutations(), mutations);
    assert.equal(f.panel().getAttribute('data-codlet-generation'), '2');
    assert.doesNotMatch(f.panel().textContent, /obsolete/);
    f.plugin.deactivate();
});

test('unload during startup cancels stale ping and getMount continuations', async () => {
    for (const method of ['ping', 'getMount']) {
        const f = fixture();
        const waiting = deferred();
        const entered = deferred();
        f.override(method, () => { entered.resolve(); return waiting.promise; });
        const activation = f.plugin.activate(f.context);
        await entered.promise;
        f.plugin.deactivate();
        const mutations = f.mutations();
        waiting.resolve(method === 'ping' ? { pong: true, abi: 1 } : { available: true, token });
        await activation;
        assert.equal(f.mutations(), mutations);
        assert.equal(f.panel(), undefined);
        assert.equal(f.observerCount(), 0);
        assert.equal(f.document.listenerCount(), 0);
        assert.equal(f.window.listenerCount(), 0);
    }
});

test('unload cancels the DOMContentLoaded wait without leaving a listener', async () => {
    const f = fixture({ ready: false });
    const activation = f.plugin.activate(f.context);
    assert.equal(f.document.listenerCount(), 1);
    f.plugin.deactivate();
    await activation;
    assert.equal(f.document.listenerCount(), 0);
    assert.deepEqual(f.calls, []);
    await f.ready();
    assert.equal(f.panel(), undefined);
});

test('mount negotiation rejects an unknown token without guessing another mount', async () => {
    const f = fixture();
    f.override('getMount', () => ({ available: true, token: 'unknown@1' }));
    await f.plugin.activate(f.context);
    assert.equal(f.button(), undefined);
    assert.equal(f.panel(), undefined);
    assert.equal(f.observerCount(), 0);
    assert.equal(f.document.listenerCount(), 0);
    assert.equal(f.calls.includes('describe'), false);
});

test('available:false with a valid token waits for a late mount without polling', async () => {
    const f = fixture({ mounted: false });
    await f.plugin.activate(f.context);
    assert.ok(f.panel());
    assert.equal(f.panel().hidden, true);
    assert.equal(f.button(), undefined);
    assert.equal(f.observerCount(), 1);
    f.toolbar.appendChild(f.mount);
    f.flushObserver();
    assert.equal(f.button().parentElement, f.mount);
    await f.open();
    assert.equal(f.panel().style.top, '36px');
    assert.equal(f.calls.filter(method => method === 'getMount').length, 1);
    f.plugin.deactivate();
    f.flushObserver();
    assert.equal(f.button(), undefined);
});

test('a connected stale mount is replaced, and reparenting the same mount relayouts the open panel', async () => {
    const f = fixture();
    f.toolbar.bottom = 84;
    await f.plugin.activate(f.context);
    await f.open();
    const button = f.button();
    const search = f.control('Search plugins');
    assert.equal(f.panel().style.top, '84px');
    const menuLine = f.document.body.appendChild(f.document.createElement('div'));
    menuLine.bottom = 36;
    menuLine.appendChild(f.mount);
    f.flushObserver();
    assert.equal(f.panel().style.top, '36px');
    assert.equal(f.panel().hidden, false);
    assert.equal(f.document.activeElement, search);
    const reads = f.layoutReads();
    f.document.body.appendChild(f.document.createElement('div'));
    f.flushObserver();
    assert.equal(f.layoutReads(), reads, 'unrelated host DOM updates do not force layout');
    f.mount.removeAttribute('data-codlet-capability');
    const replacement = menuLine.appendChild(f.document.createElement('div'));
    replacement.setAttribute('data-codlet-capability', token);
    f.flushObserver();
    assert.equal(f.mount.isConnected, true);
    assert.equal(f.button(), button);
    assert.equal(button.parentElement, replacement);
    assert.equal(f.document.activeElement, search);
    f.plugin.deactivate();
});

test('mount removal closes the panel, restores external focus, and can recover later', async () => {
    const f = fixture();
    await f.plugin.activate(f.context);
    await f.open();
    const button = f.button();
    f.mount.remove();
    f.flushObserver();
    assert.equal(f.panel().hidden, true);
    assert.equal(f.document.activeElement, f.editor);
    f.toolbar.appendChild(f.mount);
    f.flushObserver();
    assert.equal(f.button(), button);
    await f.open();
    assert.equal(f.panel().hidden, false);
    f.plugin.deactivate();
});

test('Escape is consumed locally before an earlier host document handler, restoring opener focus', async () => {
    const f = fixture();
    let hostEscapes = 0;
    f.document.addEventListener('keydown', event => { if (event.key === 'Escape') hostEscapes++; });
    await f.plugin.activate(f.context);
    await f.open();
    assert.equal(f.document.activeElement, f.control('Search plugins'));
    const event = await f.control('Search plugins').emit('keydown', { key: 'Escape' });
    assert.equal(event.defaultPrevented, true);
    assert.equal(hostEscapes, 0);
    assert.equal(f.panel().hidden, true);
    assert.equal(f.document.activeElement, f.button());
    assert.equal(f.button().getAttribute('aria-expanded'), 'false');
    await f.open();
    f.editor.focus();
    const external = await f.editor.emit('keydown', { key: 'Escape' });
    assert.equal(external.defaultPrevented, false);
    assert.equal(hostEscapes, 1);
    assert.equal(f.panel().hidden, false);
    f.plugin.deactivate();
});

test('handled, modified, composing and unrelated keys remain available to the host', async () => {
    const f = fixture();
    let hostKeys = 0;
    f.document.addEventListener('keydown', () => hostKeys++);
    await f.plugin.activate(f.context);
    await f.open();
    for (const options of [
        { key: 'Escape', defaultPrevented: true }, { key: 'Escape', isComposing: true },
        { key: 'Escape', ctrlKey: true }, { key: 'Escape', metaKey: true },
        { key: 'Escape', altKey: true }, { key: 'Escape', shiftKey: true },
        { key: 'Tab' }, { key: 'Tab', shiftKey: true }, { key: 'k', ctrlKey: true }
    ]) {
        const event = await f.close().emit('keydown', options);
        assert.equal(event.stopped, false);
        assert.equal(f.panel().hidden, false);
    }
    assert.equal(hostKeys, 9);
    f.plugin.deactivate();
});

test('close restores a surviving opener; removal falls back to the entry', async () => {
    const f = fixture();
    await f.plugin.activate(f.context);
    await f.button().emit('click');
    await f.close().emit('click');
    assert.equal(f.document.activeElement, f.editor);
    await f.button().emit('click');
    f.editor.remove();
    await f.close().emit('click');
    assert.equal(f.document.activeElement, f.button());
    f.plugin.deactivate();
});

test('closing or unloading preserves a newer host modal and its focus', async () => {
    const f = fixture();
    await f.plugin.activate(f.context);
    await f.open();
    const hostModal = f.document.body.appendChild(f.document.createElement('dialog'));
    const hostInput = hostModal.appendChild(f.document.createElement('input'));
    hostModal.showModal();
    hostInput.focus();
    await f.close().emit('click');
    assert.equal(f.document.activeElement, hostInput);
    assert.equal(hostModal.open, true);
    hostModal.close();
    await f.open();
    hostModal.showModal();
    hostInput.focus();
    f.plugin.deactivate();
    assert.equal(f.document.activeElement, hostInput);
    assert.equal(hostModal.open, true);
    assert.equal(f.observerCount(), 0);
    assert.equal(f.document.listenerCount(), 0);
    assert.equal(f.window.listenerCount(), 0);
    hostModal.close();
});

test('inline disable confirmation preserves enabled state, and Escape first cancels only confirmation', async () => {
    const f = fixture();
    await f.plugin.activate(f.context);
    f.setActive(true);
    await f.open();
    const toggle = f.toggle();
    await f.requestDisable();
    assert.equal(toggle.checked, true);
    assert.equal(f.document.activeElement, f.cancel());
    assert.equal(f.byClass('codlet-confirmation').hidden, false);
    assert.equal(f.calls.includes('disableSelf'), false);
    await f.cancel().emit('keydown', { key: 'Escape' });
    assert.equal(f.panel().hidden, false);
    assert.equal(f.byClass('codlet-confirmation').hidden, true);
    assert.equal(toggle.disabled, false);
    assert.equal(f.document.activeElement, toggle);
    await f.requestDisable();
    await f.cancel().emit('click');
    assert.equal(f.calls.includes('disableSelf'), false);
    assert.equal(f.document.activeElement, toggle);
    f.plugin.deactivate();
    assert.equal(f.document.activeElement, f.editor);
});

test('disable is sent once while pending, shows failure, and supports explicit retry', async () => {
    const f = fixture();
    await f.plugin.activate(f.context);
    f.setActive(true);
    await f.open();
    await f.requestDisable();
    const pending = deferred();
    f.override('disableSelf', () => pending.promise);
    f.confirm().focus();
    const disabling = f.confirm().emit('click');
    assert.equal(f.confirm().disabled, true);
    assert.equal(f.cancel().disabled, true);
    assert.equal(f.refresh().disabled, true);
    assert.equal(f.document.activeElement, f.close());
    await f.confirm().emit('click');
    await f.refresh().emit('click');
    assert.equal(f.calls.filter(method => method === 'disableSelf').length, 1);
    assert.equal(f.calls.filter(method => method === 'list').length, 1);
    pending.reject(new Error('Registry write failed'));
    await disabling;
    assert.match(f.byClass('codlet-confirmation').textContent, /Registry write failed/);
    assert.equal(f.confirm().disabled, false);
    assert.equal(f.toggle().checked, true);
    f.override('disableSelf', undefined);
    f.confirm().focus();
    await f.confirm().emit('click');
    assert.equal(f.calls.filter(method => method === 'disableSelf').length, 2);
    assert.equal(f.panel(), undefined);
    assert.equal(f.document.activeElement, f.editor);
});

test('a disable error arriving while closed is saved for reopen without touching hidden DOM', async () => {
    const f = fixture();
    await f.plugin.activate(f.context);
    f.setActive(true);
    await f.open();
    await f.requestDisable();
    const pending = deferred();
    f.override('disableSelf', () => pending.promise);
    const disabling = f.confirm().emit('click');
    await f.close().emit('click');
    const mutations = f.mutations();
    pending.reject(new Error('Write failed while closed'));
    await disabling;
    assert.equal(f.mutations(), mutations);
    await f.open();
    assert.match(f.byClass('codlet-confirmation').textContent, /Write failed while closed/);
    assert.equal(f.calls.filter(method => method === 'disableSelf').length, 1);
    assert.equal(f.calls.filter(method => method === 'list').length, 1);
    f.plugin.deactivate();
});

test('old disable responses cannot mutate or poison a reactivated GUI', async () => {
    for (const fails of [true, false]) {
        const f = fixture();
        await f.plugin.activate(f.context);
        f.setActive(true);
        await f.open();
        await f.requestDisable();
        const pending = deferred();
        f.override('disableSelf', () => pending.promise);
        const disabling = f.confirm().emit('click');
        f.plugin.deactivate();
        await f.plugin.activate({ ...f.context, generation: 2 });
        await f.open();
        const mutations = f.mutations();
        if (fails) pending.reject(new Error('Old disable failure'));
        else pending.resolve({ pluginId: 'codlet-gui', enabled: false });
        await disabling;
        assert.equal(f.mutations(), mutations);
        assert.equal(f.byClass('codlet-confirmation').hidden, true);
        assert.equal(f.refresh().disabled, false);
        assert.equal(f.toggle().disabled, false);
        f.plugin.deactivate();
    }
});

test('an unconfirmed disable response is not displayed as success', async () => {
    const f = fixture();
    await f.plugin.activate(f.context);
    f.setActive(true);
    await f.open();
    await f.requestDisable();
    f.override('disableSelf', () => ({ enabled: true }));
    await f.confirm().emit('click');
    assert.match(f.byClass('codlet-confirmation').textContent, /Disable was not confirmed/);
    assert.equal(f.confirm().disabled, false);
    f.plugin.deactivate();
});

test('native modal lifecycle releases its top layer on close and on pending-request unload', async () => {
    const f = fixture();
    await f.plugin.activate(f.context);
    assert.equal(f.panel().open, false);
    assert.equal(f.panel().hidden, true);
    await f.open();
    f.editor.focus();
    assert.equal(f.document.activeElement, f.control('Search plugins'), 'the browser modal keeps the host inert');
    await f.close().emit('click');
    assert.equal(f.modalCount(), 0);
    assert.equal(f.panel().open, false);
    assert.equal(f.panel().hidden, true);
    assert.equal(f.document.activeElement, f.button());
    const pending = deferred();
    f.override('list', () => pending.promise);
    const opening = f.open();
    const oldPanel = f.panel();
    assert.equal(f.modalCount(), 1);
    f.plugin.deactivate();
    assert.equal(f.modalCount(), 0);
    assert.equal(oldPanel.open, false);
    assert.equal(oldPanel.hidden, true);
    assert.equal(f.document.activeElement, f.editor);
    const mutations = f.mutations();
    pending.resolve({ plugins: [] });
    await opening;
    await f.flushCloseEvents();
    assert.equal(f.mutations(), mutations);
});

test('showModal failure and a detached dialog do not publish expanded state or issue list requests', async () => {
    const f = fixture();
    await f.plugin.activate(f.context);
    const panel = f.panel();
    panel.showModalError = 'Modal opening failed';
    await f.open();
    assert.equal(f.modalCount(), 0);
    assert.equal(panel.open, false);
    assert.equal(panel.hidden, true);
    assert.equal(f.button().getAttribute('aria-expanded'), 'false');
    assert.match(f.button().title, /Modal opening failed/);
    assert.equal(f.document.activeElement, f.button());
    assert.equal(f.calls.includes('list'), false);
    panel.showModalError = null;
    panel.remove();
    await f.open();
    assert.equal(panel.open, false);
    assert.equal(panel.hidden, true);
    assert.equal(f.modalCount(), 0);
    assert.equal(f.calls.includes('list'), false);
    f.document.body.appendChild(panel);
    await f.open();
    assert.equal(panel.open, true);
    assert.equal(panel.hidden, false);
    assert.equal(f.button().title, 'Codlet');
    assert.equal(f.calls.filter(method => method === 'list').length, 1);
    f.plugin.deactivate();
});

test('late native close events cannot close a reopened dialog or write into a new generation', async () => {
    const f = fixture();
    await f.plugin.activate(f.context);
    await f.open();
    await f.close().emit('click');
    await f.open();
    const beforeReopenEvent = f.mutations();
    await f.flushCloseEvents();
    assert.equal(f.mutations(), beforeReopenEvent);
    assert.equal(f.panel().open, true);
    assert.equal(f.panel().hidden, false);
    f.plugin.deactivate();
    await f.plugin.activate({ ...f.context, generation: 2 });
    await f.open();
    const beforeOldEvent = f.mutations();
    await f.flushCloseEvents();
    assert.equal(f.mutations(), beforeOldEvent);
    assert.equal(f.panel().getAttribute('data-codlet-generation'), '2');
    assert.equal(f.modalCount(), 1);
    f.plugin.deactivate();
});

test('native close before its close event rejects list responses and synchronizes the entry', async () => {
    const f = fixture();
    await f.plugin.activate(f.context);
    const pending = deferred();
    f.override('list', () => pending.promise);
    const opening = f.open();
    f.panel().close();
    const mutations = f.mutations();
    pending.resolve({ plugins: [{ id: 'too late' }] });
    await opening;
    assert.equal(f.mutations(), mutations);
    await f.flushCloseEvents();
    assert.equal(f.panel().hidden, true);
    assert.equal(f.button().getAttribute('aria-expanded'), 'false');
    assert.equal(f.modalCount(), 0);
    f.plugin.deactivate();
});

test('native cancel returns confirmation to settings, then closes the settings modal', async () => {
    const f = fixture();
    await f.plugin.activate(f.context);
    f.setActive(true);
    await f.open();
    await f.requestDisable();
    assert.equal(f.byClass('codlet-settings-section').hidden, true);
    assert.equal(f.panel().getAttribute('aria-label'), 'Disable Codlet GUI?');
    assert.ok(f.panel().getAttribute('aria-describedby'));
    const cancelled = await f.panel().emit('cancel');
    assert.equal(cancelled.defaultPrevented, true);
    assert.equal(f.panel().open, true);
    assert.equal(f.byClass('codlet-settings-section').hidden, false);
    assert.equal(f.panel().getAttribute('aria-label'), 'Codlet');
    assert.equal(f.panel().getAttribute('aria-describedby'), null);
    assert.equal(f.document.activeElement, f.toggle());
    await f.panel().emit('cancel');
    assert.equal(f.panel().open, false);
    assert.equal(f.panel().hidden, true);
    assert.equal(f.calls.includes('disableSelf'), false);
    f.plugin.deactivate();
});

test('public management controls enable reload and disable through one receipt per action', async () => {
    const f = fixture();
    let enabled = false;
    let serial = 0;
    let operation;
    const submissions = [];
    f.override('list', () => ({ plugins: [{ id: 'dev.worker', enabled, active: enabled, registered: true, loaded: enabled, generation: enabled ? 1 : null }] }));
    f.override('prepare', args => {
        operation = { operation_id: 'fixture-' + ++serial, request: JSON.parse(JSON.stringify(args)), completion: null };
        return { status: 'prepared', operation };
    });
    f.override('submit', args => {
        submissions.push(args.operationId);
        return { status: 'queued', operation };
    });
    f.override('operation', args => {
        assert.equal(args.operationId, operation.operation_id);
        enabled = operation.request.action !== 'disable';
        return { status: 'completed', operation: { ...operation, completion: { kind: 'report', report: { outcome: 'applied' } } } };
    });
    await f.plugin.activate(f.context);
    await f.open();
    let toggle = f.control('Enable dev.worker');
    toggle.checked = true;
    await toggle.emit('change');
    assert.equal(operation.request.action, 'enable');
    assert.equal(f.control('Enable dev.worker').checked, true);
    await f.control('Reload dev.worker').emit('click');
    assert.equal(operation.request.action, 'reload');
    toggle = f.control('Enable dev.worker');
    toggle.checked = false;
    await toggle.emit('change');
    assert.equal(operation.request.action, 'disable');
    assert.equal(f.control('Enable dev.worker').checked, false);
    assert.deepEqual(submissions, ['fixture-1', 'fixture-2', 'fixture-3']);
    assert.equal(f.calls.filter(method => method === 'prepare').length, 3);
    assert.equal(f.calls.filter(method => method === 'submit').length, 3);
    assert.equal(f.calls.filter(method => method === 'operation').length, 3);
    assert.match(f.byClass('codlet-status').textContent, /disabled/);
    f.plugin.deactivate();
    assert.equal(f.timerCount(), 0);
});

test('dependency disable requires confirmation and submits the whole closure once before GUI removal', async () => {
    const f = fixture();
    f.override('list', () => ({ plugins: [
        { id: 'codex.ui.adapter', name: 'Codex UI Adapter', enabled: true, active: true, loaded: true, disableDependents: ['codlet-gui'] },
        { id: 'codlet-gui', name: 'Codlet GUI', enabled: true, active: true, disableDependents: [] },
        { id: 'dev.hider', name: 'Usage Banner Hider', enabled: true, active: true, disableDependents: [] },
        { id: 'dev.legacy', enabled: false, active: false }
    ] }));
    let operation;
    f.override('prepare', args => {
        assert.deepEqual(JSON.parse(JSON.stringify(args)), { action: 'disable', plugin_id: 'codex.ui.adapter', cascade: true });
        operation = { operation_id: 'cascade-1', request: args };
        return { status: 'prepared', operation };
    });
    f.override('submit', () => { f.plugin.deactivate(); throw new Error('GUI retired before the reply arrived'); });
    await f.plugin.activate(f.context);
    await f.open();
    assert.deepEqual(f.nodes().filter(node => node.className === 'codlet-plugin-name').map(node => node.textContent), ['Codex UI Adapter', 'Codlet GUI', 'Usage Banner Hider', 'dev.legacy']);
    const toggle = f.control('Enable Codex UI Adapter');
    toggle.checked = false;
    await toggle.emit('change');
    assert.equal(f.panel().getAttribute('aria-label'), 'Disable Codex UI Adapter?');
    assert.match(f.byClass('codlet-confirmation-copy').textContent, /also disable: Codlet GUI/);
    assert.match(f.byClass('codlet-confirmation-copy').textContent, /close in all open windows/);
    assert.equal(f.calls.includes('prepare'), false);
    await f.cancel().emit('click');
    assert.equal(toggle.checked, true);
    assert.equal(f.calls.includes('prepare'), false);
    toggle.checked = false;
    await toggle.emit('change');
    await f.byClass('codlet-confirm').emit('click');
    assert.equal(f.calls.filter(method => method === 'prepare').length, 1);
    assert.equal(f.calls.filter(method => method === 'submit').length, 1);
    assert.equal(operation.request.action, 'disable');
    assert.equal(f.panel(), undefined);
    assert.equal(f.timerCount(), 0);
});

test('refresh uses a nonempty owned tooltip and cancels it on leave close and unload', async () => {
    const f = fixture();
    await f.plugin.activate(f.context);
    await f.open();
    const refresh = f.refresh();
    assert.equal(refresh.title, undefined);
    await refresh.emit('pointerenter');
    await new Promise(resolve => setTimeout(resolve, 310));
    assert.equal(f.byClass('codlet-tooltip').textContent, 'Refresh plugins');
    assert.equal(f.byClass('codlet-tooltip').getAttribute('role'), 'tooltip');
    await refresh.emit('pointerleave');
    assert.equal(f.byClass('codlet-tooltip'), undefined);
    await refresh.emit('pointerenter');
    await f.close().emit('click');
    assert.equal(f.timerCount(), 0);
    await f.open();
    await f.refresh().emit('pointerenter');
    f.plugin.deactivate();
    assert.equal(f.timerCount(), 0);
    await new Promise(resolve => setTimeout(resolve, 310));
    assert.equal(f.byClass('codlet-tooltip'), undefined);
});

test('a lost submit reply keeps its receipt and refresh only checks the original action', async () => {
    const f = fixture();
    const operation = { operation_id: 'fixture-lost', request: { action: 'enable', plugin_id: 'dev.worker' } };
    f.override('list', () => ({ plugins: [{ id: 'dev.worker', enabled: false, active: false }] }));
    f.override('prepare', () => ({ status: 'prepared', operation }));
    f.override('submit', () => { throw Object.assign(new Error('lost submit reply'), { code: 'rpc_timeout' }); });
    f.override('operation', () => { throw new Error('temporary read failure'); });
    await f.plugin.activate(f.context);
    await f.open();
    const toggle = f.control('Enable dev.worker');
    toggle.checked = true;
    await toggle.emit('change');
    assert.equal(f.control('Enable dev.worker').disabled, true);
    assert.match(f.byClass('codlet-status').textContent, /Refresh to check again/);
    await toggle.emit('change');
    f.override('operation', args => {
        assert.equal(args.operationId, operation.operation_id);
        return { status: 'completed', operation: { ...operation, completion: { kind: 'report', report: { outcome: 'applied' } } } };
    });
    await f.refresh().emit('click');
    assert.equal(f.calls.filter(method => method === 'prepare').length, 1);
    assert.equal(f.calls.filter(method => method === 'submit').length, 1);
    assert.equal(f.calls.filter(method => method === 'operation').length, 2);
    assert.equal(f.control('Enable dev.worker').disabled, false);
    f.plugin.deactivate();
});

test('closing pauses receipt polling and unload ignores a late management reply', async () => {
    const f = fixture();
    const operation = { operation_id: 'fixture-running', request: { action: 'enable', plugin_id: 'dev.worker' } };
    f.override('list', () => ({ plugins: [{ id: 'dev.worker', enabled: false }] }));
    f.override('prepare', () => ({ status: 'prepared', operation }));
    f.override('submit', () => ({ status: 'queued', operation }));
    f.override('operation', () => ({ status: 'running', operation }));
    await f.plugin.activate(f.context);
    await f.open();
    const toggle = f.control('Enable dev.worker');
    toggle.checked = true;
    await toggle.emit('change');
    assert.equal(f.timerCount(), 1);
    await f.close().emit('click');
    assert.equal(f.timerCount(), 0);
    const waiting = deferred();
    f.override('operation', () => waiting.promise);
    const opening = f.open();
    f.plugin.deactivate();
    const mutations = f.mutations();
    const calls = f.calls.length;
    waiting.resolve({ status: 'completed', operation: { ...operation, completion: { kind: 'report', report: { outcome: 'applied' } } } });
    await opening;
    assert.equal(f.mutations(), mutations);
    assert.equal(f.calls.length, calls);
    assert.equal(f.timerCount(), 0);
});

test('outside primary pointer cancels confirmation or closes settings without leaking to the host', async () => {
    const f = fixture();
    let hostPointerDowns = 0;
    f.document.addEventListener('pointerdown', () => hostPointerDowns++);
    await f.plugin.activate(f.context);
    f.setActive(true);
    await f.open();
    for (const options of [
        { button: 0, clientX: 200, clientY: 200 },
        { button: 2, clientX: 0, clientY: 0 },
        { button: 0, ctrlKey: true, clientX: 0, clientY: 0 },
        { button: 0, isPrimary: false, clientX: 0, clientY: 0 },
        { button: 0, defaultPrevented: true, clientX: 0, clientY: 0 }
    ]) {
        await f.panel().emit('pointerdown', options);
        assert.equal(f.panel().open, true);
    }
    hostPointerDowns = 0;
    await f.requestDisable();
    const outside = { button: 0, clientX: 0, clientY: 0 };
    const event = await f.panel().emit('pointerdown', outside);
    assert.equal(event.defaultPrevented, true);
    assert.equal(f.panel().open, true);
    assert.equal(f.byClass('codlet-confirmation').hidden, true);
    assert.equal(f.document.activeElement, f.toggle());
    await f.panel().emit('pointerdown', outside);
    assert.equal(f.panel().open, false);
    assert.equal(f.panel().hidden, true);
    assert.equal(hostPointerDowns, 0);
    assert.equal(f.calls.includes('disableSelf'), false);
    f.plugin.deactivate();
});
