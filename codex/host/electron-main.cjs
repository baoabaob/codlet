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
  const observation=dependencies.observation;
  if(observation)Object.assign(observation,{calls:(observation.calls??0)+1,constructors:constructors.size,instances:0,transports:0,processes:0,localProcesses:0,eligible:0});
  for (const Constructor of constructors) {
    for (const connection of context.modules.instances(Constructor)) {
      if(observation){observation.instances++;if(connection.connection)observation.transports++;if(connection.connection?.proc)observation.processes++;}
      const child = connection.connection?.proc;
      if (!child || connection.disposed || ownsProcess(child) || typeof child.spawnfile !== 'string'
        || !/^codex(?:\.exe)?$/i.test(require('node:path').basename(child.spawnfile))) continue;
      if(observation)observation.localProcesses++;
      if (dependencies.canRecover && !dependencies.canRecover(child)) continue;
      verify(child.spawnfile, process.platform);
      if (connection.getPendingRequestCount() !== 0 || connection.turnCwds?.pendingByStartId?.size
        || connection.turnCwds?.startedByTurnId?.size) throw fail('client_source_backend_busy');
      connections.add(connection);
      if(observation)observation.eligible++;
    }
  }
  return connections;
}
async function recoverLocalBackends(context, ownsProcess, dependencies) {
  // Probe without blocking Native, then revalidate every idle owner because
  // a request or turn may have started while policy discovery was in flight.
  const checkDeadline=()=>{if(Number.isSafeInteger(dependencies?.deadlineUnixMs)&&Date.now()>=dependencies.deadlineUnixMs-500)throw fail('backend_config_timeout');};
  checkDeadline();
  if (dependencies?.prepareConnection) {
    for (const connection of localBackends(context, ownsProcess, { ...dependencies, canRecover: undefined })) {
      checkDeadline();
      await dependencies.prepareConnection(connection.connection);
    }
  }
  for (const connection of localBackends(context, ownsProcess, dependencies)) {
    checkDeadline();
    if (localBackends(context, ownsProcess, dependencies).has(connection)) {
      await connection.restart({intent: 'restart', killCodexProcess: false});
      if(dependencies?.observation)dependencies.observation.reconnected=(dependencies.observation.reconnected??0)+1;
    }
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
  const recoveryObservation={attempted:false,calls:0,reconnected:0};
  let readinessDeadlineUnixMs = null;
  let readinessStartedUnixMs = null;
  const diagnose = (installed,error) => {
    try {
    const desktopState=desktop?.inspect(),backendState=backend?.inspect();
    (dependencies.diagnose??recordSourceDiagnostic)({pid:process.pid,startedUnixMs:readinessStartedUnixMs,
      finishedUnixMs:Date.now(),phase:installedBeforeReady?'startup':'recovery',appReady:electron.app.isReady(),
      installed,sourceConnected,error:error?.code??error?.name,recoveryReason,recovery:recoveryObservation,desktop:desktopState,backend:backendState});
    }catch{}
  };
  let sourceConnected = false, sourceReason = null;
  source.ready.then(() => { sourceConnected = true; }, error => { sourceReason = typeof error?.code === 'string' ? error.code : 'source_unavailable'; });
  let desktop, backend, suspended = false, closed = false, restored = false, lastActivation = null, expectedSources = [];
  function attachHooks() {
    backend = installBackend({ source, runtimeExecutable: configuration.runtimeExecutable, deadlineUnixMs: configuration.deadlineUnixMs,
      startupReadiness: installedBeforeReady && !restored }, {state:context?.resources.get('backendState'),trackBackend:context?.trackBackend});
    desktop = installDesktop(electron, { source, deadlineUnixMs: configuration.deadlineUnixMs,
      ownsBackendProcess: backend.ownsProcess, isProviderSupported: backend.isProviderSupported,
      providerTrustForProcess: backend.providerTrustForProcess,
      prepareBackendRestart: transport => backend.prepareConnection(transport, { forRestart: true }),
      pendingAccountUpdate: backend.pendingAccountUpdate, updateAccountMode: backend.updateAccountMode, moduleRegistry:context?.modules,
      state:context?.resources.get('desktopState') });
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
          // Native loads its main modules after app readiness. Cold runtime
          // provisioning can occupy that loop before those modules register.
          // Stay within the bridge's forty-second initial readiness phase.
          const startupDeadlineUnixMs=readinessStartedUnixMs+35000;
          if(typeof electron.app.whenReady==='function') {
            let timer;
            try {await Promise.race([electron.app.whenReady(),new Promise((_,reject)=>{
              timer=setTimeout(()=>reject(fail('client_source_startup_timeout')),Math.max(1,startupDeadlineUnixMs-Date.now()));
            })]);}finally{clearTimeout(timer);}
          }
          readinessDeadlineUnixMs=Math.min(Date.now()+30000,startupDeadlineUnixMs);
        } else readinessDeadlineUnixMs=configuration.deadlineUnixMs;
      }
      const readyOptions = { deadlineUnixMs: readinessDeadlineUnixMs };
      const readBackend = () => recoveryReason ? backend.inspect() : backend.ready(readyOptions).catch(error => {
        if (error?.code !== 'backend_route_timeout') throw error;
        // Model-route readiness is independent of the Desktop source. Keep
        // the verified Desktop hook, and report only the failed model path.
        recoveryReason = error.code;
        return { ...backend.inspect(), available: false, reason: 'route_unavailable' };
      });
      const [initialDesktopState, initialBackendState] = await Promise.all([desktop.ready(readyOptions), readBackend()]);
      let desktopState=initialDesktopState;
      let backendState = initialBackendState;
      // Native may replace a starting backend or finish its policy while the
      // Desktop modules load. Re-observe the current owner, not the earlier
      // parallel readiness snapshot. Idle recovery can refresh an expired policy.
      if(!recoveryReason&&!closed)backendState=await readBackend();
      if(!closed)desktopState=desktop.inspect();
      if(installedBeforeReady&&!restored&&!recoveryReason&&!backendState.available&&desktopState.taskConfigurationAvailable
        &&typeof context?.modules?.instances==='function'&&desktop.connectionConstructors?.().length) {
        // Native can load its connection class before creating the local owner.
        // Wait within the original startup budget; never reconnect initialization
        // requests or extend this wait into a user's active turn.
        while(!closed&&Date.now()<readinessDeadlineUnixMs-500) {
          backendState=backend.inspect();
          if(backendState.available||backendState.reason&&!['child_unavailable','backend_config_pending'].includes(backendState.reason))break;
          const connections=desktop.connectionConstructors().flatMap(Constructor=>context.modules.instances(Constructor))
            .filter(connection=>!connection.disposed&&typeof connection.connection?.proc?.spawnfile==='string'
              &&/^codex(?:\.exe)?$/i.test(require('node:path').basename(connection.connection.proc.spawnfile)));
          const activeTurn=connections.some(connection=>connection.turnCwds?.pendingByStartId?.size||connection.turnCwds?.startedByTurnId?.size);
          if(activeTurn||connections.length&&connections.every(connection=>connection.initialized!==false&&connection.getPendingRequestCount()===0))break;
          await new Promise(resolve=>setTimeout(resolve,20));
        }
        if(!closed)backendState=await readBackend();
      }
      if (!closed && !restored && !recoveryReason && context?.modules && (!backendState.available || !installedBeforeReady) && desktopState.taskConfigurationAvailable) {
        try {
          recoveryObservation.attempted=true;
          await recover(context, backend.ownsProcess, { connections: desktop.connectionConstructors?.(),
            canRecover: backend.canRecover, prepareConnection: backend.prepareConnection,deadlineUnixMs:readinessDeadlineUnixMs,observation:recoveryObservation });
          backendState = await backend.ready(readyOptions);
        } catch (error) {
          if (error?.code !== 'client_source_backend_busy' && !/^backend_[a-z_]+$/u.test(error?.code)) throw error;
          recoveryReason = error.code;
        }
      }
      if(!closed)desktopState=desktop.inspect();
      if(!closed&&!recoveryReason)backendState=backend.inspect();
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
    async close() { if(closed)return;closed=true;desktop.close(); await backend.close(); if(!shared)source.close(); },
  });
}
function validateSnapshot(value) {return !!value&&value.schema===1&&(value.recoveryReason===null||typeof value.recoveryReason==='string')
    &&(value.activatedSources===undefined||Array.isArray(value.activatedSources)&&value.activatedSources.length<=2
      &&new Set(value.activatedSources).size===value.activatedSources.length&&value.activatedSources.every(id=>['desktop-main-http','owned-backend-provider'].includes(id)))
  &&Array.isArray(value.backends)&&value.backends.length<=64&&Number.isSafeInteger(value.taskRoutes)&&value.taskRoutes>=0
  &&value.backends.every(record=>Number.isSafeInteger(record.pid)&&record.pid>0&&Array.isArray(record.routes)&&record.routes.every(route=>typeof route==='string'&&route.length<2048));}
module.exports = { handoffVersion:1, installElectronTraffic, validateClientSource, validateSnapshot, recoverLocalBackends };
