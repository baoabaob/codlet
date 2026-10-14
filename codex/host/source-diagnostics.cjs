'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const code=value=>typeof value==='string'&&/^[a-z_]{1,80}$/i.test(value)?value:null;
const integer=value=>Number.isSafeInteger(value)&&value>=0?value:null;
function sourceDiagnostic(value) {
  const desktop=value.desktop??{},backend=value.backend??{};
  return {schema:1,pid:integer(value.pid),startedUnixMs:integer(value.startedUnixMs),finishedUnixMs:integer(value.finishedUnixMs),
    phase:['startup','recovery'].includes(value.phase)?value.phase:null,appReady:value.appReady===true,installed:value.installed===true,
    sourceConnected:value.sourceConnected===true,error:code(value.error),recoveryReason:code(value.recoveryReason),
    desktop:{available:desktop.available===true,reason:code(desktop.reason),taskConfigurationAvailable:desktop.taskConfigurationAvailable===true,
      taskConfigurationReason:code(desktop.taskConfigurationReason),
      modules:Object.fromEntries(['bootstrap','main','src','stdio','connection'].map(kind=>[kind,desktop.modules?.[kind]===true])),
      bindingErrors:Object.fromEntries(['bootstrap','main','src','stdio','connection'].map(kind=>[kind,code(desktop.bindingErrors?.[kind])])),
      deferredBindings:Number.isSafeInteger(desktop.deferredBindings)?desktop.deferredBindings:null,
      mismatch:typeof desktop.mismatch?.name==='string'&&/^[A-Za-z0-9_.-]{1,100}$/.test(desktop.mismatch.name)&&/^[a-f0-9]{64}$/.test(desktop.mismatch.observedSha256)?{name:desktop.mismatch.name,observedSha256:desktop.mismatch.observedSha256}:null},
    backend:{available:backend.available===true,reason:code(backend.reason),
      prepared:Number.isSafeInteger(backend.backendRootsPrepared)?backend.backendRootsPrepared:null,
      declined:Number.isSafeInteger(backend.backendRootsDeclined)?backend.backendRootsDeclined:null}};
}
function recordSourceDiagnostic(value) {
  const report=sourceDiagnostic(value);
  // One bounded operational snapshot; no requests, URLs, credentials or chat
  // content. Logging failures must not affect the owned client's startup.
  try { fs.writeFileSync(path.join(os.tmpdir(),`codlet-client-source-${process.pid}-${report.startedUnixMs}.json`),JSON.stringify(report)+'\n',{flag:'wx',mode:0o600}); }
  catch {}
}
module.exports={recordSourceDiagnostic,sourceDiagnostic};
