import test from 'node:test';
import assert from 'node:assert/strict';
import { nativePageHeaderContract, resolveNativePageHeader } from '../frontend/src/adapter/page-header.js';

const source = `var shell;
function initialize(){return(initialize=once(()=>{prepare();shell={Root:root,Header:header,HeaderToolbar:toolbar}}))()}
export {shell as shellExport,initialize as initializeExport};`;
const components = () => ({ Root() {}, Header() {}, HeaderToolbar() {} });

test('structural page discovery initializes only the live AppShell export selected by its lexical lazy assignment', () => {
  assert.deepEqual(nativePageHeaderContract(source), { initializer: 'initializeExport', value: 'shellExport' });
  let value, calls = 0, checks = 0;
  const header = components(), module = { get shellExport() { return value; }, initializeExport() { calls++; value = header; } };
  assert.equal(resolveNativePageHeader([{ module, source }], () => checks++), header);
  assert.equal(calls, 1); assert.equal(checks, 2);
  assert.equal(resolveNativePageHeader([{ module, source }]), header);
  assert.equal(calls, 1, 'an initialized live export does not need another initializer invocation');
});

test('page header contracts reject shadows, nested functions, arbitrary setup functions and ambiguous exports', () => {
  for (const invalid of [
    source.replace('prepare();', 'let shell;'),
    source.replace('function initialize(){', 'const unrelated=function initialize(){').replace('\nexport', ';let initialize;\nexport'),
    source.replace('function initialize(){', 'function outer(){function initialize(){').replace('\nexport', '}\nexport'),
    source.replace('return(initialize=once(()=>{prepare();shell={Root:root,Header:header,HeaderToolbar:toolbar}}))()', 'shell={Root:root,Header:header,HeaderToolbar:toolbar}'),
    source.replace('prepare();shell=', 'const unused=()=>shell='),
    source.replace(',initialize as initializeExport', ''),
  ]) assert.equal(nativePageHeaderContract(invalid), null, invalid);
  const other = source.replaceAll('shell', 'otherShell').replaceAll('initialize', 'initializeOther');
  assert.throws(() => nativePageHeaderContract(source + other), { code: 'ui_build_drift' });
  assert.throws(() => resolveNativePageHeader([{ module: { a: components(), b: components() }, source: '' }]), { code: 'ui_build_drift' });
});

test('page header initialization respects owner retirement and preserves real initializer errors', () => {
  const original = Error('Native header initialization failed'); let calls = 0;
  const module = { initializeExport() { calls++; throw original; } };
  assert.throws(() => resolveNativePageHeader([{ module, source }], () => { throw Error('Owner retired'); }), /Owner retired/);
  assert.equal(calls, 0);
  assert.throws(() => resolveNativePageHeader([{ module, source }]), error => error === original);
  assert.equal(calls, 1);
  assert.throws(() => resolveNativePageHeader([{ module: { initializeExport() {} }, source }]), { code: 'ui_build_drift' });
});
