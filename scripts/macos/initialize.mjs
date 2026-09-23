// Invoked by Core's fixed setup command with a held, verified Node runtime.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const home = process.env.CODLET_HOME;
const allowed = ['codex.ui.adapter', 'codex.desktop.adapter', 'codlet-gui'];
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function plain(file) {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Linked setup path: ${current}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (path.dirname(current) === current) break;
  }
}
function read(file) { plain(file); return JSON.parse(fs.readFileSync(file, 'utf8')); }
function cli(args) {
  const result = spawnSync(path.join(root, 'codlet'), args, {
    // Only this newly spawned CLI command is killed on timeout, never Codex.
    encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, CODLET_HOME: home },
  });
  if (result.error || result.status !== 0) throw new Error(`Initialization failed: ${result.error?.message || result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}
function checkFiles(directory, pkg) {
  for (const file of pkg.files) {
    if (!/^[a-zA-Z0-9._/-]+$/.test(file.path) || file.path.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('Invalid package path');
    const target = path.join(directory, file.path);
    plain(target);
    if (!fs.statSync(target).isFile() || hash(target) !== file.sha256) throw new Error(`Plugin payload changed: ${pkg.id}/${file.path}`);
  }
}
export function initialize(selected, { approvedPermissions = [], interactivePermissions = false } = {}) {
  if (!home || !path.isAbsolute(home)) throw new Error('The launcher must supply an absolute CODLET_HOME');
  plain(root); plain(home);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  // Core owns each mutation under its OS registry/launch leases and recovers its
  // journal. A persistent JS sentinel would strand updates after a killed setup.
  {
    const catalog = read(path.join(root, 'optional-plugins/catalog.json'));
    if (catalog.schema !== 1 || catalog.kind !== 'codlet-official-plugin-bundle') throw new Error('Invalid official plugin catalog');
    const packages = catalog.packages;
    if (packages.some(pkg => !allowed.includes(pkg.id)) || new Set(packages.map(pkg => pkg.id)).size !== packages.length) throw new Error('Invalid installer plugins');
    if (selected.includes('codlet-gui')) selected = [...new Set([...selected, 'codex.ui.adapter'])];
    if (selected.some(id => !packages.some(pkg => pkg.id === id))) throw new Error('Selected plugin is unavailable');
    const statePath = path.join(home, 'macos-setup.json');
    const state = fs.existsSync(statePath) ? read(statePath) : { schema: 1, decided: {} };
    if (state.schema !== 1 || typeof state.decided !== 'object') throw new Error('Unsupported setup state');
    for (const id of allowed) {
      const pkg = packages.find(entry => entry.id === id);
      if (!pkg || !selected.includes(id)) { state.decided[id] ??= { selected: false }; continue; }
      const source = path.join(root, 'optional-plugins/packages', id);
      const manifest = read(path.join(source, 'codlet.json'));
      if (manifest.id !== id || manifest.version !== pkg.version || JSON.stringify([...manifest.permissions].sort()) !== JSON.stringify([...pkg.permissions].sort())) throw new Error('Plugin manifest/catalog mismatch');
      checkFiles(source, pkg);
      const destination = path.join(home, 'packages', id);
      plain(destination);
      const catalogPath = path.join(root, 'optional-plugins/catalog.json');
      const preview = cli(['plugin', 'seed', 'preview', catalogPath, id, '--json']);
      const permissions = preview.addedPermissions;
      if (!Array.isArray(permissions)) throw new Error('Core returned an invalid permission preview');
      const missing = permissions.filter(permission => !approvedPermissions.includes(permission));
      if (preview.existing && missing.length) {
        if (!interactivePermissions || process.platform !== 'darwin') throw new Error(`更新 ${id} 需要明确批准新增权限：${missing.join(', ')}。请使用图形设置。`);
        const message = `更新 ${id} 将增加以下权限：\n\n${missing.join('\n')}\n\n已有禁用状态和授权范围保持不变。是否批准？`;
        const answer = spawnSync('/usr/bin/osascript', ['-e', 'on run argv\nset response to display dialog (item 1 of argv) with title "Codlet · 新增插件权限" buttons {"取消", "批准"} default button "取消" cancel button "取消"\nreturn button returned of response\nend run', message], { encoding: 'utf8' });
        if (answer.error || answer.status !== 0 || answer.stdout.trim() !== '批准') throw new Error(`未批准 ${id} 的新增权限；该插件未更新。`);
      }
      const args = ['plugin', 'seed', 'install', catalogPath, id, '--preview', preview.preview, '--json'];
      for (const permission of permissions) args.push('--grant', permission);
      cli(args);
      state.decided[id] = { selected: true, result: 'installed', version: pkg.version, source: 'official-installer', path: destination, files: pkg.files, catalogSha256: hash(path.join(root, 'optional-plugins/catalog.json')) };
    }
    plain(statePath);
    if (fs.existsSync(statePath)) {
      const latest = read(statePath);
      if (latest.schema !== 1 || typeof latest.decided !== 'object') throw new Error('Unsupported setup state');
      for (const [id, decision] of Object.entries(latest.decided)) {
        if (!selected.includes(id)) state.decided[id] = decision;
      }
    }
    const temporary = `${statePath}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, statePath);
    const reviewedPath = path.join(home, 'plugin-bundle-reviewed.txt');
    plain(reviewedPath);
    fs.writeFileSync(reviewedPath, hash(path.join(root, 'optional-plugins/catalog.json')), { mode: 0o600 });
    console.log('Codlet initialization completed. Existing registrations and preferences were preserved.');
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const interactivePermissions = args.includes('--interactive-permissions');
    const approvedPermissions = args.filter(arg => arg.startsWith('--approve-new-permission=')).map(arg => arg.slice('--approve-new-permission='.length));
    initialize(args.filter(arg => arg !== '--interactive-permissions' && !arg.startsWith('--approve-new-permission=')), { approvedPermissions, interactivePermissions });
  }
  catch (error) { console.error(error.message); process.exitCode = error.message.includes('官方插件未更新：') ? 20 : 1; }
}
