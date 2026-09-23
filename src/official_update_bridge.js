// Executed only by Core in its owned, audited main renderer. No new service
// connection is created. Read the existing official AppScope update signal.
(async () => {
  const profiles = __CODLET_PROFILES__, action = __CODLET_ACTION__;
  const detected = globalThis.electronBridge?.getSentryInitOptions?.();
  const entries = new Set(Array.from(document.scripts, script => script.src));
  const matchesByEntry = profiles.builds.filter(p => p.appVersion === detected?.appVersion && p.buildNumber === String(detected?.buildNumber) && entries.has(p.entry));
  const profile = matchesByEntry.length === 1 ? matchesByEntry[0] : null;
  if (window !== window.top || location.origin !== 'app://-' || location.pathname !== '/index.html' || !profile?.officialUpdates) return {available:false,reason:'profile'};
  const module = await import(profile.module), scopeModule = profile.scopeModule ? await import(profile.scopeModule) : module;
  const token = scopeModule[profile.exports.scope];
  const root = document.getElementById('root'), key = root && Object.keys(root).find(k => k.startsWith('__reactContainer$'));
  const container = key && root[key], pending = [container?.stateNode?.current ?? container], seen = new Set();
  let node,chain;
  while (pending.length && seen.size < 4096) {
    const fiber = pending.pop(); if (!fiber || seen.has(fiber)) continue; seen.add(fiber);
    const current = fiber.memoizedProps?.value, candidate = current instanceof Map && current.get(token?.id);
    if (candidate?.token === token && candidate.familyBindings instanceof Map && candidate.store) { node = candidate; chain = current; break; }
    if (fiber.child) pending.push(fiber.child); if (fiber.sibling) pending.push(fiber.sibling);
  }
  const selector = module[profile.officialUpdates.stateSelector];
  if (!node || selector?.scope !== token || typeof selector.resolve !== 'function') return {available:false,reason:'scope'};
  const matches = [];
  // Read the audited selector's existing update dependency; no atom writes or
  // additional application service connection is created.
  selector.resolve(node,chain).read(atom => {
    const value = node.store.get(atom);
    if (value && typeof value.isUpdateReady === 'boolean' && ['idle','checking','downloading','ready','installing'].includes(value.lifecycleState) && 'downloadProgressPercent' in value && 'installProgressPercent' in value && 'relaunchNotice' in value && typeof value.supportsAutoInstallWhenIdle === 'boolean') matches.push(value);
    return value;
  });
  const services = module[profile.exports.services];
  if (matches.length !== 1 || typeof services?.appUpdates?.installUpdate !== 'function') return {available:false,reason:'state'};
  const value = matches[0];
  const result = {available:true,phase:value.lifecycleState,isUpdateReady:value.isUpdateReady};
  if (action.kind === 'retire') {
    const key = Symbol.for('codlet.core.official-install');
    if (globalThis[key] === action.id && ['idle','ready'].includes(value.lifecycleState)) delete globalThis[key];
    return result;
  }
  if (action.kind === 'install') {
    const key = Symbol.for('codlet.core.official-install');
    if (globalThis[key]) return {...result,accepted:globalThis[key] === action.id};
    if (value.lifecycleState !== 'ready' || !value.isUpdateReady) return {...result,accepted:false};
    // Reserve before invoking. A lost reply must never issue a second install.
    globalThis[key] = action.id;
    await services.appUpdates.installUpdate();
    return {...result,accepted:true};
  }
  return result;
})()
