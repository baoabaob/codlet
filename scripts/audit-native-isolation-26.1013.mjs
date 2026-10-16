// Static review of the isolated Dev/WS launch path; never executes Native code.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const [directory,output]=process.argv.slice(2);
if(!directory)throw Error('Pass the extracted 26.1013.3656.0 source directory');
const pins={
  'application-network-startup-DB1VeU3v.js':'c338bbdde151467554d63beea59206848ca38a68abe16b0477d983a172c67578',
  'bootstrap-cdWF4rWM.js':'a8fdd0feea4448d66037df9f264aade773f1405299bbccf2418544e4b619b41b',
  'file-based-logger-CJvvkBIo.js':'02313a8f1c7ea7ee9488e753d6a892af844cbb4df6c76e0ee381fe23717d5873',
  'main-C4DYk222.js':'c8a2af504b21314fa6a64ad1b4ec83dbad80033ede902caf9978fd9c74a2c175',
  'src-DsLVGakC.js':'28a0918f01c50b0eb17676e894998ad7182f119d978adf0467ccaac3583f259c',
  'startup-requirements-BlaoVssN.js':'8a38b0850e36b761e0d95e07e93600716db41cb88de98c8e18fb392be25a38e6',
};
const source={};
for(const [name,hash]of Object.entries(pins)){
  const data=fs.readFileSync(path.join(directory,name));
  assert.equal(createHash('sha256').update(data).digest('hex'),hash,name);source[name]=data.toString('utf8');
}
const network=source['application-network-startup-DB1VeU3v.js'],bootstrap=source['bootstrap-cdWF4rWM.js'],flavor=source['file-based-logger-CJvvkBIo.js'],main=source['main-C4DYk222.js'],shared=source['src-DsLVGakC.js'],startup=source['startup-requirements-BlaoVssN.js'];
const require=createRequire(new URL('../frontend/package.json',import.meta.url));
const ast=require('acorn').parse(main,{ecmaVersion:'latest',sourceType:'script'});
const defaults=ast.body.filter(node=>node.type==='VariableDeclaration').flatMap(node=>node.declarations).find(node=>node.id.name==='ii');
assert.equal(defaults?.init?.type,'ObjectExpression');
const featureKeys=new Set(defaults.init.properties.map(node=>node.key.name??node.key.value));
const rust=fs.readFileSync(new URL('../src/lab.rs',import.meta.url),'utf8').split('fn restricted_features(')[1].split('struct Reporter')[0];
const overrides=JSON.parse('{'+rust.match(/json!\(\{([\s\S]*?)\}\)/)[1]+'}');
assert.match(rust,/if matches!\([\s\S]*?"26\.1013\.3656\.0"[\s\S]*?\)\s*\{/);
for(const key of ['quickChat','computerUseNodeRepl']){assert.ok(rust.includes('object.remove("'+key+'")'));delete overrides[key];}
const checks={
  envBuildFlavorPrecedesMetadata:flavor.includes('resolve(){let e=process.env.BUILD_FLAVOR,t=v.parse(e);return t?'),
  explicitUserData:bootstrap.includes('let r=n.CODEX_ELECTRON_USER_DATA_PATH?.trim();if(r)return(0,g.resolve)(r);'),
  userDataBeforeSingleInstance:bootstrap.indexOf('y.app.setPath(`userData`,kD(')>=0&&bootstrap.indexOf('y.app.setPath(`userData`,kD(')<bootstrap.indexOf('var hA=DD('),
  windowsSingleInstanceRemainsEnabled:bootstrap.includes('function DD({isMacOS:e,isPackaged:t,hasExplicitUserDataPath:n=!1}){return t?!e||n:!1}'),
  windowsProtocolRegistrationSkipped:bootstrap.includes('function ne(){if(process.platform===`win32`)return;let t=iD(e.isPackaged);'),
  websocketOverride:network.includes('let t=process.env.CODEX_APP_SERVER_WS_URL??e.websocket_url;'),
  websocketExport:network.includes('"D",{enumerable:!0,get:function(){return Yo}}'),
  reviewedImports:main.includes('a=require("./src-DsLVGakC.js")')&&main.includes('l=require("./application-network-startup-DB1VeU3v.js")'),
  localRouterGate:main.includes('this.localClientCoordinationEnabled=L5(u.m)==null;')&&main.includes('function L5(e){return process.env.CODEX_APP_SERVER_FORCE_CLI===`1`?null:i.Ri(e.id)?e.websocket_url??null:l.D(e)}'),
  hostManagerGate:main.includes('e.localClientCoordinationEnabled&&(d=new yue('),
  threadReadGate:main.includes('h=e.localClientCoordinationEnabled?new a.b(`desktop`,o):null'),
  queryBroadcastGate:main.includes('this.localClientCoordinationEnabled){let e=new a.b(`desktop`,this.errorReporter);'),
  rendererClientGate:main.includes('if(!this.localClientCoordinationEnabled||this.ipcClientsByWebContentsId.has(e.id))return;let n=new a.b('),
  fourReviewedIpcClientSites:(main.match(/new a\.b\(/g)??[]).length===4,
  ipcClientAlias:shared.includes('"b",{enumerable:!0,get:function(){return p1}}')&&shared.includes('logger=u.i(`IpcClient`)'),
  shellRetainsExplicitHome:startup.includes('Hi=process.env.CODEX_ELECTRON_USER_DATA_PATH?.trim()?process.env.CODEX_HOME:void 0')&&startup.includes('Hi!=null&&(process.env.CODEX_HOME=Hi)'),
  updaterDisable:flavor.includes('e.CODEX_SPARKLE_ENABLED===`false`')&&flavor.includes('!m(r)&&f.includes(e)&&t===n'),
  primaryRuntimeManual:main.includes('process.env.BUILD_FLAVOR===`dev`&&process.env.CODEX_ELECTRON_PRIMARY_RUNTIME_UPDATE_MODE===`manual`'),
  sqliteMigrationOptOut:main.includes('if(!(process.env.CODEX_SQLITE_HOME!=null||l.xt()))'),
  startupLogEvidence:shared.includes('initialize_handshake_result')&&shared.includes('Starting app-server connection')&&main.includes('shell environment hydrated')&&main.includes('Launching app'),
  strictCurrentFeatureOverrides:main.includes('lte=ri.partial().strict()')&&Object.keys(overrides).every(key=>featureKeys.has(key)&&overrides[key]===false)&&!featureKeys.has('quickChat')&&!featureKeys.has('computerUseNodeRepl'),
  windowsRegisteredCoreNotInherited:bootstrap.includes('delete process.env.CODEX_WINDOWS_REGISTERED_CORE,delete process.env.CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY'),
};
for(const [name,value]of Object.entries(checks))assert.equal(value,true,name);
const report={schema:1,packageVersion:'26.1013.3656.0',kind:'static-source-review',sourceHashes:pins,checks,
  limitations:['Dedicated literal-loopback WebSocket backend is required; default stdio still uses production IPC.','This review never executes onboarding or Windows sandbox initialization.','Explicit profile paths and a synthetic backend account do not prove running PID/Target/data ownership.','Static Windows checks do not establish macOS acceptance or a running stream handoff.']};
if(output)fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({packageVersion:report.packageVersion,checks:Object.keys(checks).length,passed:true}));
