// Fixed signed setup resource: install ordinary GitHub plugins, never embedded packages.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const allowed = ['codex.ui.adapter', 'codex.desktop.adapter', 'codlet-gui'];
function plain(file) {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw Error(`Linked setup path: ${current}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (path.dirname(current) === current) break;
  }
}
function read(file) { plain(file); return JSON.parse(fs.readFileSync(file, 'utf8')); }
function cli(root, home, args) {
  const result = spawnSync(path.join(root, 'codlet'), args, {
    encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, CODLET_HOME: home },
  });
  if (result.error || result.status !== 0) throw Error(`Initialization failed: ${result.error?.message || result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}
function approve(id, permissions) {
  const message = `${id} 的最新版本还需要以下权限：\n\n${permissions.join('\n')}\n\n是否批准？`;
  const answer = spawnSync('/usr/bin/osascript', ['-e', 'on run argv\nset response to display dialog (item 1 of argv) with title "Codlet · 新增插件权限" buttons {"取消", "批准"} default button "取消" cancel button "取消"\nreturn button returned of response\nend run', message], { encoding: 'utf8' });
  return !answer.error && answer.status === 0 && answer.stdout.trim() === '批准';
}
export function initialize(selected, {
  approvedPermissions = [], interactivePermissions = false,
  appRoot = root, home = process.env.CODLET_HOME,
  invoke = args => cli(appRoot, home, args),
} = {}) {
  if (!home || !path.isAbsolute(home)) throw Error('The launcher must supply an absolute CODLET_HOME');
  plain(appRoot); plain(home); fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const catalog = read(path.join(appRoot, 'official-plugins.json'));
  if (catalog.schema !== 1 || catalog.kind !== 'codlet-plugin-download-options' || !Array.isArray(catalog.plugins)) throw Error('Invalid plugin download options');
  const packages = catalog.plugins;
  if (new Set(packages.map(p => p.id)).size !== packages.length || packages.some(p => !allowed.includes(p.id) ||
      !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(p.repositoryUrl) ||
      !Number.isSafeInteger(p.repositoryId) || p.repositoryId <= 0 || !Number.isSafeInteger(p.ownerId) || p.ownerId <= 0 ||
      !Array.isArray(p.permissions) || !Array.isArray(p.dependencies) || p.dependencies.some(id => !allowed.includes(id)))) throw Error('Invalid plugin download option');
  if (selected.includes('codlet-gui')) selected = [...new Set([...selected, 'codex.ui.adapter'])];
  if (selected.some(id => !packages.some(p => p.id === id))) throw Error('Selected plugin is unavailable');
  const statePath = path.join(home, 'macos-setup.json');
  const state = fs.existsSync(statePath) ? read(statePath) : { schema: 1, decided: {} };
  if (state.schema !== 1 || !state.decided || typeof state.decided !== 'object') throw Error('Unsupported setup state');
  const save = () => {
    plain(statePath);
    const temporary = `${statePath}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, statePath);
  };
  const download = args => {
    for (let attempt = 0; ; attempt++) {
      try { return invoke(args); }
      catch (error) {
        if (attempt >= 1 || !/github_network|github_timeout|Could not connect to GitHub|GitHub request timed out/.test(error.message)) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
      }
    }
  };
  const listing = selected.length ? invoke(['plugin', 'list', '--json']) : { plugins: [] };
  // A failed dependency must not discard the rest of the user's selection.
  for (const id of selected) if (!listing.plugins.some(p => p.id === id)) state.decided[id] = { selected: true, result: 'pending' };
  save();
  for (const pkg of packages) {
    const id = pkg.id;
    if (!selected.includes(id)) {
      if (!state.decided[id] || state.decided[id].result === 'pending') state.decided[id] = { selected: false, result: 'declined' };
      continue;
    }
    if (listing.plugins.some(p => p.id === id)) {
      if (!state.decided[id] || state.decided[id].result === 'pending') state.decided[id] = { selected: true, result: 'existing' };
      continue;
    }
    state.decided[id] = { selected: true, result: 'pending' }; save();
    const releases = download(['plugin', 'github', 'releases', pkg.repositoryUrl + '/releases/latest', '--json']);
    if (releases.releases?.length !== 1) throw Error(`No unique published release for ${id}`);
    const release = releases.releases[0], version = /^v(\d+\.\d+\.\d+)$/.exec(release.tag)?.[1];
    if (!version || release.prerelease) throw Error('Expected a published stable plugin release');
    const assets = release.assets.filter(a => a.name === `${id}-${version}.zip`);
    if (assets.length !== 1) throw Error(`No unique plugin ZIP in ${release.tag}`);
    const preview = download(['plugin', 'github', 'preview', pkg.repositoryUrl, '--release', String(release.id), '--asset', String(assets[0].id), '--json']);
    if (preview.manifest?.id !== id || preview.manifest.version !== version || preview.source?.repositoryUrl !== pkg.repositoryUrl ||
        preview.source.repositoryId !== pkg.repositoryId || preview.source.ownerId !== pkg.ownerId || !preview.source.upstreamDigestVerified)
      throw Error(`Plugin identity or download digest mismatch: ${id}`);
    const permissions = preview.manifest.permissions;
    if (!Array.isArray(permissions)) throw Error('Invalid permission preview');
    const missing = permissions.filter(p => !pkg.permissions.includes(p) && !approvedPermissions.includes(p));
    if (missing.length && (!interactivePermissions || process.platform !== 'darwin' || !approve(id, missing)))
      throw Error(`安装 ${id} 需要明确批准新增权限：${missing.join(', ')}。`);
    const args = ['plugin', 'github', 'install', preview.path, '--trust', '--json'];
    for (const permission of permissions) args.push('--grant', permission);
    if (preview.existingEnabled) args.push('--enable');
    invoke(args); // Never blindly replay a mutation after an uncertain result.
    state.decided[id] = { selected: true, result: 'installed', version, source: 'github', repositoryUrl: pkg.repositoryUrl }; save();
  }
  save();
  console.log('Codlet initialization completed. Existing plugins and preferences were preserved.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    initialize(args.filter(a => a !== '--interactive-permissions' && !a.startsWith('--approve-new-permission=')), {
      interactivePermissions: args.includes('--interactive-permissions'),
      approvedPermissions: args.filter(a => a.startsWith('--approve-new-permission=')).map(a => a.slice('--approve-new-permission='.length)),
    });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
