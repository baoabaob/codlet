// Prepare GUI/consumer inputs for the intrinsic Core providers. No launch.
import fs from 'node:fs';
import path from 'node:path';
const here = import.meta.dirname;
const [output, guiPlugin] = process.argv.slice(2);
if (!output || !path.isAbsolute(output) || fs.existsSync(output)) throw Error('Supply a new absolute fixture output directory');
if (!guiPlugin || !path.isAbsolute(guiPlugin) || !fs.statSync(path.join(guiPlugin, 'codlet.json')).isFile()) throw Error('Supply an absolute built GUI plugin directory');
fs.mkdirSync(output, { recursive: true });
fs.cpSync(guiPlugin, path.join(output, 'gui'), { recursive: true, errorOnExist: true, force: false });
fs.cpSync(path.join(here, 'consumer'), path.join(output, 'consumer'), { recursive: true, errorOnExist: true, force: false });
fs.copyFileSync(path.join(here, 'traffic-probe.js'), path.join(output, 'probe.js'));
fs.writeFileSync(path.join(output, 'config.example.json'), JSON.stringify({ root: path.join(output, 'run-http'),
  clientApp: 'REPLACE_WITH_ABSOLUTE_REVIEWED_APP_DIRECTORY', testBinary: 'REPLACE_WITH_ABSOLUTE_CORE_ACCEPTANCE_BINARY',
  guiPlugin: path.join(output, 'gui'), packageVersion: 'REPLACE_WITH_REVIEWED_PACKAGE_VERSION', disposableWindowsHost: false,
  localApiKeyFixture: true, ownedBackend: true,
  durationSeconds: 45, fixtureWebSocket: false, probeScript: path.join(output, 'probe.js'), extraPlugins: [path.join(output, 'consumer')] }, null, 2));
console.log(JSON.stringify({ output, configuration: path.join(output, 'config.example.json') }));
