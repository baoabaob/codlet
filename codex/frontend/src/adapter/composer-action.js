/**
 * Reviewed Codex composer action outlet. A consumer owns a DOM lease with its
 * Core-authenticated plugin ID and generation; the adapter renders one button
 * into every current composer and dispatches click events back to that lease.
 * No consumer JavaScript object crosses worlds or changes native React state.
 */
export const COMPOSER_CAPABILITY = Object.freeze({ name: 'codex.ui.composer.action', api: 1, scope: 'target' });
export const COMPOSER_EVENT = 'codlet:composer-action';
const fail = (code, message) => Object.assign(new Error(message), { code });
const TOKEN = /^[a-zA-Z0-9-]{16,80}$/;
const PLACEMENT = /^[a-zA-Z0-9_-]{1,40}$/;

function owner(args, invocation) {
  const caller = invocation?.caller;
  if (!caller || typeof caller.pluginId !== 'string' || !Number.isSafeInteger(caller.generation))
    throw fail('invalid_owner', 'Composer action registration requires a Core-authenticated caller');
  if (!args || Object.keys(args).some(key => !['label', 'token'].includes(key)) ||
      typeof args.label !== 'string' || !args.label.trim() || args.label.length > 48 ||
      typeof args.token !== 'string' || !TOKEN.test(args.token))
    throw fail('invalid_argument', 'Invalid composer action registration');
  const matches = [...document.querySelectorAll('[data-codlet-composer-action-lease]')]
    .filter(node => node.dataset.codletComposerActionLease === args.token);
  if (matches.length !== 1 || matches[0].dataset.codletComposerActionOwner !== caller.pluginId ||
      matches[0].dataset.codletGeneration !== String(caller.generation))
    throw fail('invalid_owner', 'Composer action lease does not match its caller');
  return { caller, lease: matches[0] };
}

function key(caller, token) { return `${caller.pluginId}\0${token}`; }
function ownedMutation(node) {
  return node?.nodeType === 1 && (node.matches?.('[data-codlet-composer-action-instance], [data-codlet-composer-action-style], [data-codlet-composer-action-lease]') ||
    node.closest?.('[data-codlet-composer-action-instance]'));
}

export function createComposerActions(context, host, profile) {
  const entries = new Map();
  const instances = new Map();
  const rootSelector = profile?.rootAttribute ? `[${profile.rootAttribute}]` : null;
  const areaSelector = profile?.scrollAreaAttribute ? `[${profile.scrollAreaAttribute}]` : null;
  let alive = true, pending = false, style, nextInstance = 1;
  const supported = !!(rootSelector && areaSelector && !host.auxiliary);
  const hostLive = () => document.getElementById('root') === host.rootNode && host.rootNode.isConnected;
  const live = entry => entry.lease.isConnected && entry.lease.dataset.codletComposerActionOwner === entry.caller.pluginId &&
    entry.lease.dataset.codletGeneration === String(entry.caller.generation) &&
    entry.lease.dataset.codletComposerActionLease === entry.token;
  const removeInstance = record => { record.container.remove(); instances.delete(record.id); };
  const retire = entry => {
    if (!entries.delete(key(entry.caller, entry.token))) return;
    for (const record of [...instances.values()]) if (record.entry === entry) removeInstance(record);
  };
  function placements() {
    if (!supported || !hostLive()) return [];
    const result = [];
    for (const root of host.rootNode.querySelectorAll(rootSelector)) {
      const placement = root.getAttribute('data-composer-placement');
      if (!PLACEMENT.test(placement || '')) continue;
      const areas = [...root.querySelectorAll(areaSelector)].filter(area => area.closest(rootSelector) === root);
      if (areas.length !== 1 || areas[0].getAttribute('role') !== 'group' ||
          areas[0].children.length !== 1 || areas[0].firstElementChild?.tagName !== 'DIV') continue;
      result.push({ root, placement, outlet: areas[0].firstElementChild });
    }
    return result;
  }
  function ensureStyle() {
    if (style?.isConnected) return;
    style = document.createElement('style');
    style.dataset.codletComposerActionStyle = '1';
    style.textContent = `[data-codlet-composer-action-instance] button{display:inline-flex;align-items:center;min-height:28px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:12px;white-space:nowrap;cursor:pointer}
[data-codlet-composer-action-instance] button:hover{background:color-mix(in srgb,currentColor 8%,transparent)}
[data-codlet-composer-action-instance] button:focus-visible{outline:2px solid currentColor;outline-offset:2px}`;
    document.head.append(style);
  }
  function mount(entry, placement, index) {
    const id = `${key(entry.caller, entry.token)}\0${index}`;
    let record = instances.get(id);
    if (record && record.root !== placement.root) { removeInstance(record); record = null; }
    if (!record) {
      const container = document.createElement('span');
      container.dataset.codletComposerActionInstance = entry.token;
      const instance = `action-${nextInstance++}`;
      container.dataset.codletComposerActionInstanceId = instance;
      container.dataset.codletComposerActionOwner = entry.caller.pluginId;
      container.dataset.codletGeneration = String(entry.caller.generation);
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = entry.label;
      button.setAttribute('aria-label', entry.label);
      button.addEventListener('click', () => {
        if (!alive || !live(entry) || !hostLive() || !record.root.isConnected ||
            record.outlet !== placements().find(item => item.root === record.root)?.outlet) return;
        entry.lease.dispatchEvent(new CustomEvent(COMPOSER_EVENT, {
          detail: JSON.stringify({ api: 1, token: entry.token, placement: record.placement, instance: record.instance }), bubbles: false
        }));
      });
      container.append(button);
      record = { id, instance, entry, root: placement.root, outlet: placement.outlet, placement: placement.placement, container, button };
      instances.set(id, record);
    }
    record.placement = placement.placement;
    if (record.button.textContent !== entry.label) record.button.textContent = entry.label;
    if (record.button.getAttribute('aria-label') !== entry.label) record.button.setAttribute('aria-label', entry.label);
    if (record.container.parentElement !== placement.outlet) placement.outlet.append(record.container);
  }
  function reconcile() {
    if (!alive) return;
    for (const entry of [...entries.values()]) if (!live(entry)) retire(entry);
    const current = placements();
    const roots = new Set(current.map(item => item.root));
    for (const record of [...instances.values()])
      if (!roots.has(record.root) || record.outlet !== current.find(item => item.root === record.root)?.outlet || !entries.has(key(record.entry.caller, record.entry.token)))
        removeInstance(record);
    if (!entries.size || !current.length) { if (!entries.size) { style?.remove(); style = null; } return; }
    ensureStyle();
    const ordered = [...entries.values()].sort((a, b) => a.caller.pluginId.localeCompare(b.caller.pluginId) || a.token.localeCompare(b.token));
    for (const [index, placement] of current.entries()) for (const entry of ordered) mount(entry, placement, index);
  }
  const schedule = records => {
    if (!alive || pending) return;
    const relevant = records.some(record => {
      if (record.type === 'attributes') return record.target.matches?.(rootSelector) || record.target.matches?.(areaSelector) ||
        record.target.closest?.(rootSelector) || [...instances.values()].some(item => item.root === record.target || item.outlet.parentElement === record.target);
      const nodes = [...record.addedNodes, ...record.removedNodes];
      if (nodes.length && nodes.every(ownedMutation)) return true;
      if (record.target.closest?.(rootSelector)) return true;
      return nodes.some(node => node.nodeType === 1 &&
        (node.matches?.(rootSelector) || node.querySelector?.(rootSelector) ||
         node.matches?.('[data-codlet-composer-action-lease]') || node.querySelector?.('[data-codlet-composer-action-lease]')));
    });
    if (!relevant) return;
    pending = true;
    queueMicrotask(() => { pending = false; reconcile(); });
  };
  const observer = supported ? new MutationObserver(schedule) : null;
  observer?.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
    attributeFilter: [...new Set(['data-composer-placement', 'role', profile.rootAttribute, profile.scrollAreaAttribute])] });
  return {
    register(args, invocation) {
      if (!alive || invocation?.signal?.aborted) throw fail('ui_retired', 'Composer action provider retired');
      const { caller, lease } = owner(args, invocation);
      if (!supported) { lease.remove(); return { api: 1, token: args.token, available: false, reason: 'unsupported_build' }; }
      const id = key(caller, args.token), existing = entries.get(id);
      if (existing) {
        if (existing.lease !== lease || existing.caller.generation !== caller.generation) retire(existing);
        else { existing.label = args.label.trim(); reconcile(); return { api: 1, token: args.token, available: true, mounted: [...instances.values()].filter(record => record.entry === existing).length }; }
      }
      if (entries.size >= 32 || [...entries.values()].filter(entry => entry.caller.pluginId === caller.pluginId).length >= 8)
        throw fail('resource_limit', 'Too many composer actions');
      const entry = { caller, lease, token: args.token, label: args.label.trim() };
      entries.set(id, entry); reconcile();
      return { api: 1, token: entry.token, available: true, mounted: [...instances.values()].filter(record => record.entry === entry).length };
    },
    unregister(args, invocation) {
      const caller = invocation?.caller;
      if (!caller || typeof caller.pluginId !== 'string' || !Number.isSafeInteger(caller.generation) ||
          !args || Object.keys(args).some(key => key !== 'token') || typeof args.token !== 'string' || !TOKEN.test(args.token))
        throw fail('invalid_argument', 'Invalid composer action removal');
      const entry = entries.get(key(caller, args.token));
      if (!entry || entry.caller.generation !== caller.generation) return { removed: false };
      retire(entry); reconcile(); return { removed: true };
    },
    status(args, invocation) {
      const caller = invocation?.caller;
      if (!caller || typeof caller.pluginId !== 'string' || !Number.isSafeInteger(caller.generation) ||
          !args || Object.keys(args).some(key => key !== 'token') || typeof args.token !== 'string' || !TOKEN.test(args.token))
        throw fail('invalid_argument', 'Invalid composer action status');
      const entry = entries.get(key(caller, args.token));
      if (!entry || entry.caller.generation !== caller.generation) return { registered: false, mounted: 0 };
      reconcile();
      return { registered: entries.has(key(caller, args.token)), mounted: [...instances.values()].filter(record => record.entry === entry).length };
    },
    dispose() {
      if (!alive) return;
      alive = false; observer?.disconnect();
      for (const entry of [...entries.values()]) retire(entry);
      style?.remove(); style = null;
    }
  };
}

export function composerLease(args, invocation) { return owner(args, invocation); }
