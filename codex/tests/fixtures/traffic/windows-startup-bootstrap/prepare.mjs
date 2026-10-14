// Prepare isolated acceptance with the production startup lifecycle. No launch.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const here = import.meta.dirname, repo = fileURLToPath(new URL('../../../../', import.meta.url));
const output = process.argv[2];
if (!output || !path.isAbsolute(output) || fs.existsSync(output)) throw Error('Supply a new absolute fixture output directory');
fs.mkdirSync(output, { recursive: true });
for (const name of ['codex-desktop-adapter', 'codex-ui-adapter', 'codlet']) {
  fs.cpSync(path.join(repo, 'bundled', name), path.join(output, 'plugins/bundled', name), { recursive: true, errorOnExist: true, force: false });
}
// Only difference from production: suppress unrelated OS sandbox installation.
const { build } = createRequire(path.join(repo, 'frontend/package.json'))('esbuild');
const main = await build({ entryPoints: [path.join(here, 'guarded-main.cjs')], bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node24',
  plugins: [{ name: 'core-client', setup(plugin) { plugin.onResolve({ filter: /^\.\.\/runtime\/plaintext-source-client\.cjs$/ }, () => ({ path: path.join(repo, 'host/vendor/plaintext-source-client.cjs') })); } }] });
const host = await build({ entryPoints: [path.join(repo, 'host/desktop-launch.cjs')], bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node24',
  define: { CODEX_TRAFFIC_MAIN_SOURCE: JSON.stringify(main.outputFiles[0].text) } });
fs.writeFileSync(path.join(output, 'plugins/bundled/codex-desktop-adapter/host.cjs'), host.outputFiles[0].text);
fs.cpSync(path.join(here, 'consumer'), path.join(output, 'consumer'), { recursive: true, errorOnExist: true, force: false });
fs.copyFileSync(path.join(here, 'traffic-probe.js'), path.join(output, 'probe.js'));
fs.writeFileSync(path.join(output, 'config.example.json'), JSON.stringify({ root: path.join(output, 'run-http'),
  clientApp: 'REPLACE_WITH_ABSOLUTE_REVIEWED_APP_DIRECTORY', testBinary: 'REPLACE_WITH_ABSOLUTE_CORE_ACCEPTANCE_BINARY',
  pluginsRoot: path.join(output, 'plugins'), packageVersion: '26.924.2738.0', localApiKeyFixture: true, ownedBackend: true,
  durationSeconds: 45, fixtureWebSocket: false, probeScript: path.join(output, 'probe.js'), extraPlugins: [path.join(output, 'consumer')] }, null, 2));
console.log(JSON.stringify({ output, configuration: path.join(output, 'config.example.json') }));
