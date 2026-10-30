import test from 'node:test';
import assert from 'node:assert/strict';
import { loadedAsset } from '../frontend/src/host-discovery.js';

const initial = 'app://-/assets/app-initial-static.js';
const shared = 'app://-/assets/app-shared-static.js';
function fixture(t, { preloads = [], scripts = [], resources = [] } = {}) {
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  Object.defineProperties(globalThis, {
    location: { configurable: true, value: { origin: 'app://-', pathname: '/index.html' } },
    document: { configurable: true, value: { scripts, querySelectorAll(selector) {
      assert.equal(selector, 'link[rel="modulepreload"]');
      return preloads.map(href => ({ href }));
    } } },
    performance: { configurable: true, value: { getEntriesByType(type) {
      assert.equal(type, 'resource');
      return resources;
    } } },
  });
  t.after(() => {
    for (const key of ['location', 'document', 'performance']) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
      else delete globalThis[key];
    }
  });
  return { resources, preloads, scripts };
}

test('a Native static import is discoverable without a modulepreload element', t => {
  fixture(t, { preloads: [shared], resources: [
    { name: 'app://-/assets/app-main-entry.js', initiatorType: 'script' },
    { name: initial, initiatorType: 'script' },
  ] });
  assert.equal(loadedAsset('initial'), initial);
  assert.equal(loadedAsset('shared'), shared);
});

test('the same module across script, preload and resource evidence is one candidate', t => {
  fixture(t, { preloads: [initial], scripts: [{ src: initial, type: 'module' }], resources: [
    { name: initial, initiatorType: 'link' },
    { name: initial, initiatorType: 'script' },
    { name: initial, initiatorType: 'script' },
  ] });
  assert.equal(loadedAsset('initial'), initial);
});

test('a module script remains discoverable when resource entries were cleared', t => {
  fixture(t, { scripts: [{ src: initial, type: 'module' }] });
  assert.equal(loadedAsset('initial'), initial);
});

test('source fetches, foreign origins and unrelated resources cannot select a Native module', t => {
  fixture(t, { scripts: [{ src: initial, type: 'text/plain' }], resources: [
    { name: initial, initiatorType: 'fetch' },
    { name: initial, initiatorType: 'xmlhttprequest' },
    { name: 'https://example.com/assets/app-initial-other.js', initiatorType: 'script' },
    { name: 'app://-/assets/app-initial-other.js?revision=1', initiatorType: 'script' },
    { name: 'app://-/assets/app-initial-other.js.map', initiatorType: 'script' },
  ] });
  assert.throws(() => loadedAsset('initial'), { code: 'ui_host_pending' });
});

test('different loaded modules remain ambiguous across evidence sources', t => {
  fixture(t, { preloads: [initial], resources: [
    { name: 'app://-/assets/app-initial-second.js', initiatorType: 'script' },
  ] });
  assert.throws(() => loadedAsset('initial'), { code: 'desktop_asset_ambiguous' });
});

test('asset evidence is read from the current document without retaining prior candidates', t => {
  const f = fixture(t, { resources: [{ name: initial, initiatorType: 'script' }] });
  assert.equal(loadedAsset('initial'), initial);
  f.resources.splice(0);
  assert.throws(() => loadedAsset('initial'), { code: 'ui_host_pending' });
  location.pathname = '/other.html';
  assert.throws(() => loadedAsset('initial'), { code: 'desktop_document_unsupported' });
});
