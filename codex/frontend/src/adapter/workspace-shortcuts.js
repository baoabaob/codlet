import { ancestry, OWNED, providersFor, wrapProviders, workspaceError } from './workspace-dom.js';
import { componentSource } from '../host-discovery.js';

const allowed = ['id', 'label', 'description', 'accelerator', 'defaultAccelerator', 'onInvoke', 'onChange'];
export function shortcutOptions(options, previous) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !allowed.includes(key) || previous && key === 'id')) throw workspaceError('invalid_argument', 'Invalid shortcut options');
  const next = { description: '', accelerator: null, ...previous, ...options };
  if (!/^[\w.-]{1,64}$/.test(next.id ?? '') || typeof next.label !== 'string' || !next.label.trim() || next.label.length > 128 ||
      typeof next.description !== 'string' || next.description.length > 512 || typeof next.onInvoke !== 'function' || next.onChange != null && typeof next.onChange !== 'function')
    throw workspaceError('invalid_argument', 'Invalid shortcut identity, text or callbacks');
  if (!previous && !Object.hasOwn(options, 'defaultAccelerator')) next.defaultAccelerator = next.accelerator;
  for (const value of [next.accelerator, next.defaultAccelerator]) if (value !== null && (typeof value !== 'string' || !value.trim() || value.length > 128 || /\s/.test(value) || !normalizeAccelerator(value, 'windows'))) throw workspaceError('invalid_argument', 'Expected a single accelerator or null');
  return next;
}
export function normalizeAccelerator(value, platform) {
  if (value == null) return null;
  const parts = value.toLowerCase().split('+').map(part => ({ cmdorctrl: platform === 'macOS' ? 'meta' : 'ctrl', commandorcontrol: platform === 'macOS' ? 'meta' : 'ctrl', control: 'ctrl', cmd: 'meta', command: 'meta', super: 'meta', option: 'alt', esc: 'escape', space: ' ' })[part] ?? part);
  const modifiers = parts.filter(part => ['ctrl', 'meta', 'alt', 'shift'].includes(part)), keys = parts.filter(part => !modifiers.includes(part));
  if (keys.length !== 1 || !keys[0] || new Set(modifiers).size !== modifiers.length) return null;
  return [...modifiers, keys[0]].sort().join('+');
}

export function createShortcuts({ document, load, surface, activity, check, report, changed }) {
  const records = new Set(); let native, loading, commandRoot, commandNode, settingsRoot, settingsNode, settingsHost, search, query = '', capturing = 0, disposed = false, listening = false;
  const callback = (fn, ...args) => { try { Promise.resolve(fn?.(...args)).catch(report); } catch (error) { report(error); } };
  function conflict(accelerator, exclude) {
    if (accelerator == null || !native) return null;
    const key = normalizeAccelerator(accelerator, native.platform), keymap = native.keymap();
    if (!key || !keymap || !Array.isArray(keymap.bindings)) throw workspaceError('workspace_shortcuts_unavailable', 'The native keymap is not ready');
    for (const record of records) if (record !== exclude && normalizeAccelerator(record.options.accelerator, native.platform) === key) return record.options.label;
    for (const command of native.commands) if (native.bindings(command.id, keymap, native.platform).some(binding => normalizeAccelerator(binding.accelerator, native.platform) === key)) return command.electron?.menuTitle ?? command.id;
    return null;
  }
  function snapshot(record) { return record.snapshot ??= Object.freeze({ id: record.options.id, accelerator: record.options.accelerator, defaultAccelerator: record.options.defaultAccelerator, conflict: record.conflict ?? null }); }
  function notify(record) { record.snapshot = null; for (const listener of record.listeners) listener(); changed(); }
  function capture(record, value) {
    try {
      const options = shortcutOptions({ accelerator: value }, record.options), found = conflict(value, record);
      if (found) { record.conflict = found; notify(record); return false; }
      record.options = options; record.conflict = null; notify(record); callback(record.options.onChange, value); return true;
    } catch (error) { record.conflict = error.message; notify(record); report(error); return false; }
  }
  function components() {
    const R = native.React, h = R.createElement;
    function Command({ record }) {
      const invoke = R.useCallback(() => { if (!record.disposed) callback(record.options.onInvoke); }, [record]);
      native.useCommand(record.nativeId, invoke, { menuItem: { label: record.options.label, title: record.options.label, description: record.options.description }, isActive: () => !record.disposed && !capturing });
      return null;
    }
    function Row({ record }) {
      R.useSyncExternalStore(record.subscribe, () => snapshot(record));
      const [active, setActive] = R.useState(false);
      R.useEffect(() => { if (!active) return; capturing++; return () => { capturing--; }; }, [active]);
      const matches = (record.options.label + ' ' + record.options.description + ' ' + (record.options.accelerator ?? '')).toLowerCase().includes(query);
      if (!matches) return null;
      const stop = () => { setActive(false); record.conflict = null; notify(record); };
      return h(native.Row, { label: record.options.label, description: record.options.description,
        control: h('div', { className: 'flex max-w-full flex-col max-sm:w-full w-96' }, h(native.Capture, {
          accelerator: record.options.accelerator, acceleratorLabel: record.options.accelerator, allowsBareModifiers: false, allowsSequences: false, canAppend: false,
          captureAriaLabel: record.options.label, hotkeyName: record.options.label, conflict: record.conflict, disabled: false, isCapturing: active,
          valueLabelId: 'codlet-shortcut-' + record.nativeId, onCancelCapture: stop, onStartCapture: () => setActive(true),
          onCapture: value => { if (capture(record, value)) setActive(false); }, onClear: () => { capture(record, null); setActive(false); },
          onReset: record.options.accelerator === record.options.defaultAccelerator ? undefined : () => { if (capture(record, record.options.defaultAccelerator)) setActive(false); },
        })) });
    }
    return { Command, Row };
  }
  let Components;
  function renderCommands() {
    if (!native || disposed || !records.size) return;
    const source = activity() ?? surface()?.content ?? surface()?.main;
    if (!source) throw workspaceError('workspace_host_pending', 'Native command providers are pending');
    if (!commandRoot) {
      commandNode = document.createElement('span'); commandNode.dataset.codletWorkspaceOwned = 'commands'; commandNode.hidden = true;
      document.body.append(commandNode); commandRoot = native.Client.createRoot(commandNode);
    }
    native.DOM.flushSync(() => commandRoot.render(wrapProviders(native, providersFor(source), native.React.createElement(native.React.Fragment, null,
      ...[...records].map(record => native.React.createElement(Components.Command, { key: record.nativeId, record }))))));
  }
  function settingsInput() {
    const matches = [...document.querySelectorAll('#root input')].filter(input => !input.closest(OWNED + ',[data-app-shell-active-page="false"]') && ancestry(input, 24).some(fiber => componentSource(fiber.type).includes('settings.keyboardShortcuts.search.placeholder')));
    if (matches.length > 1) throw workspaceError('workspace_shortcuts_unavailable', 'Shortcut settings search ownership is ambiguous');
    return matches[0] ?? null;
  }
  function clearSettings() {
    if (settingsRoot) native.DOM.flushSync(() => settingsRoot.unmount()); settingsRoot = null;
    settingsNode?.remove(); settingsNode = settingsHost = search = null; query = '';
  }
  function refresh() {
    if (!native || disposed) return;
    try {
      const input = settingsInput();
      if (!input) { if (settingsRoot) clearSettings(); return; }
      // Verified native settings layout. Search filtering can remove every
      // builtin row; anchor to its stable layout, never to a translated label.
      const host = input.closest('[class*="@container/keyboard-shortcuts"]');
      if (!host) throw workspaceError('workspace_shortcuts_unavailable', 'The native shortcut settings layout changed');
      search = input; const nextQuery = input.value.trim().toLowerCase();
      if (settingsHost !== host) {
        clearSettings(); settingsHost = host; search = input;
        settingsNode = document.createElement('div'); settingsNode.dataset.codletWorkspaceOwned = 'shortcut-settings';
        host.append(settingsNode); settingsRoot = native.Client.createRoot(settingsNode);
      }
      query = nextQuery;
      native.DOM.flushSync(() => settingsRoot.render(wrapProviders(native, providersFor(input), native.React.createElement(native.React.Fragment, null,
        ...[...records].map(record => native.React.createElement(Components.Row, { key: record.nativeId, record }))))));
    } catch (error) { report(error); }
  }
  const inputListener = event => { if (event.target === search) refresh(); };
  const keyListener = event => {
    if (!native || disposed || capturing || event.defaultPrevented || event.repeat || event.isComposing || event.target?.closest?.('[data-codex-shortcut-capture="true"], [role="dialog"] input, [role="dialog"] textarea, [role="dialog"] [contenteditable="true"]')) return;
    const accelerator = native.eventAccelerator(event);
    if (!accelerator) return;
    const key = normalizeAccelerator(accelerator, native.platform);
    for (const record of records) if (normalizeAccelerator(record.options.accelerator, native.platform) === key) {
      try { if (!conflict(record.options.accelerator, record) && native.dispatchKeyboard(record.nativeId, event, {})) { event.preventDefault(); event.stopPropagation(); } }
      catch (error) { report(error); }
      return;
    }
  };
  function start() {
    return (loading ??= Promise.resolve().then(load).then(value => {
      if (disposed) throw workspaceError('workspace_retired', 'Shortcut provider retired');
      native = value; Components = components();
      return value;
    })).then(value => {
      if (disposed) throw workspaceError('workspace_retired', 'Shortcut provider retired');
      if (records.size && !listening) { document.addEventListener('keydown', keyListener, true); document.addEventListener('input', inputListener, true); listening = true; }
      return value;
    });
  }
  function register(options, owner) {
    check(); options = shortcutOptions(options);
    if (records.size >= 64) throw workspaceError('resource_limit', 'At most 64 workspace shortcuts per Target are supported');
    if ([...records].some(record => record.owner === owner && record.options.id === options.id)) throw workspaceError('invalid_argument', 'Shortcut ID already registered by this owner');
    const record = { owner, options, nativeId: 'codlet.' + owner.replace(/[^\w.-]/g, '_') + '.' + options.id, disposed: false, listeners: new Set() };
    record.subscribe = listener => { record.listeners.add(listener); return () => record.listeners.delete(listener); }; records.add(record);
    const ready = start().then(() => {
      if (record.disposed) throw workspaceError('workspace_retired', 'Shortcut retired before readiness');
      const found = conflict(record.options.accelerator, record);
      if (found) throw workspaceError('shortcut_conflict', `Shortcut conflicts with ${found}`);
      renderCommands(); refresh(); changed();
    }).catch(error => { if (!record.disposed) { handle.dispose(); report(error); } throw error; }); ready.catch(() => {});
    const handle = Object.freeze({ ready, getSnapshot() { check(); if (record.disposed) throw workspaceError('workspace_retired', 'Shortcut retired'); return snapshot(record); },
      update(partial) {
        check(); if (record.disposed) throw workspaceError('workspace_retired', 'Shortcut retired');
        const next = shortcutOptions(partial, record.options), found = conflict(next.accelerator, record);
        if (found) throw workspaceError('shortcut_conflict', `Shortcut conflicts with ${found}`);
        record.options = next; record.conflict = null; notify(record); renderCommands(); refresh();
      },
      dispose() {
        if (record.disposed) return; record.disposed = true; records.delete(record); record.listeners.clear();
        if (records.size) { renderCommands(); refresh(); }
        else {
          clearSettings(); if (commandRoot) native.DOM.flushSync(() => commandRoot.unmount()); commandRoot = null; commandNode?.remove(); commandNode = null;
          document.removeEventListener('keydown', keyListener, true); document.removeEventListener('input', inputListener, true);
          listening = false;
        }
      },
    }); record.handle = handle; return handle;
  }
  return { register, refresh, rebind() { if (records.size && native) { renderCommands(); refresh(); } }, dispose() {
    if (disposed) return; for (const record of [...records]) record.handle.dispose(); disposed = true;
  } };
}
