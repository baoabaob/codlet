'use strict';
const { connectPlaintextSource } = require('./vendor/plaintext-source-client.cjs');
const { installDesktopPlaintext } = require('./electron-plaintext.cjs');
const { installBackendSpawn } = require('./backend-spawn.cjs');
const { recordSourceDiagnostic } = require('./source-diagnostics.cjs');
const fail = code => Object.assign(new Error(code), { code });
function localBackends(context, ownsProcess, dependencies = {}) {
  const profiles = dependencies.profiles ?? require('./electron-plaintext.cjs').reviewedSourceProfiles;
  const verify = dependencies.verify ?? require('./backend-launch.cjs').verifyBackend;
  const connections = new Set();
  const constructors = new Set(dependencies.connections ?? []);
  if (dependencies.connections === undefined) for (const record of context.modules.list()) {
    const profile = profiles[record.name];
    const connectionSymbol = profile?.connectionSymbol ?? (profile?.kind === 'connection' ? profile.symbol : null);
    if (!connectionSymbol || profile.hash !== record.hash) continue;
    constructors.add(record.evaluate(connectionSymbol));
  }
  for (const Constructor of constructors) {
    for (const connection of context.modules.instances(Constructor)) {
      const child = connection.connection?.proc;
      if (!child || connection.disposed || ownsProcess(child) || typeof child.spawnfile !== 'string'
        || !/^codex(?:\.exe)?$/i.test(require('node:path').basename(child.spawnfile))) continue;
      verify(child.spawnfile, process.platform);
      if (connection.getPendingRequestCount() !== 0 || connection.turnCwds?.pendingByStartId?.size
        || connection.turnCwds?.startedByTurnId?.size) throw fail('client_source_backend_busy');
      connections.add(connection);
    }
  }
  return connections;
}
async function recoverLocalBackends(context, ownsProcess, dependencies) {
  // Validate the entire selected local set before reconnecting any member.
  for (const connection of localBackends(context, ownsProcess, dependencies)) {
    await connection.restart({intent: 'restart', killCodexProcess: false});
  }
}

function validateClientSource(electron, context) {
  if (!electron.app.isReady()) return;
  if (typeof context?.modules?.list!=='function'||typeof context.modules.subscribe!=='function') throw fail('client_bridge_required');
  // Admission checks the observer ABI. Each source verifies its own runtime
  // contract during activation, so one missing hook cannot reject the others.
}
function installElectronTraffic(electron, configuration, context, dependencies = {}) {
  if (!configuration?.source || !Number.isSafeInteger(configuration.deadlineUnixMs)) throw fail('invalid_launch_configuration');
  const shared=context?.resources.get('plaintextSource');
  const source = shared ?? connectPlaintextSource(configuration.source);
  const installedBeforeReady = !electron.app.isReady();
  const installBackend = dependencies.installBackend ?? installBackendSpawn;
  const installDesktop = dependencies.installDesktop ?? installDesktopPlaintext;
  const recover = dependencies.recover ?? recoverLocalBackends;
  let recoveryReason = null;
  let readinessDeadlineUnixMs = null;
  let readinessStartedUnixMs = null;
  const diagnose = (installed,error) => {
    try {
    const desktopState=desktop?.inspect(),backendState=backend?.inspect();
    (dependencies.diagnose??recordSourceDiagnostic)({pid:process.pid,startedUnixMs:readinessStartedUnixMs,
      finishedUnixMs:Date.now(),phase:installedBeforeReady?'startup':'recovery',appReady:electron.app.isReady(),
      installed,sourceConnected,error:error?.code??error?.name,recoveryReason,desktop:desktopState,backend:backendState});
    }catch{}
  };
  let sourceConnected = false, sourceReason = null;
  source.ready.then(() => { sourceConnected = true; }, error => { sourceReason = typeof error?.code === 'string' ? error.code : 'source_unavailable'; });
  let desktop, backend, suspended = false, closed = false, restored = false, lastActivation = null, expectedSources = [];
  function attachHooks() {
    backend = installBackend({ source, runtimeExecutable: configuration.runtimeExecutable, deadlineUnixMs: configuration.deadlineUnixMs }, {state:context?.resources.get('backendState'),trackBackend:context?.trackBackend});
    desktop = installDesktop(electron, { source, deadlineUnixMs: configuration.deadlineUnixMs,
      ownsBackendProcess: backend.ownsProcess, isProviderSupported: backend.isProviderSupported,
      providerTrustForProcess: backend.providerTrustForProcess,
      pendingAccountUpdate: backend.pendingAccountUpdate, updateAccountMode: backend.updateAccountMode, moduleRegistry:context?.modules,
      state:context?.resources.get('desktopState'), onlineUpdates:context?.onlineUpdates });
  }
  try { attachHooks();
  } catch (error) { desktop?.close(); backend?.close(); if(!shared)source.close(); throw error; }
  const status = () => ({ installed: true, source: { connected: sourceConnected, reason: sourceReason }, desktop: desktop.inspect(), backend: backend.inspect(), recovery: { reason: recoveryReason } });
  return Object.freeze({
    handoffVersion: 1,
    snapshot() {
      const state=context?.resources.get('backendState');
      if(!state||!context.resources.get('desktopState'))throw fail('core_update_next_start_required');
      return {schema:1,recoveryReason,activatedSources:lastActivation?.activatedSources?.map(source=>source.id)??[],backends:[...state.records].map(record=>({pid:record.child.pid??null,
        routes:record.reservations.map(route=>route.baseUrl)})),taskRoutes:context.resources.get('desktopState').taskRoutes.size};
    },
    suspend() {
      if(closed||suspended||!shared||typeof desktop.suspend!=='function')return false;
      desktop.suspend();backend.close();suspended=true;return true;
    },
    restore(snapshot) {
      if(!validateSnapshot(snapshot))throw fail('core_update_snapshot_incompatible');
      const records=[...context.resources.get('backendState').records];
      if(snapshot.backends.some(previous=>!records.some(record=>record.child.pid===previous.pid
        && JSON.stringify(record.reservations.map(route=>route.baseUrl))===JSON.stringify(previous.routes))))throw fail('core_update_backend_changed');
      recoveryReason=snapshot.recoveryReason;expectedSources=snapshot.activatedSources??[];restored=true;
    },
    async resume(snapshot) {
      if(closed||!suspended)return false;
      recoveryReason=snapshot.recoveryReason;expectedSources=snapshot.activatedSources??[];restored=true;readinessDeadlineUnixMs=Date.now()+8000;attachHooks();suspended=false;
      lastActivation=await this.ready();return lastActivation.installed===true;
    },
    confirmTakeover() {return !closed&&!suspended&&lastActivation?.installed===true;},
    async ready() {
      readinessStartedUnixMs??=Date.now();
      try {
      await source.ready;
      if(readinessDeadlineUnixMs===null) {
        if(installedBeforeReady) {
          // The bridge connects before Electron has finished its bootstrap.
          // Give module discovery its own window after app readiness, within
          // the bridge's ten-second activation bound.
          const startupDeadlineUnixMs=readinessStartedUnixMs+8000;
          if(typeof electron.app.whenReady==='function') {
            let timer;
            try {await Promise.race([electron.app.whenReady(),new Promise((_,reject)=>{
              timer=setTimeout(()=>reject(fail('client_source_startup_timeout')),Math.max(1,startupDeadlineUnixMs-Date.now()));
            })]);}finally{clearTimeout(timer);}
          }
          readinessDeadlineUnixMs=Math.min(Date.now()+5000,startupDeadlineUnixMs);
        } else readinessDeadlineUnixMs=configuration.deadlineUnixMs;
      }
      if(context?.modules&&!installedBeforeReady&&!restored) {
        // A source learned after startup may need one local app-server reconnect;
        // the desktop process and its native pages stay alive. Never interrupt
        // an active turn or replay an outstanding native request.
        try { await recover(context, backend.ownsProcess, {connections:desktop.connectionConstructors?.()}); }
        catch (error) {
          if (!['client_source_backend_busy','backend_identity_unavailable','backend_identity_changed'].includes(error?.code)) throw error;
          recoveryReason = error.code;
        }
      }
      const readyOptions = { deadlineUnixMs: readinessDeadlineUnixMs };
      const backendReady = recoveryReason ? backend.inspect() : backend.ready(readyOptions).catch(error => {
        if (error?.code !== 'backend_route_timeout') throw error;
        // Model-route readiness is independent of the Desktop source. Keep
        // the verified Desktop hook, and report only the failed model path.
        recoveryReason = error.code;
        return { ...backend.inspect(), available: false, reason: 'route_unavailable' };
      });
      const [desktopState, backendState] = await Promise.all([desktop.ready(readyOptions), backendReady]);
      const activatedSources = [], unsupportedSources = [];
      if (desktopState.available) activatedSources.push({ id: 'desktop-main-http', operations: ['http.intercept'], protocols: ['http', 'sse'],
        coverage: ['desktop-main-fetch', 'desktop-main-upload-progress'] });
      else unsupportedSources.push({ id: 'desktop-main-http', reason: ['unsupported_build', 'timeout'].includes(desktopState.reason) ? desktopState.reason : 'hook_unavailable' });
      if (backendState.available && desktopState.taskConfigurationAvailable) activatedSources.push({ id: 'owned-backend-provider', operations: ['route.register', 'route.update', 'route.close', 'http.intercept'],
        protocols: ['http', 'sse', 'webSocket'], coverage: ['owned-local-app-server-model-provider'] });
      else unsupportedSources.push({ id: 'owned-backend-provider', reason: !desktopState.taskConfigurationAvailable
        ? desktopState.taskConfigurationReason === 'unsupported_build' ? 'unsupported_build' : 'hook_unavailable'
        : backendState.reason === 'child_unavailable' ? 'child_unavailable' : 'route_unavailable' });
      const installed=activatedSources.length>0;
      if(expectedSources.some(id=>!activatedSources.some(source=>source.id===id)))throw fail('core_update_source_capability_lost');
      diagnose(installed,null);
      return lastActivation={ installed, activatedSources, unsupportedSources };
      }catch(error){diagnose(false,error);throw error;}
    },
    inspect: status,
    async close() { if(closed)return;closed=true;desktop.close(); backend.close(); if(!shared)source.close(); },
  });
}
function validateSnapshot(value) {return !!value&&value.schema===1&&(value.recoveryReason===null||typeof value.recoveryReason==='string')
    &&(value.activatedSources===undefined||Array.isArray(value.activatedSources)&&value.activatedSources.length<=2
      &&new Set(value.activatedSources).size===value.activatedSources.length&&value.activatedSources.every(id=>['desktop-main-http','owned-backend-provider'].includes(id)))
  &&Array.isArray(value.backends)&&value.backends.length<=64&&Number.isSafeInteger(value.taskRoutes)&&value.taskRoutes>=0
  &&value.backends.every(record=>Number.isSafeInteger(record.pid)&&record.pid>0&&Array.isArray(record.routes)&&record.routes.every(route=>typeof route==='string'&&route.length<2048));}
module.exports = { handoffVersion:1, installElectronTraffic, validateClientSource, validateSnapshot, recoverLocalBackends };
