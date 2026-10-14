// Exact-build static review. This script only reads extracted package code and
// writes evidence; it never imports Native modules, starts a client or uses CDP.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const [directory, output] = process.argv.slice(2);
if (!directory) throw Error('Pass the statically extracted 26.1007.9446.0 package source directory');
const pins = {
  'application-network-startup-YSC7OAs0.js': '52f0be375fb08281e88ad41be64220fb73f85210523e53e7d7acf094fda6344e',
  'bootstrap-iULMfRBf.js': '385e3885eda6a2852d8e0b75d1d0b579ac06e27eb9b9300fa7e92d9b5216c869',
  'build-flavor-CYXpoCFI.js': '23229dac961a82c52237acc32598ddb2c1cf370b24c64fc507b9c24bcf2c4d93',
  'main-Bgi5Xaw-.js': 'e8923725ad6357380ac7bb25818f78eb4d97e522ebbde2ddf6ff5a2a93032e54',
  'src-DCNiwad_.js': '86fb2066bbc2f7428864b76b46ef570b09eb1e92e81e9d6f089f5b048a66df25',
  'startup-requirements-CYrrMBwA.js': 'ec6518de6f43d8247ae39bae82a348e345674e979b8990c40b8dbf7b1e908cd4',
};
const source = {};
for (const [name, hash] of Object.entries(pins)) {
  const data = fs.readFileSync(path.join(directory, name));
  assert.equal(createHash('sha256').update(data).digest('hex'), hash, name);
  source[name] = data.toString('utf8');
}
const network = source['application-network-startup-YSC7OAs0.js'], bootstrap = source['bootstrap-iULMfRBf.js'], flavor = source['build-flavor-CYXpoCFI.js'], main = source['main-Bgi5Xaw-.js'], shared = source['src-DCNiwad_.js'], startup = source['startup-requirements-CYrrMBwA.js'];
const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const ast = require('acorn').parse(main, { ecmaVersion: 'latest', sourceType: 'script' });
const defaults = ast.body.filter(node => node.type === 'VariableDeclaration').flatMap(node => node.declarations).find(node => node.id.name === '_i');
assert.equal(defaults?.init?.type, 'ObjectExpression');
const featureKeys = new Set(defaults.init.properties.map(node => node.key.name ?? node.key.value));
const rust = fs.readFileSync(new URL('../src/lab.rs', import.meta.url), 'utf8').split('fn restricted_features(')[1].split('struct Reporter')[0];
const overrides = JSON.parse('{' + rust.match(/json!\(\{([\s\S]*?)\}\)/)[1] + '}');
for (const key of ['quickChat', 'computerUseNodeRepl']) { assert.ok(rust.includes('object.remove("' + key + '")')); delete overrides[key]; }
const checks = {
  envBuildFlavorPrecedesMetadata: flavor.includes('resolve(){let e=process.env.BUILD_FLAVOR,t=m.parse(e);return t?'),
  explicitUserData: bootstrap.includes('let i=n.CODEX_ELECTRON_USER_DATA_PATH?.trim();if(i)return(0,h.resolve)(i);'),
  userDataBeforeSingleInstance: bootstrap.indexOf('f.app.setPath(`userData`,oD(') >= 0 && bootstrap.indexOf('f.app.setPath(`userData`,oD(') < bootstrap.indexOf('var Wk=iD('),
  windowsSingleInstanceRemainsEnabled: bootstrap.includes('function iD({isMacOS:e,isPackaged:t,hasExplicitUserDataPath:n=!1}){return t?!e||n:!1}'),
  windowsProtocolRegistrationSkipped: bootstrap.includes('function w(){if(process.platform===`win32`)return;let t=FE(e.isPackaged);'),
  websocketOverride: network.includes('let t=process.env.CODEX_APP_SERVER_WS_URL??e.websocket_url;'),
  websocketExport: network.includes('"D",{enumerable:!0,get:function(){return Yo}}'),
  reviewedImports: main.includes('i=require("./src-DCNiwad_.js")') && main.includes('c=require("./application-network-startup-YSC7OAs0.js")'),
  localRouterGate: main.includes('this.localClientCoordinationEnabled=k5(l.m)==null;') && main.includes('function k5(e){return process.env.CODEX_APP_SERVER_FORCE_CLI===`1`?null:r.Li(e.id)?e.websocket_url??null:c.D(e)}'),
  hostManagerGate: main.includes('e.localClientCoordinationEnabled&&(d=new Ple('),
  threadReadGate: main.includes('h=e.localClientCoordinationEnabled?new i.y(`desktop`,o):null'),
  queryBroadcastGate: main.includes('this.localClientCoordinationEnabled){let e=new i.y(`desktop`,this.errorReporter);'),
  rendererClientGate: main.includes('if(!this.localClientCoordinationEnabled||this.ipcClientsByWebContentsId.has(e.id))return;let n=new i.y('),
  fourReviewedIpcClientSites: (main.match(/new i\.y\(/g) ?? []).length === 4,
  ipcClientAlias: shared.includes('"y",{enumerable:!0,get:function(){return c1}}') && shared.includes('logger=u.r(`IpcClient`)'),
  shellRetainsExplicitHome: startup.includes('Ui=process.env.CODEX_ELECTRON_USER_DATA_PATH?.trim()?process.env.CODEX_HOME:void 0') && startup.includes('Ui!=null&&(process.env.CODEX_HOME=Ui)'),
  updaterDisable: flavor.includes('e.CODEX_SPARKLE_ENABLED===`false`') && flavor.includes('!u(r)&&c.includes(e)&&t===n'),
  primaryRuntimeManual: main.includes('process.env.BUILD_FLAVOR===`dev`&&process.env.CODEX_ELECTRON_PRIMARY_RUNTIME_UPDATE_MODE===`manual`'),
  sqliteMigrationOptOut: main.includes('if(!(process.env.CODEX_SQLITE_HOME!=null||c.vt()))'),
  startupLogEvidence: shared.includes('initialize_handshake_result') && shared.includes('Starting app-server connection') && main.includes('shell environment hydrated') && main.includes('Launching app'),
  strictCurrentFeatureOverrides: main.includes('vte=gi.partial().strict()') && Object.keys(overrides).every(key => featureKeys.has(key) && overrides[key] === false) && !featureKeys.has('quickChat') && !featureKeys.has('computerUseNodeRepl'),
  windowsRegisteredCoreNotInherited: bootstrap.includes('delete process.env.CODEX_WINDOWS_REGISTERED_CORE,delete process.env.CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY'),
};
for (const [name, value] of Object.entries(checks)) assert.equal(value, true, name);
const report = { schema: 1, packageVersion: '26.1007.9446.0', kind: 'static-source-review', sourceHashes: pins, checks,
  limitations: ['Dedicated literal-loopback WebSocket backend is required; default stdio still uses production IPC.', 'This review never executes onboarding or Windows sandbox initialization.', 'Explicit profile paths and a synthetic backend account do not prove running PID/Target/data ownership.', 'Unit/static Windows checks do not establish macOS acceptance or a running stream handoff.'] };
if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ packageVersion: report.packageVersion, checks: Object.keys(checks).length, passed: true }));
