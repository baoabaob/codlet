'use strict';
const { connectPlaintextSource } = require('../../runtime/plaintext-source-client.cjs');
const { installDesktopPlaintext } = require('./electron-plaintext.cjs');
const { installBackendSpawn } = require('./backend-spawn.cjs');
const { recordSourceDiagnostic } = require('./source-diagnostics.cjs');
const { createOfficialUpdates } = require('./official-updates.cjs');
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
  // Probe without blocking Native, then revalidate each captured transport.
  const captured=new Map([...localBackends(context,ownsProcess,{...dependencies,canRecover:undefined})].map(connection=>[connection,connection.connection?.proc]));
  if (dependencies?.prepareConnection) {
    for (const connection of localBackends(context, ownsProcess, { ...dependencies, canRecover: undefined })) {
      await dependencies.prepareConnection(connection.connection);
    }
  }
  for (const connection of localBackends(context, ownsProcess, dependencies)) {
    if (connection.connection?.proc===captured.get(connection)&&localBackends(context, ownsProcess, dependencies).has(connection)) {
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
  let readinessStartedUnixMs = null;
  let release;
  const retirement=new Promise(resolve=>{release=resolve;});
  const sleep=async(background=false)=>{let timer;try{await Promise.race([new Promise(resolve=>{timer=setTimeout(resolve,20);if(background)timer.unref?.();}),retirement]);}finally{clearTimeout(timer);}};
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
  let readyPromise=null,recovery=null;
  const pendingReason=reason=>reason==null||['initializing','child_unavailable','backend_config_pending'].includes(reason);
  const activation=()=>{
    const desktopState=desktop.inspect(),backendState=backend.inspect(),activatedSources=[],unsupportedSources=[],pendingSources=[];
    const unavailable=(id,reason)=>{const pending=pendingReason(reason);(pending?pendingSources:unsupportedSources).push({id,reason:pending?(reason??'initializing'):['unsupported_build','hook_unavailable','route_unavailable','timeout','ambiguous_contract','binding_changed','contract_unavailable'].includes(reason)?reason:'route_unavailable'});};
    if(desktopState.available)activatedSources.push({id:'desktop-main-http',operations:['http.intercept'],protocols:['http','sse'],coverage:['desktop-main-fetch','desktop-main-upload-progress']});
    else unavailable('desktop-main-http',desktopState.reason);
    if(backendState.available&&desktopState.taskConfigurationAvailable)activatedSources.push({id:'owned-backend-provider',operations:['route.register','route.update','route.close','http.intercept'],protocols:['http','sse','webSocket'],coverage:['owned-local-app-server-model-provider']});
    else unavailable('owned-backend-provider',!desktopState.taskConfigurationAvailable?desktopState.taskConfigurationReason:backendState.reason);
    return {installed:activatedSources.length>0,activatedSources,unsupportedSources,pending:pendingSources.length>0,pendingSources};
  };
  function startRecovery() {
    if(recovery)return;
    const attempted=new WeakSet();let genericAttempted=false;
    recovery=(async()=>{
      await Promise.race([source.ready,retirement]);
      if(typeof electron.app.whenReady==='function')await Promise.race([electron.app.whenReady(),retirement]);
      while(!closed&&!suspended) {
        const ds=desktop.inspect(),bs=backend.inspect();
        if(!restored&&ds.taskConfigurationAvailable) {
          const constructors=desktop.connectionConstructors?.()??[];
          const actual=typeof context?.modules?.instances==='function'&&constructors.length;
          const connections=actual?constructors.flatMap(Constructor=>context.modules.instances(Constructor)).filter(connection=>!connection.disposed&&connection.connection?.proc):[];
          const eligible=connections.filter(connection=>!backend.ownsProcess(connection.connection.proc)&&!attempted.has(connection.connection.proc));
          const idle=eligible.length&&eligible.every(connection=>connection.initialized!==false&&connection.getPendingRequestCount()===0&&!connection.turnCwds?.pendingByStartId?.size&&!connection.turnCwds?.startedByTurnId?.size);
          if(actual?idle:!genericAttempted&&(!bs.available||!installedBeforeReady)) {
            genericAttempted=true;for(const connection of eligible)attempted.add(connection.connection.proc);
            try {
              recoveryObservation.attempted=true;
              await recover(context,backend.ownsProcess,{connections:constructors,canRecover:backend.canRecover,prepareConnection:backend.prepareConnection,observation:recoveryObservation});
              recoveryReason=null;
            }catch(error){recoveryReason=error?.code??'backend_config_unavailable';}
          }
        }
        await sleep(true);
      }
    })();
    recovery.catch(error=>{if(!closed)recoveryReason=error?.code??'source_unavailable';});
  }
  function attachHooks() {
    backend = installBackend({ source, runtimeExecutable: configuration.runtimeExecutable, deadlineUnixMs: configuration.deadlineUnixMs,
      startupReadiness: installedBeforeReady && !restored }, {state:context?.resources.get('backendState'),trackBackend:context?.trackBackend,observeBackend:context?.observeBackend});
    desktop = installDesktop(electron, { source, deadlineUnixMs: configuration.deadlineUnixMs,
      ownsBackendProcess: backend.ownsProcess, isProviderSupported: backend.isProviderSupported,
      providerTrustForProcess: backend.providerTrustForProcess,
      prepareBackendRestart: transport => backend.prepareConnection(transport, { forRestart: true }),
      pendingAccountUpdate: backend.pendingAccountUpdate, updateAccountMode: backend.updateAccountMode, moduleRegistry:context?.modules,
      state:context?.resources.get('desktopState'),observeBackendOwner:context?.observeBackendOwner,registerBackendOwners:context?.registerBackendOwners });
  }
  try { attachHooks();
  } catch (error) { desktop?.close(); backend?.close(); if(!shared)source.close(); throw error; }
  const status = () => ({ installed: true, source: { connected: sourceConnected, reason: sourceReason }, desktop: desktop.inspect(), backend: backend.inspect(), recovery: { reason: recoveryReason },activation:activation() });
  const officialUpdates = createOfficialUpdates(electron, context?.modules);
  return Object.freeze({
    handoffVersion: 1,
    officialUpdateTarget: () => officialUpdates.target(),
    installOfficialUpdate: target => officialUpdates.install(target),
    snapshot() {
      if(desktop.canSuspend?.()===false)throw fail('core_update_source_busy');
      const state=context?.resources.get('backendState');
      if(!state||!context.resources.get('desktopState'))throw fail('core_update_next_start_required');
      return {schema:1,recoveryReason,activatedSources:lastActivation?.activatedSources?.map(source=>source.id)??[],backends:[...state.records].map(record=>({pid:record.child.pid??null,
        routes:record.reservations.map(route=>route.baseUrl)})),taskRoutes:context.resources.get('desktopState').taskRoutes.size};
    },
    suspend() {
      if(closed||suspended||!shared||typeof desktop.suspend!=='function'||desktop.canSuspend?.()===false)return false;
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
      recoveryReason=snapshot.recoveryReason;expectedSources=snapshot.activatedSources??[];restored=true;attachHooks();suspended=false;readyPromise=null;
      lastActivation=await this.ready();return lastActivation.installed===true;
    },
    confirmTakeover() {return !closed&&!suspended&&lastActivation?.installed===true;},
    ready() {
      return readyPromise??=(async()=>{
        readinessStartedUnixMs??=Date.now();
        await Promise.race([source.ready,retirement]);
        if(typeof electron.app.whenReady==='function')await Promise.race([electron.app.whenReady(),retirement]);
        if(closed)return activation();
        startRecovery();
        // Observe optional setup independently. Its original operation can keep
        // preparing while an already-ready Desktop source is published.
        Promise.resolve(backend.ready()).catch(error=>{recoveryReason=error?.code??'backend_config_unavailable';});
        Promise.resolve(desktop.ready()).catch(error=>{sourceReason=error?.code??'source_unavailable';});
        for(;;){
          const value=activation(),lost=expectedSources.filter(id=>!value.activatedSources.some(source=>source.id===id));
          if(lost.some(id=>value.unsupportedSources.some(source=>source.id===id)))throw fail('core_update_source_capability_lost');
          if(closed||!lost.length&&(value.installed||!value.pending)){diagnose(value.installed,null);return lastActivation=value;}
          await sleep();
        }
      })();
    },
    inspect: status,
    async close() { if(closed)return;closed=true;release();officialUpdates.close();desktop.close(); await backend.close(); if(!shared)source.close(); },
  });
}
function validateSnapshot(value) {return !!value&&value.schema===1&&(value.recoveryReason===null||typeof value.recoveryReason==='string')
    &&(value.activatedSources===undefined||Array.isArray(value.activatedSources)&&value.activatedSources.length<=2
      &&new Set(value.activatedSources).size===value.activatedSources.length&&value.activatedSources.every(id=>['desktop-main-http','owned-backend-provider'].includes(id)))
  &&Array.isArray(value.backends)&&Number.isSafeInteger(value.taskRoutes)&&value.taskRoutes>=0
  &&value.backends.every(record=>Number.isSafeInteger(record.pid)&&record.pid>0&&Array.isArray(record.routes)&&record.routes.every(route=>typeof route==='string'&&route.length<2048));}
module.exports = { handoffVersion:1, installElectronTraffic, validateClientSource, validateSnapshot, recoverLocalBackends };
