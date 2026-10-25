import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverNative } from '../frontend/src/adapter/discovery.js';

function RailButton() { return { 'data-selected': true, 'data-uniform': true }; }
function SidebarGroup() { return 'group/nav-list'; }
function LegacyTooltip(props) { return { tooltipContent: props.tooltipContent, delayDuration: props.delayDuration }; }
function ContentTooltip({ content, contentClassName, enabledWhen, forceOpen }) {
  return { renderTooltip: () => ({ content, contentClassName, enabledWhen, forceOpen, delayDuration: 150, disableHoverableContent: true }) };
}
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
  const rail = { querySelectorAll: () => [home] };
  const previous = { document: globalThis.document, location: globalThis.location };
  globalThis.location = { origin: 'app://-', pathname: '/index.html' };
  globalThis.document = { querySelectorAll: selector => selector.startsWith('nav[') ? [rail] : [
    { href: 'app://-/assets/app-shared-new.js' }, { href: 'app://-/assets/app-initial-new.js' },
  ] };
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  const primary = {}, initial = {};
  return { shared, tooltip, group, primary, initial, discover: () => discoverNative({ load: async url => url.includes('app-shared-') ? shared : url.includes('app-primary-') ? primary : initial, read: async url => url.includes('app-shared-') ? factorySource : 'import("./app-primary-new.js")' }) };
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
  f.tooltip.return = { type: LegacyTooltip, memoizedProps: { tooltipContent: 'Home', side: 'right' }, return: f.group };
  await assert.rejects(f.discover(), { code: 'ui_host_drift' });
});
