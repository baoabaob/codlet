'use strict';
// Core-owned transport and CommonJS observation. No client symbols or profiles.
const net = require('node:net');
const path = require('node:path');
const Module = require('node:module');
const { createHash, timingSafeEqual } = require('node:crypto');
const { connectPlaintextSource } = require('./plaintext-source-client.cjs');
const acorn = require('acorn');
const MAX_FRAME = 2 * 1024 * 1024;
const fail = code => Object.assign(new Error(code), { code });
const label = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value);
const codeOf = error => /^[a-z_]{1,80}$/.test(error?.code) ? error.code : 'client_bridge_operation_failed';
async function bounded(operation, code) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
      timer = setTimeout(() => reject(fail(code)), 10000);
    })]);
  } finally { clearTimeout(timer); }
}

function observeModules(root, key, dependencies = {}) {
  const prototype = dependencies.prototype ?? Module.prototype;
  const original = prototype._compile;
  const records = new Map(), subscribers = new Set(), instances = new Set();
  const finalized=new FinalizationRegistry(ref=>instances.delete(ref));
  let closed = false;
  const registry = Object.freeze({
    register(filename, hash, exported, evaluate) {
      if (closed || records.size >= 4096 || typeof evaluate !== 'function') return;
      const record = Object.freeze({ filename, name: path.basename(filename), hash, exported, evaluate });
      records.set(filename, record);
      for (const callback of subscribers) { try {callback(record);}catch{/* Plugin observation must not abort native module loading. */} }
    },
    list: () => [...records.values()],
    instance(value) { if(!closed&&value&&typeof value==='object'&&instances.size<8192){const ref=new WeakRef(value);instances.add(ref);finalized.register(value,ref);} },
    instances(Constructor) { const result=[];for(const ref of instances){const value=ref.deref();if(!value)instances.delete(ref);else if(typeof Constructor==='function'&&value instanceof Constructor)result.push(value);}return result; },
    subscribe(callback) {
      if (closed || typeof callback !== 'function') throw fail('client_bridge_closed');
      subscribers.add(callback);
      for (const record of records.values()) callback(record);
      let live = true;
      return () => { if (live) { live = false; subscribers.delete(callback); } };
    },
    inspect: () => ({ modules: records.size, subscribers: subscribers.size }),
    close() {
      if (closed) return;
      closed = true; subscribers.clear(); records.clear();instances.clear();
      if (prototype._compile === compile) prototype._compile = original;
      if (globalThis[key] === registry) delete globalThis[key];
    },
  });
  const compile = function(code, filename) {
    const relative = typeof filename === 'string' ? path.relative(root, filename) : '..';
    if (closed || typeof code !== 'string' || !relative || relative.startsWith('..') || path.isAbsolute(relative)
      || code.length > 20 * 1024 * 1024 || records.size >= 4096) return original.call(this, code, filename);
    const hash = createHash('sha256').update(code).digest('hex');
    const reference=`globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(key))})]`;
    const registration = `\n;${reference}?.register(${JSON.stringify(filename)},${JSON.stringify(hash)},module.exports,(expression)=>eval(expression));`;
    const edits=[];
    try {
      const ast=acorn.parse(code,{ecmaVersion:'latest',sourceType:'script',allowReturnOutsideFunction:true});
      const walk=node=>{if(!node||typeof node!=='object')return;
        if(node.type==='MethodDefinition'&&node.kind==='constructor')edits.push({at:node.value.body.end-1,text:`;${reference}?.instance(this);`});
        for(const [name,child]of Object.entries(node))if(name!=='start'&&name!=='end'){if(Array.isArray(child))child.forEach(walk);else if(child&&typeof child==='object')walk(child);}};
      walk(ast);
    } catch { /* Unsupported syntax still uses the scoped module resolver. */ }
    let instrumented=code;
    for(const edit of edits.sort((a,b)=>b.at-a.at))instrumented=instrumented.slice(0,edit.at)+edit.text+instrumented.slice(edit.at);
    return original.call(this, instrumented + registration, filename);
  };
  Object.defineProperty(globalThis, key, { value: registry, configurable: true });
  prototype._compile = compile;
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
  const modules = observeModules(electron.app.getAppPath(), Symbol.for(`codlet.client.modules.${configuration.token}`), dependencies);
  const identity = dependencies.identity ?? (() => ({ pid: process.pid, executable: process.execPath, type: process.type }));
  const load = dependencies.load ?? (code => {
    const module = { exports: {} };
    new Function('module', 'exports', 'require', code)(module, module.exports, require);
    return module.exports;
  });
  let active = null, epoch = 0, closed = false, chain = Promise.resolve(),lastActivation={installed:false,activatedSources:[],unsupportedSources:[]},sourceError=null;
  const receipts = new Map(), connections = new Set();let leased=false;
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
    activation: active?.activation ?? lastActivation, sourceError, moduleObserver: modules.inspect() });
  async function closeActive() {
    if (!active) return;
    const previous = active;
    const result = await bounded(() => previous.runtime.close(), 'client_bridge_cleanup_timeout');
    if (result === false) throw fail('client_bridge_cleanup_unconfirmed');
    active = null;lastActivation={installed:false,activatedSources:[],unsupportedSources:[]};
  }
  async function install(selection) {
    const exported = load(selection.code);
    if (typeof exported.installElectronTraffic !== 'function') throw fail('client_bridge_exports_invalid');
    // A hot replacement validates its profile against captured native modules
    // before retiring the previous package's hooks.
    await bounded(() => exported.validateClientSource?.(electron, context), 'client_bridge_preflight_timeout');
    const configuration = { ...selection.configuration, deadlineUnixMs: Date.now() + 8000 };
    const runtime = exported.installElectronTraffic(electron, configuration, context);
    if (!runtime || typeof runtime.ready !== 'function' || typeof runtime.close !== 'function') throw fail('client_bridge_exports_invalid');
    active = { ...selection, configuration, runtime, activation: null };
    try { active.activation = await bounded(() => runtime.ready(), 'client_bridge_activation_timeout'); if(active.activation?.installed!==true)throw fail('client_bridge_source_unavailable'); }
    catch (error) { await closeActive(); throw error; }
    sourceError=null;return active.activation;
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
    if (!label(input.operationId) || !['replace', 'clear', 'ready'].includes(input.op)) throw fail('client_bridge_request_invalid');
    if (receipts.has(input.operationId)) return receipts.get(input.operationId);
    if (receipts.size >= 128) receipts.delete(receipts.keys().next().value);
    receipts.set(input.operationId, { pending: true });
    const operation = chain.then(() => replace(input)).catch(error => ({ outcome: 'rejected', error: codeOf(error), ...status() }));
    chain = operation.then(() => {});
    const result = await operation;
    receipts.set(input.operationId, result);
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
        if(leased){socket.destroy();return;}
        leased=true;socket.setTimeout(0);socket.write(JSON.stringify({ok:true,result:{leased:true,...status()}})+'\n');
        socket.once('close',()=>bridge.close().catch(()=>{}));return;
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
      const runtime = exported.installElectronTraffic(electron, configuration, context);
      if (!runtime || typeof runtime.ready !== 'function' || typeof runtime.close !== 'function') throw fail('client_bridge_exports_invalid');
      active = { ...selection, configuration, runtime, activation: null };
    },
    async ready() { await listening; if (active) {
      let activation;try{activation=await bounded(() => active.runtime.ready(), 'client_bridge_activation_timeout');}catch(error){sourceError=codeOf(error);activation={installed:false,activatedSources:[],unsupportedSources:[{id:'client-source',reason:'hook_unavailable'}]};}
      if(!activation?.installed){sourceError??='client_bridge_source_unavailable';await closeActive();lastActivation=activation;}else {active.activation=activation;sourceError=null;}
    } return status(); },
    inspect: status,
    closeInspector() { setTimeout(()=>require('node:inspector').close(),50);return true; },
    async close() {
      if (closed) return;
      closed = true;
      try { await chain; await closeActive(); }
      finally {
        modules.close();
        for (const socket of connections) socket.destroy();
        await listening.catch(() => {});
        await new Promise(resolve => server.close(resolve));
        for (const record of resources.get('backendState').records) record.release();
        resources.get('plaintextSource')?.close(); resources.clear();
      }
    },
  });
  return bridge;
}
module.exports = { startClientBridge, observeModules };
