'use strict';
// Core-owned transport and CommonJS observation. No client symbols or profiles.
const net = require('node:net');
const path = require('node:path');
const { realpathSync, readFileSync, statSync } = require('node:fs');
const Module = require('node:module');
const { createHash, timingSafeEqual, randomUUID } = require('node:crypto');
const { connectPlaintextSource } = require('./plaintext-source-client.cjs');
const { createWriteLedger, snapshotJson } = require('./online-update.cjs');
const acorn = require('acorn');
const MAX_FRAME = 2 * 1024 * 1024;
const fail = code => Object.assign(new Error(code), { code });
const label = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value);
const codeOf = error => /^[a-z_]{1,80}$/.test(error?.code) ? error.code : 'client_bridge_operation_failed';
async function bounded(operation, code, timeoutMs = 10000) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
      timer = setTimeout(() => reject(fail(code)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

function describeClasses(ast) {
  const bindings = new Set(), classes = new Map();
  for (const node of ast.body) {
    if (node.type === 'VariableDeclaration') for (const item of node.declarations) if (item.id.type === 'Identifier') bindings.add(item.id.name);
    if (node.type === 'ClassDeclaration' && node.id) bindings.add(node.id.name);
  }
  const add = (name, node) => {
    if (!bindings.has(name) || !/^[A-Za-z_$][\w$]*$/u.test(name) || classes.size >= 1024) return;
    const methods = node.body.body.filter(item => item.type === 'MethodDefinition' && !item.static && item.kind === 'method')
      .map(item => !item.computed && item.key.type === 'Identifier' ? item.key.name : item.key.type === 'Literal' && typeof item.key.value === 'string' ? item.key.value : null)
      .filter(value => value !== null).slice(0, 256);
    if (methods.length) classes.set(name, { binding: name, methods });
  };
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ClassDeclaration' && node.id) add(node.id.name, node);
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init?.type === 'ClassExpression') add(node.id.name, node.init);
    if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier' && node.right.type === 'ClassExpression') add(node.left.name, node.right);
    for (const [name, child] of Object.entries(node)) if (name !== 'start' && name !== 'end') {
      if (Array.isArray(child)) child.forEach(walk); else if (child && typeof child === 'object') walk(child);
    }
  };
  walk(ast);
  return [...classes.values()];
}

function observeModules(root, key, dependencies = {}) {
  // Native require resolves directory aliases (for example /var -> /private/var
  // on macOS), while Electron's app path may retain the caller's spelling.
  const roots = [...new Set([path.resolve(root), realpathSync(root)])];
  const prototype = dependencies.prototype ?? Module.prototype;
  const original = prototype._compile;
  const records = new Map(), subscribers = new Set(), instances = new Set(), observedInstances = new WeakSet();
  const finalized=new FinalizationRegistry(ref=>instances.delete(ref));
  let closed = false, instanceDrops = 0;
  const inScope = filename => typeof filename === 'string' && roots.some(root => {
    const relative = path.relative(root, filename);
    return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  });
  const registry = Object.freeze({
    register(filename, hash, exported, evaluate, classes = []) {
      if (closed || records.size >= 4096 || typeof evaluate !== 'function') return;
      const descriptions = Object.freeze(classes.map(item => Object.freeze({binding:item.binding, methods:Object.freeze([...item.methods])})));
      const record = Object.freeze({ filename, name: path.basename(filename), hash, exported, evaluate, classes:descriptions });
      records.set(filename, record);
      for (const callback of subscribers) { try {callback(record);}catch{/* Plugin observation must not abort native module loading. */} }
    },
    list: () => [...records.values()],
    instance(value) {
      if(closed||!value||typeof value!=='object'||observedInstances.has(value))return;
      if(instances.size>=8192){instanceDrops++;return;}
      observedInstances.add(value);const ref=new WeakRef(value);instances.add(ref);finalized.register(value,ref);
    },
    instances(Constructor) { const result=[];for(const ref of instances){const value=ref.deref();if(!value)instances.delete(ref);else if(typeof Constructor==='function'&&value instanceof Constructor)result.push(value);}return result; },
    subscribe(callback) {
      if (closed || typeof callback !== 'function') throw fail('client_bridge_closed');
      subscribers.add(callback);
      for (const record of records.values()) callback(record);
      let live = true;
      return () => { if (live) { live = false; subscribers.delete(callback); } };
    },
    inspect: () => ({ modules: records.size, subscribers: subscribers.size, instanceReferences:instances.size,instanceDrops }),
    close() {
      if (closed) return;
      closed = true; subscribers.clear(); records.clear();instances.clear();
      if (prototype._compile === compile) prototype._compile = original;
      if (globalThis[key] === registry) delete globalThis[key];
    },
  });
  const compile = function(code, filename) {
    if (closed || typeof code !== 'string' || !inScope(filename) || code.length > 20 * 1024 * 1024 || records.size >= 4096) return original.call(this, code, filename);
    const hash = createHash('sha256').update(code).digest('hex');
    const reference=`globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(key))})]`;
    const edits=[]; let classes=[];
    try {
      const ast=acorn.parse(code,{ecmaVersion:'latest',sourceType:'script',allowReturnOutsideFunction:true});
      classes=describeClasses(ast);
      const walk=node=>{if(!node||typeof node!=='object')return;
        if(node.type==='MethodDefinition'&&node.kind==='constructor')edits.push({at:node.value.body.end-1,text:`;${reference}?.instance(this);`});
        for(const [name,child]of Object.entries(node))if(name!=='start'&&name!=='end'){if(Array.isArray(child))child.forEach(walk);else if(child&&typeof child==='object')walk(child);}};
      walk(ast);
    } catch { /* Unsupported syntax still uses the scoped module resolver. */ }
    const registration = `\n;${reference}?.register(${JSON.stringify(filename)},${JSON.stringify(hash)},module.exports,(expression)=>eval(expression),${JSON.stringify(classes)});`;
    let instrumented=code;
    for(const edit of edits.sort((a,b)=>b.at-a.at))instrumented=instrumented.slice(0,edit.at)+edit.text+instrumented.slice(edit.at);
    return original.call(this, instrumented + registration, filename);
  };
  Object.defineProperty(globalThis, key, { value: registry, configurable: true });
  prototype._compile = compile;
  // The inspector pauses after Node has compiled the entry module. A later
  // _compile hook cannot observe that already active frame; capture its live
  // lexical resolver before resuming it, without executing its initializers.
  const entry = dependencies.entry;
  if (entry && inScope(entry.filename) && typeof entry.evaluate === 'function') {
    try {
      const info=statSync(entry.filename);
      if (info.isFile() && info.size <= 20 * 1024 * 1024) {
        const code=readFileSync(entry.filename,'utf8');
        const ast=acorn.parse(code,{ecmaVersion:'latest',sourceType:'script',allowReturnOutsideFunction:true});
        registry.register(entry.filename,createHash('sha256').update(code).digest('hex'),entry.exported,entry.evaluate,describeClasses(ast));
      }
    } catch { /* A missing entry contract only limits its dependent capabilities. */ }
  }
  return registry;
}

function startClientBridge(electron, configuration, dependencies = {}) {
  if (electron.app.isReady() || !/^[a-f0-9]{48}$/.test(configuration?.token)) throw fail('client_bridge_bootstrap_invalid');
  const token = Buffer.from(configuration.token), resources = new Map();
  if (configuration.source) {
    const source = connectPlaintextSource(configuration.source);
    source.ready.catch(() => {});
    resources.set('plaintextSource', source);
  }
  // Routes belong to the owned client's transport, not to a replaceable plugin
  // generation. Keeping them forwarding while hooks retire preserves existing
  // backend pipes and conversations without granting an interceptor authority.
  resources.set('backendState', { owned: new WeakSet(), trust: new WeakMap(), accounts: new WeakMap(), providers: new WeakMap(), records: new Set(), pending: new Set(), prepared: 0 });
  resources.set('desktopState', {taskRoutes: new Set(), routesByProcess: new WeakMap(), sendQueues: new WeakMap()});
  const modules = observeModules(electron.app.getAppPath(), Symbol.for(`codlet.client.modules.${configuration.token}`), dependencies);
  const identity = dependencies.identity ?? (() => ({ pid: process.pid, executable: process.execPath, type: process.type }));
  const load = dependencies.load ?? (code => {
    const module = { exports: {} };
    new Function('module', 'exports', 'require', code)(module, module.exports, require);
    return module.exports;
  });
  let active = null, epoch = 0, closed = false, chain = Promise.resolve(),lastActivation={installed:false,activatedSources:[],unsupportedSources:[]},sourceError=null;
  const receipts = new Map(), receiptFingerprints = new Map(), connections = new Set(), transactions = new Map();
  const writes = createWriteLedger({getEpoch: () => epoch});
  let lease = null, leaseEpoch = 0, leaseTransfer = null;
  let admission = null;
  let fixtureSelection = null;
  const fixtureEvidence=()=>{
    if(configuration.ownedFixtureRoutes!==true)return undefined;
    const value=globalThis[Symbol.for('codlet.owned.online-factory-evidence.v1')];
    if(!value||value.api!==1||typeof value.id!=='string'||!/^[a-f0-9]{64}$/.test(value.id)||typeof value.version!=='string'||value.version.length>64||!value.counts||typeof value.counts!=='object')return null;
    const counts={};for(const [key,descriptor]of Object.entries(Object.getOwnPropertyDescriptors(value.counts)).slice(0,64)){
      if(/^[a-zA-Z0-9._:-]{1,128}$/.test(key)&&'value'in descriptor&&Number.isSafeInteger(descriptor.value)&&descriptor.value>=0&&descriptor.value<=0xffffffff)counts[key]=descriptor.value;
    }return {api:1,id:value.id,version:value.version,counts};
  };
  const context = Object.freeze({ modules, resources,
    trackBackend(record,rule) {
      const state=resources.get('backendState');state.records.add(record);
      let pending='';
      const data=bytes=>{
        pending+=bytes.toString('utf8');
        if(pending.length>128*1024){pending='';return;}
        for(let at=pending.indexOf('\n');at>=0;at=pending.indexOf('\n')){
          const line=pending.slice(0,at);pending=pending.slice(at+1);let payload;try{payload=JSON.parse(line);}catch{continue;}
          if(payload?.[rule.methodKey]!==rule.method)continue;
          const account=state.accounts.get(record.child);if(!account||account.explicit)continue;
          const mode=payload?.[rule.paramsKey]?.[rule.modeKey],upstream=rule.targets?.[mode];
          if(!upstream||account.current===upstream)continue;
          const operation=(account.pending??Promise.resolve()).then(()=>account.route.update({upstreamBaseUrl:upstream})).then(()=>{account.current=upstream;});
          account.pending=operation;operation.catch(()=>account.route.close().catch(()=>{}));operation.finally(()=>{if(account.pending===operation)account.pending=null;}).catch(()=>{});
        }
      };
      let released = false;
      const release=()=>{if(released)return;released=true;record.child.stdout?.off('data',data);record.child.off('exit',release);record.child.off('error',release);for(const route of record.reservations)Promise.resolve(route.close()).catch(()=>{});state.records.delete(record);};
      record.release = release;
      record.child.stdout?.on('data',data);record.child.once('exit',release);record.child.once('error',release);
    },
  });

  const status = () => ({ ...identity(), epoch, owner: active?.owner ?? null, generation: active?.generation ?? null,
    sourceSha256:active?createHash('sha256').update(active.code).digest('hex'):null,coreVersion:active?.coreVersion??null,
    activation: active?.activation ?? lastActivation, sourceError, moduleObserver: modules.inspect(),
    ...(configuration.ownedFixtureRoutes===true?{fixtureFactoryEvidence:fixtureEvidence()}:{}),
    onlineUpdate: {protocol: 1, admissionVersion:1, fixtureExplicitSource:resources.has('ownedFixtureRoute')?{kind:'fixture-explicit-source',registered:true}:null, handoffVersion: active?.runtime.handoffVersion ?? null, writes: writes.inspect(), leaseEpoch,
      admission:admission?{operationId:admission.id,epoch:admission.epoch,phase:admission.phase,lastSourceOutcome:admission.lastSourceOutcome??null}:null,
      retainedCore: ['rust-traffic', 'client-bridge', 'module-observer'], retainedCoreActivation: 'nextStart'} });
  const generationContext = signal => Object.freeze({...context, onlineUpdates: Object.freeze({
    signal, epoch: () => epoch, accepting: () => writes.inspect().accepting,
    execute: (input, handler) => writes.execute(input, handler),
    result: id => writes.result(id),
    receipts: () => writes.receipts(),
    whenAccepting: signal => writes.whenAccepting(signal),
    // Compatibility with older Desktop sources. Native owns these operations,
    // including their cancellation and retry decisions; only explicit Core
    // writes belong in the update ledger. Preserve the operation's exact result.
    run(_method, operation) { return operation(); },
  })});
  async function closeActive() {
    if (!active) return;
    const previous = active;
    const result = await bounded(() => previous.runtime.close(), 'client_bridge_cleanup_timeout');
    if (result === false) throw fail('client_bridge_cleanup_unconfirmed');
    active = null;lastActivation={installed:false,activatedSources:[],unsupportedSources:[]};
  }
  async function install(selection, options = {}) {
    const exported = load(selection.code);
    if (typeof exported.installElectronTraffic !== 'function') throw fail('client_bridge_exports_invalid');
    // A hot replacement validates its profile against captured native modules
    // before retiring the previous package's hooks.
    await bounded(() => exported.validateClientSource?.(electron, context), 'client_bridge_preflight_timeout');
    const configuration = { ...selection.configuration, deadlineUnixMs: Date.now() + 8000 };
    const runtime = exported.installElectronTraffic(electron, configuration, generationContext(options.signal));
    if (!runtime || typeof runtime.ready !== 'function' || typeof runtime.close !== 'function') throw fail('client_bridge_exports_invalid');
    active = { ...selection, configuration, runtime, activation: null };
    try {
      if (options.snapshot !== undefined) await bounded(() => runtime.restore(options.snapshot), 'core_update_restore_timeout');
      active.activation = await bounded(() => runtime.ready(), 'client_bridge_activation_timeout'); if(active.activation?.installed!==true)throw fail('client_bridge_source_unavailable');
      if (options.confirm) {
        const confirmed = await bounded(() => runtime.confirmTakeover(), 'core_update_takeover_timeout');
        if (confirmed !== true) throw fail('core_update_takeover_unconfirmed');
      }
    }
    catch (error) { await closeActive(); throw error; }
    sourceError=null;return active.activation;
  }
  async function compatibleReplace(command) {
    const previous = active;
    const candidate = load(command.code);
    const methods = ['snapshot', 'suspend', 'resume', 'restore', 'confirmTakeover'];
    if(command.drainTimeoutMs!==undefined&&(!Number.isInteger(command.drainTimeoutMs)||command.drainTimeoutMs<1||command.drainTimeoutMs>8000))throw fail('core_update_timeout_invalid');
    if (candidate.handoffVersion !== 1 || previous && (previous.runtime.handoffVersion !== 1 || methods.some(name => typeof previous.runtime[name] !== 'function')))
      throw fail('core_update_next_start_required');
    await bounded(() => candidate.validateClientSource?.(electron, context), 'client_bridge_preflight_timeout');
    const controller = transactions.get(command.operationId);
    const checkCancelled=()=>{if(controller.signal.aborted)throw fail('core_update_cancelled');};
    checkCancelled();
    writes.pause();
    let snapshot, suspended = false;
    try {
      if ((await writes.drain(command.drainTimeoutMs ?? 8000)).length) throw fail('core_update_writes_unsettled');
      checkCancelled();
      if (previous) {
        snapshot = snapshotJson(await bounded(() => previous.runtime.snapshot(), 'core_update_snapshot_timeout'));
        if (await bounded(() => candidate.validateSnapshot?.(snapshot), 'core_update_preflight_timeout') === false) throw fail('core_update_snapshot_incompatible');
        checkCancelled();
        const ack = await bounded(() => previous.runtime.suspend(), 'core_update_suspend_timeout');
        if (ack !== true) throw fail('core_update_suspend_unconfirmed');
        suspended = true;
      }
      active = null;
      epoch++;
      await install(command, {snapshot, signal: controller.signal, confirm: true});
      checkCancelled();
      // Previous hooks have already released authority, but their rollback state
      // remains live until the replacement confirms restoration and takeover.
      if (previous) {
        try { await bounded(() => previous.runtime.close(), 'core_update_retire_timeout'); }
        catch { return {outcome: 'applied', retirement: 'pending', ...status()}; }
      }
      return {outcome: 'applied', retirement: 'confirmed', snapshotRestored: previous !== null, ...status()};
    } catch (error) {
      controller.abort();
      if (!suspended) {
        if(!previous&&active===null)return {outcome:'degraded',error:codeOf(error),...status()};
        throw error;
      }
      if (active) await closeActive();
      active = previous;
      try {
        const restored = await bounded(() => previous.runtime.resume(snapshot), 'core_update_rollback_timeout');
        if (restored !== true) throw fail('core_update_rollback_unconfirmed');
        return {outcome: 'rolled_back', error: codeOf(error), ...status()};
      } catch { return {outcome: 'degraded', error: 'core_update_restoration_failed', ...status()}; }
    } finally { if(!admission)writes.resume(); }
  }
  const acceptedReceipts=()=>writes.receipts().map(({operationId,epoch,pending,outcome})=>({operationId,epoch,pending,outcome}));
  async function ownedFixtureRoute(command) {
    if(configuration.ownedFixtureRoutes!==true)throw fail('core_fixture_unavailable');
    if(closed||command.expectedEpoch!==epoch||admission)throw fail('core_fixture_not_ready');
    if(fixtureSelection)throw fail('core_fixture_already_used');
    const value=command.upstreamBaseUrl;
    if(typeof value!=='string'||value.length>256||!/^http:\/\/127\.0\.0\.1:[0-9]{4,5}(?:\/[A-Za-z0-9_/-]*)?$/.test(value))throw fail('core_fixture_upstream_invalid');
    const url=new URL(value);if(!url.port||Number(url.port)<1024||url.search||url.hash||url.username||url.password)throw fail('core_fixture_upstream_invalid');
    const source=resources.get('plaintextSource');if(!source||typeof source.reserveRoute!=='function')throw fail('core_fixture_source_unavailable');
    fixtureSelection=Object.freeze({operationId:command.operationId,upstream:value});
    const route=source.reserveRoute({upstreamBaseUrl:value});
    try {await bounded(()=>route.ready,'core_fixture_route_timeout');}catch(error){await Promise.resolve(route.close()).catch(()=>{});throw error;}
    resources.set('ownedFixtureRoute',route);
    return {outcome:'fixture_route_registered',kind:'fixture-explicit-source',routeBaseUrl:route.baseUrl,...status()};
  }
  async function beginAdmission(command) {
    if(closed||command.expectedEpoch!==epoch)throw fail('client_bridge_stale_epoch');
    if(admission)throw fail('core_admission_owner_busy');
    if(command.drainTimeoutMs!==undefined&&(!Number.isInteger(command.drainTimeoutMs)||command.drainTimeoutMs<1||command.drainTimeoutMs>8000))throw fail('core_update_timeout_invalid');
    admission={id:command.operationId,token:randomUUID(),epoch,originSha256:status().sourceSha256,phase:'draining'};
    writes.pause();
    const unsettled=await writes.drain(command.drainTimeoutMs??8000);
    admission.phase=unsettled.length?'blocked':'held';
    return {outcome:unsettled.length?'blocked':'held',admissionToken:admission.token,admissionHeld:true,acceptedReceipts:acceptedReceipts(),
      ...(unsettled.length?{error:'core_update_writes_unsettled'}:{}),...status()};
  }
  async function finishAdmission(command) {
    if(closed||command.expectedEpoch!==epoch)throw fail('client_bridge_stale_epoch');
    if(!admission||command.admissionId!==admission.id||command.admissionToken!==admission.token)throw fail('core_admission_owner_changed');
    if(!['applied','rolled_back'].includes(command.disposition))throw fail('core_admission_disposition_invalid');
    if(command.disposition==='applied'&&admission.lastSourceOutcome!=='applied')throw fail('core_admission_source_unconfirmed');
    if(command.disposition==='rolled_back'&&(status().sourceSha256!==admission.originSha256||!['applied','rejected','rolled_back',undefined].includes(admission.lastSourceOutcome)))throw fail('core_admission_source_unconfirmed');
    const id=admission.id;admission=null;writes.resume();
    return {outcome:'admission_resumed',admissionId:id,disposition:command.disposition,acceptedReceipts:acceptedReceipts(),...status()};
  }
  async function replace(command) {
    if (closed || command.expectedEpoch !== epoch) throw fail('client_bridge_stale_epoch');
    if(command.op==='ready') {
      if(epoch!==0)throw fail('client_bridge_initial_state_invalid');
      await bridge.ready();return {outcome:'applied',...status()};
    }
    const previous = active && { owner: active.owner, generation: active.generation, code: active.code, configuration: active.configuration };
    if (command.op === 'replace' && (!label(command.owner) || !Number.isSafeInteger(command.generation) || command.generation < 1
      || typeof command.code !== 'string' || Buffer.byteLength(command.code) > MAX_FRAME / 2)) throw fail('client_bridge_selection_invalid');
    if (active && command.previousOwner !== active.owner) throw fail('client_bridge_owner_changed');
    if(admission&&(command.compatibleUpdate!==true||command.admissionId!==admission.id||command.admissionToken!==admission.token))throw fail('core_admission_owner_changed');
    if(!admission&&command.admissionId)throw fail('core_admission_owner_changed');
    if (command.op === 'replace' && command.compatibleUpdate === true) return compatibleReplace(command);
    // Preflight must happen before disposal, including when the replacement's
    // module fingerprints do not match the currently running client.
    if (command.op === 'replace') await bounded(() => load(command.code).validateClientSource?.(electron, context), 'client_bridge_preflight_timeout');
    await closeActive();
    epoch++;
    if (command.op === 'clear') return { outcome: 'applied', ...status() };
    try { await install(command); return { outcome: 'applied', ...status() }; }
    catch (error) {
      if (active) await closeActive();
      if (previous) {
        try { await install(previous); return { outcome: 'rolled_back', error: error.code ?? 'client_bridge_activation_failed', ...status() }; }
        catch { return { outcome: 'degraded', error: 'client_bridge_restoration_failed', ...status() }; }
      }
      return { outcome: 'degraded', error: error.code ?? 'client_bridge_activation_failed', ...status() };
    }
  }
  async function command(input) {
    if (input.op === 'status') return input.operationId ? receipts.get(input.operationId) ?? { pending: false, unknown: true } : status();
    if (input.op === 'writeResult') return {...writes.result(input.operationId), ...identity()};
    if (input.op === 'writeReceipts') return {receipts:writes.receipts(),...identity()};
    if (input.op === 'cancelWrite') return {...writes.cancel(input.operationId), ...identity()};
    if (input.op === 'write') {
      if (!label(input.method) || input.operationId?.startsWith('native.') || typeof active?.runtime.handleWrite !== 'function') throw fail('core_write_method_unavailable');
      const runtime = active.runtime;
      return {...writes.accept(input, (params, metadata) => runtime.handleWrite(input.method, params, metadata)), ...identity()};
    }
    if (input.op === 'prepareLeaseTransfer') {
      if(leaseTransfer&&leaseTransfer.expires<Date.now())leaseTransfer=null;
      if (!lease || input.expectedLeaseEpoch !== leaseEpoch || leaseTransfer) throw fail('core_update_lease_changed');
      leaseTransfer = {id: randomUUID(), expires: Date.now() + 15000, epoch: leaseEpoch};
      return {transferId: leaseTransfer.id, expires: leaseTransfer.expires, ...status()};
    }
    if(input.op==='abortLeaseTransfer') {
      if(!leaseTransfer||input.transferId!==leaseTransfer.id||input.expectedLeaseEpoch!==leaseEpoch)throw fail('core_update_lease_changed');
      leaseTransfer=null;return {outcome:'aborted',...status()};
    }
    if (input.op === 'cancelUpdate') {
      const transaction=transactions.get(input.operationId);
      if(transaction){transaction.abort();return {outcome:'cancellation_requested',...status()};}
      return receipts.get(input.operationId)??{outcome:'unknown',unknown:true,...status()};
    }
    if(input.op==='preflightCore') {
      if(input.expectedEpoch!==epoch||typeof input.code!=='string'||Buffer.byteLength(input.code)>MAX_FRAME/2)throw fail('client_bridge_stale_epoch');
      const candidate=load(input.code);
      if(candidate.handoffVersion!==1||active&&active.runtime.handoffVersion!==1)throw fail('core_update_next_start_required');
      await bounded(()=>candidate.validateClientSource?.(electron,context),'client_bridge_preflight_timeout');
      if(active){const snapshot=snapshotJson(await bounded(()=>active.runtime.snapshot(),'core_update_snapshot_timeout'));
        if(await bounded(()=>candidate.validateSnapshot?.(snapshot),'core_update_preflight_timeout')===false)throw fail('core_update_snapshot_incompatible');}
      return {outcome:'preflight_passed',...status()};
    }
    if (!label(input.operationId) || !['replace', 'clear', 'ready','beginAdmission','finishAdmission','ownedFixtureRoute'].includes(input.op)) throw fail('client_bridge_request_invalid');
    const fingerprint=createHash('sha256').update(JSON.stringify([input.op,input.expectedEpoch,input.previousOwner,input.owner,input.generation,input.code,input.configuration,input.compatibleUpdate,input.coreVersion,input.drainTimeoutMs,input.admissionId,input.admissionToken,input.disposition,input.upstreamBaseUrl])).digest('hex');
    if (receipts.has(input.operationId)) {
      if(receiptFingerprints.get(input.operationId)!==fingerprint)throw fail('client_bridge_operation_id_conflict');
      return receipts.get(input.operationId);
    }
    // Never evict an operation while it is running, and never forget an outcome
    // then silently accept the same ID as a fresh side effect.
    if (receipts.size >= 4096) throw fail('client_bridge_receipt_capacity');
    receipts.set(input.operationId, { pending: true });
    receiptFingerprints.set(input.operationId,fingerprint);
    transactions.set(input.operationId,new AbortController());
    const operation = chain.then(() => input.op==='beginAdmission'?beginAdmission(input):input.op==='finishAdmission'?finishAdmission(input):input.op==='ownedFixtureRoute'?ownedFixtureRoute(input):replace(input)).catch(error => ({ outcome: 'rejected', error: codeOf(error), ...status() }));
    chain = operation.then(() => {});
    const result = await operation;
    if(admission&&input.op==='replace'&&input.admissionId===admission.id)admission.lastSourceOutcome=result.outcome;
    receipts.set(input.operationId, result);
    transactions.delete(input.operationId);
    return result;
  }
  const server = net.createServer(socket => {
    if (closed || socket.remoteAddress !== '127.0.0.1' || connections.size >= 4) { dependencies.diagnostic?.('peer_rejected');socket.destroy(); return; }
    connections.add(socket); let pending = Buffer.alloc(0), accepted = false;
    socket.setTimeout(12000, () => socket.destroy());
    socket.on('error', () => {}); socket.on('close', () => connections.delete(socket));
    socket.on('data', bytes => {
      if (accepted || pending.length + bytes.length > MAX_FRAME) { dependencies.diagnostic?.('frame_rejected');socket.destroy(); return; }
      pending = Buffer.concat([pending, bytes]);
      const end = pending.indexOf(10); if (end < 0) return;
      if (end !== pending.length - 1) { dependencies.diagnostic?.('newline_rejected');socket.destroy(); return; }
      let input; try { input = JSON.parse(pending.subarray(0, end)); } catch { socket.destroy(); return; }
      if (!input || typeof input !== 'object' || Array.isArray(input)) { socket.destroy(); return; }
      const candidate = Buffer.from(typeof input.token === 'string' ? input.token : '');
      if (candidate.length !== token.length || !timingSafeEqual(candidate, token)) { dependencies.diagnostic?.('auth_rejected');socket.destroy(); return; }
      accepted = true;
      if(input.op==='lease') {
        if (lease) {
          if (!leaseTransfer || input.transferId !== leaseTransfer.id || leaseTransfer.expires < Date.now() || input.expectedLeaseEpoch !== leaseEpoch) {socket.destroy();return;}
          leaseTransfer = null; leaseEpoch++;
        } else if (input.transferId) {socket.destroy();return;}
        lease=socket;socket.setTimeout(0);socket.write(JSON.stringify({ok:true,result:{leased:true,...status()}})+'\n');
        socket.once('close',()=>{if(lease===socket){lease=null;bridge.close().catch(()=>{});}});return;
      }
      command(input).then(result => socket.end(JSON.stringify({ ok: true, result }) + '\n'), error => {
        const code = codeOf(error);
        socket.end(JSON.stringify({ ok: false, code }) + '\n');
      });
    });
  });
  const listening = new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const bridge=Object.freeze({
    async endpoint() { await listening; return { version: 1, host: '127.0.0.1', port: server.address().port, token: configuration.token, ...identity() }; },
    async installInitial(selection) {
      if (active || epoch !== 0) throw fail('client_bridge_initial_state_invalid');
      if (!selection) return;
      // Before entry, native lazy bindings and children are still being created.
      // Install synchronously; readiness is awaited after the client is resumed.
      const exported = load(selection.code);
      if (typeof exported.installElectronTraffic !== 'function') throw fail('client_bridge_exports_invalid');
      const configuration = { ...selection.configuration, deadlineUnixMs: Date.now() + 5000 };
      const runtime = exported.installElectronTraffic(electron, configuration, generationContext());
      if (!runtime || typeof runtime.ready !== 'function' || typeof runtime.close !== 'function') throw fail('client_bridge_exports_invalid');
      active = { ...selection, configuration, runtime, activation: null };
    },
    async ready() { await listening; if (active) {
      // Initial Native module loading has its own bounded readiness phase.
      // Hot replacement operations retain the ordinary ten-second budget.
      let activation;try{activation=await bounded(() => active.runtime.ready(), 'client_bridge_activation_timeout', 40000);}catch(error){sourceError=codeOf(error);activation={installed:false,activatedSources:[],unsupportedSources:[{id:'client-source',reason:'hook_unavailable'}]};}
      if(!activation?.installed){sourceError??='client_bridge_source_unavailable';await closeActive();lastActivation=activation;}else {active.activation=activation;sourceError=null;}
    } return status(); },
    inspect: status,
    closeInspector() { setTimeout(()=>require('node:inspector').close(),50);return true; },
    async close() {
      if (closed) return;
      closed = true;
      writes.close();
      try { await chain; await closeActive(); }
      finally {
        modules.close();
        for (const socket of connections) socket.destroy();
        await listening.catch(() => {});
        await new Promise(resolve => server.close(resolve));
        for (const record of resources.get('backendState').records) record.release();
        for (const route of resources.get('desktopState').taskRoutes) await Promise.resolve(route.close()).catch(()=>{});
        await Promise.resolve(resources.get('ownedFixtureRoute')?.close()).catch(()=>{});
        resources.get('desktopState').scope?.disable();
        resources.get('plaintextSource')?.close(); resources.clear();
      }
    },
  });
  return bridge;
}
module.exports = { startClientBridge, observeModules };
