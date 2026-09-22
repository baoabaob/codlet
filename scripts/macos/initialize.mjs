// Invoked by the native launcher using the bundled, pinned Node runtime.
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
export function initialize(selected) {
  if (!home || !path.isAbsolute(home)) throw new Error('The launcher must supply an absolute CODLET_HOME');
  plain(root); plain(home);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const lock = path.join(home, 'macos-setup.lock');
  let lockFd;
  try { lockFd = fs.openSync(lock, 'wx', 0o600); }
  catch (error) { throw new Error(`Another setup is active, or a previous setup was interrupted. Check ${lock} before retrying. (${error.code})`); }
  try {
    const catalog = read(path.join(root, 'optional-plugins/catalog.json'));
    if (catalog.schema !== 1 || catalog.kind !== 'codlet-official-plugin-bundle') throw new Error('Invalid official plugin catalog');
    const packages = catalog.packages;
    if (packages.some(pkg => !allowed.includes(pkg.id)) || new Set(packages.map(pkg => pkg.id)).size !== packages.length) throw new Error('Invalid installer plugins');
    if (selected.includes('codlet-gui')) selected = [...new Set([...selected, 'codex.ui.adapter'])];
    if (selected.some(id => !packages.some(pkg => pkg.id === id))) throw new Error('Selected plugin is unavailable');
    const existing = cli(['plugin', 'list', '--json']).plugins;
    const configPath = path.join(home, 'config.json');
    const config = fs.existsSync(configPath) ? read(configPath) : {};
    const statePath = path.join(home, 'macos-setup.json');
    const state = fs.existsSync(statePath) ? read(statePath) : { schema: 1, decided: {} };
    if (state.schema !== 1 || typeof state.decided !== 'object') throw new Error('Unsupported setup state');
    for (const id of allowed) {
      const pkg = packages.find(entry => entry.id === id);
      if (!pkg || !selected.includes(id)) { state.decided[id] ??= { selected: false }; continue; }
      const registered = existing.find(entry => entry.id === id);
      const source = path.join(root, 'optional-plugins/packages', id);
      const manifest = read(path.join(source, 'codlet.json'));
      if (manifest.id !== id || manifest.version !== pkg.version || JSON.stringify([...manifest.permissions].sort()) !== JSON.stringify([...pkg.permissions].sort())) throw new Error('Plugin manifest/catalog mismatch');
      checkFiles(source, pkg);
      const destination = path.join(home, 'packages', id);
      plain(destination);
      if (registered) {
        let same = false;
        try {
          if (registered.source === 'local' && path.resolve(registered.path) === path.resolve(destination)) {
            checkFiles(destination, pkg);
            same = true;
          }
        } catch { /* Unverifiable or modified source requires manual migration. */ }
        if (same) { console.log(`Official plugin payload already matches; existing settings retained: ${id}`); continue; }
        throw new Error(`官方插件未更新：${id}。当前注册或文件与安装包不同；本预览版不覆盖已有插件目录。请保留作者文件，并通过插件管理检查来源、权限差额后手动迁移。现有启用状态和授权未改变。`);
      }
      if (!fs.existsSync(destination)) {
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        const stage = fs.mkdtempSync(path.join(path.dirname(destination), '.setup-'));
        try {
          for (const file of pkg.files) {
            const target = path.join(stage, file.path);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(path.join(source, file.path), target, fs.constants.COPYFILE_EXCL);
          }
          checkFiles(stage, pkg);
          fs.renameSync(stage, destination);
        } finally { fs.rmSync(stage, { recursive: true, force: true }); }
      } else checkFiles(destination, pkg);
      const args = ['plugin', 'add', destination, '--trust', '--json'];
      const preference = config.plugins?.[id] ?? (id === 'codlet-gui' ? config.plugins?.codlet : undefined);
      if (preference?.enabled !== false) args.push('--enable');
      for (const permission of pkg.permissions) args.push('--grant', permission);
      cli(args);
      state.decided[id] = { selected: true, result: 'installed', version: pkg.version, source: 'official-installer', path: destination, files: pkg.files, catalogSha256: hash(path.join(root, 'optional-plugins/catalog.json')) };
    }
    plain(statePath);
    const temporary = `${statePath}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, statePath);
    const reviewedPath = path.join(home, 'plugin-bundle-reviewed.txt');
    plain(reviewedPath);
    fs.writeFileSync(reviewedPath, hash(path.join(root, 'optional-plugins/catalog.json')), { mode: 0o600 });
    console.log('Codlet initialization completed. Existing registrations and preferences were preserved.');
  } finally { fs.closeSync(lockFd); fs.unlinkSync(lock); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { initialize(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = error.message.startsWith('官方插件未更新：') ? 20 : 1; }
}
