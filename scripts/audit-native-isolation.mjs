// Static evidence for this exact installed build. No client module is executed.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const [directory,output]=process.argv.slice(2);
if(!directory)throw Error('Pass the extracted 26.1007.2314.0 source directory');
const pins={
 'application-network-startup-CfAQmSYg.js':'cd6e8a8fbc4354a6e6ff19c6e4bf6fc1fb3960c63708c83871357c6238f516a8',
 'bootstrap-487kJHw_.js':'ea76cfdf390fb549577879d98967a646638b2a2c8b7eede9a61dda6401471c3b',
 'build-flavor-CYXpoCFI.js':'23229dac961a82c52237acc32598ddb2c1cf370b24c64fc507b9c24bcf2c4d93',
 'main-BklS_2Y2.js':'5cf1544463be9497b85b69051aa5ad32320f9ebdca063ec2ab41abb75b6cadf7',
 'src-BJv5Mk7n.js':'72e2b366d574206f76fc079c79b64c31ce378970a797475ded8709908d338f08',
 'startup-requirements-C6B1x9gL.js':'73f93b81152bff48cd27bcebcf27c430fb763e5c7418c67824950f4092ba933d',
};
const source={};for(const [name,hash] of Object.entries(pins)){const data=fs.readFileSync(path.join(directory,name));assert.equal(createHash('sha256').update(data).digest('hex'),hash,name);source[name]=data.toString('utf8');}
const network=source['application-network-startup-CfAQmSYg.js'],bootstrap=source['bootstrap-487kJHw_.js'],flavor=source['build-flavor-CYXpoCFI.js'],main=source['main-BklS_2Y2.js'],shared=source['src-BJv5Mk7n.js'],startup=source['startup-requirements-C6B1x9gL.js'];
const require=createRequire(new URL('../frontend/package.json',import.meta.url));
const ast=require('acorn').parse(main,{ecmaVersion:'latest',sourceType:'script'});
const defaults=ast.body.filter(node=>node.type==='VariableDeclaration').flatMap(node=>node.declarations).find(node=>node.id.name==='bi');
assert.equal(defaults?.init?.type,'ObjectExpression');
const featureKeys=new Set(defaults.init.properties.map(node=>node.key.name??node.key.value));
const rust=fs.readFileSync(new URL('../src/lab.rs',import.meta.url),'utf8').split('fn restricted_features(')[1].split('struct Reporter')[0];
const overrides=JSON.parse('{'+rust.match(/json!\(\{([\s\S]*?)\}\)/)[1]+'}');
for(const key of ['quickChat','computerUseNodeRepl']){assert.ok(rust.includes('object.remove("'+key+'")'));delete overrides[key];}
const checks={
 envBuildFlavorPrecedesMetadata:flavor.includes('resolve(){let e=process.env.BUILD_FLAVOR,t=m.parse(e);return t?'),
 explicitUserData:bootstrap.includes('let i=n.CODEX_ELECTRON_USER_DATA_PATH?.trim();if(i)return(0,h.resolve)(i);'),
 userDataBeforeSingleInstance:bootstrap.indexOf('f.app.setPath(`userData`,oD(')<bootstrap.indexOf('var Wk=iD('),
 windowsSingleInstanceRemainsEnabled:bootstrap.includes('function iD({isMacOS:e,isPackaged:t,hasExplicitUserDataPath:n=!1}){return t?!e||n:!1}'),
 windowsProtocolRegistrationSkipped:bootstrap.includes('function w(){if(process.platform===`win32`)return;let t=FE(e.isPackaged);'),
 websocketOverride:network.includes('let t=process.env.CODEX_APP_SERVER_WS_URL??e.websocket_url;'),
 websocketExport:network.includes('"D",{enumerable:!0,get:function(){return Yo}}'),
 localRouterGate:main.includes('this.localClientCoordinationEnabled=A5(l.m)==null;')&&main.includes('function A5(e){return process.env.CODEX_APP_SERVER_FORCE_CLI===`1`?null:r.Li(e.id)?e.websocket_url??null:c.D(e)}'),
 hostManagerGate:main.includes('e.localClientCoordinationEnabled&&(d=new ufe('),
 threadReadGate:main.includes('h=e.localClientCoordinationEnabled?new i.y(`desktop`,o):null'),
 queryBroadcastGate:main.includes('this.localClientCoordinationEnabled){let e=new i.y(`desktop`,this.errorReporter);'),
 rendererClientGate:main.includes('if(!this.localClientCoordinationEnabled||this.ipcClientsByWebContentsId.has(e.id))return;let n=new i.y('),
 fourReviewedIpcClientSites:(main.match(/new i\.y\(/g)??[]).length===4,
 ipcClientAlias:shared.includes('"y",{enumerable:!0,get:function(){return c1}}')&&shared.includes('logger=u.r(`IpcClient`)'),
 shellRetainsExplicitHome:startup.includes('Ui=process.env.CODEX_ELECTRON_USER_DATA_PATH?.trim()?process.env.CODEX_HOME:void 0')&&startup.includes('Ui!=null&&(process.env.CODEX_HOME=Ui)'),
 updaterDisable:flavor.includes('e.CODEX_SPARKLE_ENABLED===`false`')&&flavor.includes('!u(r)&&c.includes(e)&&t===n'),
 primaryRuntimeManual:main.includes('process.env.BUILD_FLAVOR===`dev`&&process.env.CODEX_ELECTRON_PRIMARY_RUNTIME_UPDATE_MODE===`manual`'),
 sqliteMigrationOptOut:main.includes('if(!(process.env.CODEX_SQLITE_HOME!=null||c.vt()))'),
 startupLogEvidence:shared.includes('initialize_handshake_result')&&shared.includes('Starting app-server connection')&&main.includes('shell environment hydrated')&&main.includes('Launching app'),
 strictCurrentFeatureOverrides:main.includes('hte=yi.partial().strict()')&&Object.keys(overrides).every(key=>featureKeys.has(key)&&overrides[key]===false)&&!featureKeys.has('quickChat')&&!featureKeys.has('computerUseNodeRepl'),
};
for(const [name,ok] of Object.entries(checks))assert.equal(ok,true,name);
const report={schema:1,packageVersion:'26.1007.2314.0',kind:'static-source-review',sourceHashes:pins,checks,limitations:['Requires dedicated literal-loopback WebSocket backend; stdio still reaches a fixed production IPC name.','Does not prove runtime PID/Target/data ownership or Native performance.','New empty profile still needs its own authentication before authenticated fixtures.']};
if(output)fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({packageVersion:report.packageVersion,checks:Object.keys(checks).length,passed:true}));
