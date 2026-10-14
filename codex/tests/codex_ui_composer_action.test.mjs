import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { uiFixture, tick, deferred } from './support/ui-fixture.mjs';

const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const { buildSync } = require('esbuild');
const cwd = fileURLToPath(new URL('../frontend', import.meta.url));
const compile = (source, globalName) => buildSync({
  absWorkingDir: cwd,
  stdin: { contents: readFileSync(new URL(source, import.meta.url), 'utf8'), resolveDir: source.includes('native-shell') ? cwd : cwd + '/src/adapter', sourcefile: source },
  bundle: true, write: false, format: 'iife', globalName, platform: 'browser',
  loader: { '.svg': 'text' }, define: { 'process.env.NODE_ENV': '"production"' }
}).outputFiles[0].text;
const shellSource = compile('./support/native-shell.js', 'NativeShell');
const adapterSource = compile('../frontend/src/adapter/navigation.js', 'Adapter');
const PROFILE = { rootAttribute: 'data-codex-composer-root', scrollAreaAttribute: 'data-composer-utility-bar-scroll-area' };

function fixture(t, options = {}) {
  const f = uiFixture();
  const native = { ...f.window.eval(shellSource + ';NativeShell;') };
  const shell = native.mount(options);
  native.Header = () => null;
  native.HeaderToolbar = () => null;
  native.useStartNewConversation = () => () => {};
  native.composerActionProfile = options.unsupported ? null : PROFILE;
  const adapter = f.window.eval(adapterSource + ';Adapter;');
  const navigation = adapter.createNavigation(f.context, native, adapter.locateHost());
  t.after(() => { navigation.dispose(); shell.dispose(); f.dispose(); });
  return { ...f, native, shell, adapter, navigation };
}
function lease(f, { id = 'test.consumer', generation = 7, token = 'test-action-token-123456' } = {}) {
  const node = f.document.createElement('span');
  Object.assign(node.dataset, {
    codletComposerActionLease: token,
    codletComposerActionOwner: id,
    codletGeneration: String(generation)
  });
  f.document.body.append(node);
  return node;
}
const caller = { pluginId: 'test.consumer', generation: 7 };
const args = { label: 'Provider', token: 'test-action-token-123456' };
const buttons = f => [...f.document.querySelectorAll('[data-codlet-composer-action-instance] button')];

function currentThreadFooter(f) {
  const root = f.document.querySelector('[data-codex-composer-root]');
  root.setAttribute('data-composer-placement', 'thread');
  root.innerHTML = `<div data-composer-body data-composer-layout="multiline">
    <div data-composer-footer-responsive data-composer-layout="multiline" data-composer-rows="stacked">
      <div><div data-composer-input><div data-codex-composer="true" role="textbox" contenteditable="true"></div></div></div>
      <div><div><span><button data-composer-navigation-target="add-context">Context</button></span><button data-composer-navigation-target="permissions">Permissions</button></div></div>
      <div><div><button aria-label="Send">Send</button></div></div>
    </div></div>`;
  return { root, footer: root.querySelector('[data-composer-footer-responsive]'), outlet: root.querySelector('[data-composer-footer-responsive]').children[1].firstElementChild };
}

test('current Native thread footer mounts a leased action without altering the editor or Send control', async t => {
  const f = fixture(t), node = lease(f), native = currentThreadFooter(f), received = [];
  const editor = native.root.querySelector('[contenteditable="true"]'), send = native.root.querySelector('[aria-label="Send"]');
  node.addEventListener('codlet:composer-action', event => received.push(JSON.parse(event.detail)));
  const result = f.navigation.registerComposer(args, { caller }); await tick();
  assert.equal(result.mounted, 1);
  assert.equal(buttons(f)[0].parentElement.parentElement, native.outlet);
  assert.equal(native.root.querySelector('[contenteditable="true"]'), editor);
  assert.equal(native.root.querySelector('[aria-label="Send"]'), send);
  buttons(f)[0].click(); assert.equal(received[0].placement, 'thread');
  assert.throws(() => f.navigation.registerComposer(args, { caller: { pluginId: caller.pluginId, generation: 8 } }), { code: 'invalid_owner' });
  f.navigation.unregisterComposer({ token: args.token }, { caller }); await tick();
  assert.equal(buttons(f).length, 0); assert.equal(editor.isConnected, true); assert.equal(send.isConnected, true);
});

test('thread footer drift and ambiguity retire mounted actions, and Native outlet replacement recovers once', async t => {
  const f = fixture(t), node = lease(f); let native = currentThreadFooter(f); const events = [];
  node.addEventListener('codlet:composer-action', event => events.push(event.detail));
  f.navigation.registerComposer(args, { caller }); await tick(); const retired = buttons(f)[0];
  native.footer.setAttribute('data-composer-rows', 'unreviewed'); await tick(); assert.equal(buttons(f).length, 0);
  native.footer.setAttribute('data-composer-rows', 'stacked'); await tick(); assert.equal(buttons(f).length, 1);
  const duplicate = native.outlet.querySelector('[data-composer-navigation-target="permissions"]').cloneNode(true);
  native.outlet.append(duplicate); await tick(); assert.equal(buttons(f).length, 0);
  duplicate.remove(); await tick(); assert.equal(buttons(f).length, 1);
  const extraFooter = native.footer.cloneNode(false); native.root.append(extraFooter); await tick(); assert.equal(buttons(f).length, 0);
  extraFooter.remove(); native = currentThreadFooter(f); await tick(); assert.equal(buttons(f).length, 1);
  retired.click(); assert.equal(events.length, 0); buttons(f)[0].click(); assert.equal(events.length, 1);
  native.root.setAttribute('data-composer-placement', 'home'); await tick(); assert.equal(buttons(f).length, 0);
});

test('a malformed old scroll outlet cannot borrow the current thread footer fallback', async t => {
  const f = fixture(t), node = lease(f), native = currentThreadFooter(f);
  const area = f.document.createElement('div'); area.setAttribute('data-composer-utility-bar-scroll-area', '');
  area.append(f.document.createElement('div')); native.root.append(area);
  assert.equal(f.navigation.registerComposer(args, { caller }).mounted, 0);
  area.remove(); await tick(); assert.equal(buttons(f).length, 1);
});

test('thread footer requires Native controls and a separate uniquely owned input section', async t => {
  const f = fixture(t), node = lease(f); let native = currentThreadFooter(f);
  f.navigation.registerComposer(args, { caller }); await tick(); assert.equal(buttons(f).length, 1);
  const add = native.outlet.querySelector('[data-composer-navigation-target="add-context"]');
  add.removeAttribute('data-composer-navigation-target'); await tick(); assert.equal(buttons(f).length, 0);
  add.setAttribute('data-composer-navigation-target', 'add-context'); await tick(); assert.equal(buttons(f).length, 1);
  const editor = native.footer.querySelector('[contenteditable="true"]'); native.outlet.append(editor);
  await tick(); assert.equal(buttons(f).length, 0);
  native = currentThreadFooter(f); await tick(); assert.equal(buttons(f).length, 1);
  const nested = f.document.createElement('div'); nested.setAttribute('data-codex-composer-root', '');
  native.footer.firstElementChild.append(nested); nested.append(native.footer.querySelector('[contenteditable="true"]'));
  await tick(); assert.equal(buttons(f).length, 0);
});

test('legacy Windows profile records the composer landmarks for its entry', t => {
  const f = fixture(t);
  const profile = f.adapter.pageProfile({ appVersion: '26.917.62051', buildNumber: 10789 }, 'app://-/assets/index-897000035213.js');
  assert.deepEqual(JSON.parse(JSON.stringify(profile.page.composerAction)), PROFILE);
  const mac = f.adapter.pageProfile({ appVersion: '26.917.62051', buildNumber: 10789 }, 'app://-/assets/index-88e5ba1e2117.js');
  assert.equal(mac.page.composerAction, undefined);
});

test('Core-authenticated lease yields one native action and a string-only click event', async t => {
  const f = fixture(t), node = lease(f), received = [];
  node.addEventListener('codlet:composer-action', event => received.push(event.detail));
  const result = f.navigation.registerComposer(args, { caller });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { api: 1, token: args.token, available: true, mounted: 1 });
  assert.equal(buttons(f).length, 1);
  assert.equal(buttons(f)[0].getAttribute('aria-label'), 'Provider');
  buttons(f)[0].click();
  const event = JSON.parse(received[0]);
  assert.deepEqual({ api: event.api, token: event.token, placement: event.placement }, { api: 1, token: args.token, placement: 'home' });
  assert.equal(f.document.querySelector(`[data-codlet-composer-action-instance-id="${event.instance}"]`)?.contains(buttons(f)[0]), true);
  assert.equal(f.shell.navigator.location.pathname, '/local/start');
  assert.equal(f.document.getElementById('native-composer') !== null, true);
  assert.deepEqual(JSON.parse(JSON.stringify(f.navigation.statusComposer({ token: args.token }, { caller }))), { registered: true, mounted: 1 });
  node.remove(); await tick();
  assert.equal(buttons(f).length, 0);
  assert.equal(f.document.querySelector('[data-codlet-composer-action-style]'), null);
  assert.equal(f.navigation.statusComposer({ token: args.token }, { caller }).registered, false);
});

test('composer actions remain usable when the page router is absent on an unlisted build',async t=>{
  const f=fixture(t),root=f.document.getElementById('root');
  const adapter=f.window.eval('(function(location){'+adapterSource+';return Adapter})({origin:"app://-",pathname:"/index.html"})');
  delete root[Object.keys(root).find(key=>key.startsWith('__reactContainer$'))];
  const session=adapter.deferredNavigation(f.context);t.after(()=>session.dispose());lease(f);
  const result=session.registerComposer(args,{caller});await tick();assert.equal(result.available,true);assert.equal(buttons(f).length,1);
  assert.equal(session.statusComposer({token:args.token},{caller}).mounted,1);
  session.dispose();await tick();assert.equal(buttons(f).length,0);
});

test('one owner action mounts in every reviewed composer and follows native route replacement', async t => {
  const f = fixture(t, { multipleComposers: true }), node = lease(f), events = [];
  node.addEventListener('codlet:composer-action', event => events.push(JSON.parse(event.detail)));
  f.navigation.registerComposer(args, { caller }); await tick();
  assert.equal(buttons(f).length, 2);
  buttons(f)[1].click();
  assert.equal(events[0].placement, 'floating');
  f.shell.navigator.push('/local/thread/one'); await tick();
  assert.equal(buttons(f).length, 1);
  buttons(f)[0].click();
  assert.equal(events[1].placement, 'thread');
  f.shell.navigator.push('/inbox'); await tick();
  assert.equal(buttons(f).length, 0);
  assert.equal(f.navigation.statusComposer({ token: args.token }, { caller }).mounted, 0);
  f.shell.navigator.push('/local/start'); await tick();
  assert.equal(buttons(f).length, 2);
  node.remove(); await tick();
  assert.equal(buttons(f).length, 0);
});

test('registration, status and removal reject another owner or generation', async t => {
  const f = fixture(t), node = lease(f);
  for (const other of [null, { pluginId: 'other', generation: 7 }, { pluginId: 'test.consumer', generation: 8 }])
    assert.throws(() => f.navigation.registerComposer(args, { caller: other }), { code: 'invalid_owner' });
  for (const invalid of [{ ...args, label: '' }, { ...args, extra: 1 }, { ...args, token: 'short' }])
    assert.throws(() => f.navigation.registerComposer(invalid, { caller }), { code: 'invalid_argument' });
  f.navigation.registerComposer(args, { caller });
  assert.equal(f.navigation.unregisterComposer({ token: args.token }, { caller: { pluginId: 'other', generation: 7 } }).removed, false);
  assert.equal(f.navigation.unregisterComposer({ token: args.token }, { caller: { pluginId: 'test.consumer', generation: 8 } }).removed, false);
  assert.equal(buttons(f).length, 1);
  assert.equal(f.navigation.unregisterComposer({ token: args.token }, { caller }).removed, true);
  assert.equal(buttons(f).length, 0);
  node.remove(); await tick();
});

test('native structural drift hides actions and restoration mounts them again', async t => {
  const f = fixture(t), node = lease(f);
  f.navigation.registerComposer(args, { caller }); await tick();
  const root = f.document.querySelector('[data-codex-composer-root]');
  const area = root.querySelector('[data-composer-utility-bar-scroll-area]');
  area.removeAttribute('role'); await tick();
  assert.equal(buttons(f).length, 0);
  assert.equal(f.navigation.statusComposer({ token: args.token }, { caller }).mounted, 0);
  area.setAttribute('role', 'group'); await tick();
  assert.equal(buttons(f).length, 1);
  root.removeAttribute('data-codex-composer-root'); await tick();
  assert.equal(buttons(f).length, 0);
  root.setAttribute('data-codex-composer-root', ''); await tick();
  assert.equal(buttons(f).length, 1);
  node.remove(); await tick();
});

test('a recycled owner generation cannot reuse a stale lease or receive late clicks', async t => {
  const f = fixture(t), old = lease(f), oldEvents = [];
  old.addEventListener('codlet:composer-action', event => oldEvents.push(event.detail));
  f.navigation.registerComposer(args, { caller }); await tick();
  old.remove(); await tick();
  const freshCaller = { pluginId: caller.pluginId, generation: 8 };
  const fresh = lease(f, { generation: 8 }), freshEvents = [];
  fresh.addEventListener('codlet:composer-action', event => freshEvents.push(event.detail));
  assert.throws(() => f.navigation.registerComposer(args, { caller }), { code: 'invalid_owner' });
  f.navigation.registerComposer(args, { caller: freshCaller }); await tick();
  assert.equal(buttons(f).length, 1);
  buttons(f)[0].click();
  assert.equal(oldEvents.length, 0);
  assert.equal(freshEvents.length, 1);
  fresh.remove(); await tick();
});

test('missing structural contract and auxiliary window do not insert an action', async t => {
  const f = fixture(t, { unsupported: true }), node = lease(f);
  const result = f.navigation.registerComposer(args, { caller });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'unsupported_build');
  assert.equal(node.isConnected, false);
  assert.equal(buttons(f).length, 0);
  f.navigation.dispose();
  f.shell.navigator.push('/avatar-overlay'); await tick();
  const auxiliary = f.adapter.createNavigation(f.context, { ...f.native, composerActionProfile: PROFILE }, f.adapter.locateHost());
  t.after(() => auxiliary.dispose());
  const auxLease = lease(f);
  assert.equal(auxiliary.registerComposer(args, { caller }).available, false);
  assert.equal(auxLease.isConnected, false);
});

test('unrelated message additions do not trigger full composer scans', async t => {
  const f = fixture(t), node = lease(f);
  f.navigation.registerComposer(args, { caller }); await tick();
  const query = f.shell ? f.document.getElementById('root').querySelectorAll.bind(f.document.getElementById('root')) : null;
  let scans = 0;
  f.document.getElementById('root').querySelectorAll = (selector, ...rest) => { if (selector === '[data-codex-composer-root]') scans++; return query(selector, ...rest); };
  const stream = f.document.createElement('article'); f.document.querySelector('main').append(stream); await tick(); scans = 0;
  for (let index = 0; index < 20; index++) { stream.textContent = String(index); await Promise.resolve(); }
  assert.equal(scans, 0);
  node.remove(); await tick();
});

test('cold startup accepts a lease and retires it before or after Native readiness', async t => {
  const f = fixture(t); f.navigation.dispose();
  const loading = deferred(), bridge = f.adapter.deferredNavigation(f.context, () => loading.promise);
  t.after(() => bridge.dispose());
  const node = lease(f);
  const result = bridge.registerComposer(args, { caller });
  assert.equal(result.pending, true);
  assert.equal(bridge.statusComposer({ token: args.token }, { caller }).registered, true);
  loading.resolve(f.native); await bridge.ready; await tick();
  assert.equal(buttons(f).length, 1);
  node.remove(); await tick();
  assert.equal(buttons(f).length, 0);
  const pending = deferred(), late = f.adapter.deferredNavigation(f.context, () => pending.promise);
  const lateNode = lease(f, { token: 'late-action-token-123456' });
  late.registerComposer({ label: 'Late', token: 'late-action-token-123456' }, { caller });
  late.dispose(); pending.resolve(f.native);
  await assert.rejects(late.ready, { code: 'ui_retired' });
  assert.equal(lateNode.isConnected, false);
  bridge.dispose(); await tick();
});
