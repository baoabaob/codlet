import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverNative } from '../frontend/src/adapter/discovery.js';

function RailButton() { return { 'data-selected': true, 'data-uniform': true }; }
function SidebarGroup() { return 'group/nav-list'; }
function LegacyTooltip(props) { return { tooltipContent: props.tooltipContent, delayDuration: props.delayDuration }; }
function ContentTooltip({ content, contentClassName, enabledWhen, forceOpen }) {
  return { renderTooltip: () => ({ content, contentClassName, enabledWhen, forceOpen, delayDuration: 150, disableHoverableContent: true }) };
}
function DefaultsProvider({ side, children }) { return { side, children }; }
ContentTooltip.DefaultsProvider = DefaultsProvider;
const factorySource = `
const react=cjs(e=>{e.createElement=()=>{};e.useState=()=>{};e.useEffect=()=>{};e.Fragment=Symbol();e.version='x';});
const wrap=cjs((e,m)=>{m.exports=react()});
const dom=cjs(e=>{e.createPortal=()=>{};e.flushSync=()=>{};e.version='x'});
const client=cjs(e=>{e.createRoot=()=>{}});
export{wrap as r,dom as d,client as c};`;
function fixture(t, Tooltip, contentProp) {
  const React = { version: 'x', useState() {}, createElement: (type, props) => ({ type, props }) };
  const DOM = { version: 'x', flushSync() {} }, Client = { createRoot() {} };
  const shared = { r: () => React, d: () => DOM, c: () => Client, RailButton, SidebarGroup, Tooltip };
  const group = { type: SidebarGroup, memoizedProps: { itemSpacing: 'rail' } };
  const tooltip = { type: Tooltip, memoizedProps: { [contentProp]: 'Home', side: 'right' }, return: group };
  const button = { type: RailButton, memoizedProps: { uniform: true, iconSize: 'lg', 'data-sidebar-destination': 'builtin:home' }, return: tooltip };
  const home = { __reactFiber$test: { type: 'button', return: button } };
  const current = { child: group }, root = { __reactContainer$test: { stateNode: { current } } };
  group.return = current; group.child = tooltip; tooltip.child = button; button.child = home.__reactFiber$test;
  home.__reactFiber$test.stateNode = home;
  const rail = { querySelectorAll: () => [home] };
  const previous = { document: globalThis.document, location: globalThis.location };
  globalThis.location = { origin: 'app://-', pathname: '/index.html' };
  globalThis.document = { getElementById: () => root, querySelectorAll: selector => selector.startsWith('nav[') ? [rail] : [
    { href: 'app://-/assets/app-shared-new.js' }, { href: 'app://-/assets/app-initial-new.js' },
  ] };
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  const primary = {}, initial = {};
  return { shared, tooltip, group, current, primary, initial, discover: () => discoverNative({ load: async url => url.includes('app-shared-') ? shared : url.includes('app-primary-') ? primary : initial, read: async url => url.includes('app-shared-') ? factorySource : 'import("./app-primary-new.js")' }) };
}
test('mounted legacy rail tooltip retains its native component and prop contract', async t => {
  const f = fixture(t, LegacyTooltip, 'tooltipContent'), native = await f.discover();
  assert.equal(native.RailTooltip, LegacyTooltip);
  assert.equal(native.RailButton, RailButton);
});
test('mounted sidebar and page header can move to the referenced native primary module', async t => {
  const f=fixture(t,ContentTooltip,'content');delete f.shared.SidebarGroup;f.primary.SidebarGroup=SidebarGroup;
  const header={Header(){},HeaderToolbar(){},Root(){}};f.primary.page=header;
  const native=await f.discover();assert.equal(native.SidebarGroup,SidebarGroup);assert.equal(native.Header,header.Header);
});
test('mounted content tooltip receives the existing navigation and action labels without legacy props', async t => {
  const f = fixture(t, ContentTooltip, 'content'), native = await f.discover();
  const child = {}, onClick = () => {};
  const rendered = native.RailTooltip({ tooltipContent: 'Split', delayDuration: 240, side: 'bottom', shortcut: 'Ctrl+S', disabled: false,
    cloneCustomTrigger: false, closeOnTriggerClick: true, variant: 'tooltip', children: child, onClick });
  assert.equal(rendered.type, ContentTooltip);
  assert.deepEqual(rendered.props, { content: 'Split', openDelay: 240, side: 'bottom', shortcut: 'Ctrl+S', disabled: false, children: child, onClick });
});
test('a rail tooltip inherits its side from its own current Native defaults provider', async t => {
  const f = fixture(t, ContentTooltip, 'content');
  delete f.tooltip.memoizedProps.side;
  const defaults = { type: DefaultsProvider, memoizedProps: { side: 'right' }, child: f.group, return: f.current };
  f.current.child = defaults; f.group.return = defaults;
  const native = await f.discover();
  assert.equal(native.RailButton, RailButton);
  assert.equal(native.resolveNavigation().RailTooltip, native.RailTooltip, 'reconciliation preserves the adapted component identity');
  f.tooltip.memoizedProps.side = 'left';
  assert.throws(native.resolveNavigation, { code: 'ui_host_drift' }, 'an explicit side overrides inherited defaults');
});
test('unrelated or detached tooltip defaults cannot satisfy the mounted rail contract', async t => {
  const f = fixture(t, ContentTooltip, 'content'); delete f.tooltip.memoizedProps.side;
  const defaults = { type() {}, memoizedProps: { side: 'right' }, child: f.group, return: f.current };
  f.current.child = defaults; f.group.return = defaults;
  await assert.rejects(f.discover(), { code: 'ui_host_drift' });
  defaults.type = DefaultsProvider; f.current.child = f.group;
  await assert.rejects(f.discover(), { code: 'ui_host_drift' });
});
test('unmounted or unexported tooltip candidates cannot satisfy native discovery', async t => {
  const f = fixture(t, ContentTooltip, 'content');
  delete f.shared.Tooltip;
  await assert.rejects(f.discover(), { code: 'ui_host_drift' });
});
test('a changed content-tooltip interface and multiple mounted owners remain unavailable', async t => {
  const f = fixture(t, ContentTooltip, 'unknownContent');
  await assert.rejects(f.discover(), { code: 'ui_host_drift' });
  f.tooltip.memoizedProps = { content: 'Home', side: 'right' };
  f.shared.LegacyTooltip = LegacyTooltip;
  f.tooltip.return = { type: LegacyTooltip, memoizedProps: { tooltipContent: 'Home', side: 'right' }, return: f.group, child: f.tooltip };
  f.group.child = f.tooltip.return;
  await assert.rejects(f.discover(), { code: 'ui_host_drift' });
});

test('a detached rail ancestry cannot supply stale Native components', async t => {
  const f = fixture(t, ContentTooltip, 'content');
  f.current.child = null;
  await assert.rejects(f.discover(), { code: 'ui_host_drift' });
});

function ClassicItem({ animatedIcon, label, icon, isActive, onClick }) {
  return { className: 'sidebar-item', animatedIcon, label, icon, isActive, onClick };
}
function classicFixture(t) {
  const React = { version: 'x', useState() {}, createElement: (type, props) => ({ type, props }) };
  const DOM = { version: 'x', flushSync() {} }, Client = { createRoot() {} };
  const shared = { r: () => React, d: () => DOM, c: () => Client };
  const primary = { ClassicItem, SidebarGroup }, initial = {}, buttons = [];
  const current = {}, group = { type: SidebarGroup, memoizedProps: {}, return: current };
  const parent = { nodeType: 1, contains: button => buttons.includes(button) };
  const groupDOM = { type: 'div', stateNode: parent, return: group };
  const wrapper = { type() {}, return: groupDOM };
  group.child = groupDOM; groupDOM.child = wrapper; current.child = group;
  const nav = {}, root = { __reactContainer$test: { stateNode: { current } } };
  const add = (type = ClassicItem) => {
    const item = { type, memoizedProps: { animatedIcon: 'sidebar-new-chat', label: 'New chat', icon() {}, isActive: false, onClick() {} }, return: wrapper };
    const button = { closest: selector => selector === 'nav' ? nav : null };
    const leaf = { type: 'button', stateNode: button, return: item };
    button.__reactFiber$test = leaf; item.child = leaf;
    if (wrapper.child) wrapper.child.sibling = item; else wrapper.child = item;
    buttons.push(button); return { button, item, leaf };
  };
  const row = add(), previous = { document: globalThis.document, location: globalThis.location };
  globalThis.location = { origin: 'app://-', pathname: '/index.html' };
  globalThis.document = { getElementById: () => root, querySelectorAll: selector => selector === 'nav button.sidebar-item' ? buttons : selector.startsWith('nav[') ? [] : [
    { href: 'app://-/assets/app-shared-new.js' }, { href: 'app://-/assets/app-initial-new.js' },
  ] };
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  return { shared, primary, current, group, parent, buttons, row, add,
    discover: () => discoverNative({ load: async url => url.includes('app-shared-') ? shared : url.includes('app-primary-') ? primary : initial, read: async url => url.includes('app-shared-') ? factorySource : 'import("./app-primary-new.js")' }) };
}

test('an unlisted build discovers its mounted classic rows and lexical group without a rail', async t => {
  const f = classicFixture(t), native = await f.discover();
  assert.equal(native.SidebarItem, ClassicItem); assert.equal(native.SidebarGroup, SidebarGroup);
  assert.equal(native.RailButton, undefined); assert.equal(native.RailTooltip, undefined);
});
test('classic discovery follows a proven current alternate, never detached row ancestry', async t => {
  const f = classicFixture(t), {button, leaf} = f.row;
  button.__reactFiber$test = { stateNode: button, return: null, alternate: leaf };
  assert.equal((await f.discover()).SidebarItem, ClassicItem);
  f.current.child = null;
  await assert.rejects(f.discover(), { code: 'ui_host_drift' });
});
test('classic discovery requires the mounted row export and its actual containing group', async t => {
  const f = classicFixture(t);
  delete f.primary.ClassicItem;
  await assert.rejects(f.discover(), { code: 'ui_host_drift' });
  f.primary.ClassicItem = ClassicItem; delete f.primary.SidebarGroup;
  await assert.rejects(f.discover(), { code: 'ui_host_drift' });
  f.primary.SidebarGroup = SidebarGroup; f.parent.contains = () => false;
  await assert.rejects(f.discover(), { code: 'ui_host_drift' });
});
test('different mounted classic row owners are a contract error instead of pending startup', async t => {
  const f = classicFixture(t);
  function OtherItem({ animatedIcon, isActive }) { return { className: 'sidebar-item', animatedIcon, isActive }; }
  f.primary.OtherItem = OtherItem; f.add(OtherItem);
  await assert.rejects(f.discover(), { code: 'ui_host_drift' });
});
test('an unrelated navigation with the same CSS class cannot make the proven Native owner ambiguous', async t => {
  const f = classicFixture(t), unrelated = {};
  f.buttons.push({closest: selector => selector === 'nav' ? unrelated : null});
  assert.equal((await f.discover()).SidebarItem, ClassicItem);
});
test('navigation can remain pending only while neither semantic navigation owner is mounted', async t => {
  const f = classicFixture(t); f.buttons.length = 0;
  await assert.rejects(f.discover(), { code: 'ui_host_pending' });
});
test('mounted classic rows with contradictory roles or multiple navigation landmarks fail explicitly', async t => {
  const f = classicFixture(t);
  f.group.memoizedProps.itemSpacing = 'rail';
  await assert.rejects(f.discover(), { code: 'ui_host_drift' });
  delete f.group.memoizedProps.itemSpacing;
  f.row.item.memoizedProps.animatedIcon = 'unknown-navigation-contract';
  await assert.rejects(f.discover(), { code: 'ui_host_drift' });
  f.row.item.memoizedProps.animatedIcon = 'sidebar-new-chat';
  const other = f.add(); other.button.closest = selector => selector === 'nav' ? {} : null;
  await assert.rejects(f.discover(), { code: 'ui_host_drift' });
});
