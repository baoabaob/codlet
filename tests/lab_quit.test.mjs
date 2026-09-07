import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const script = await readFile(new URL('../src/lab/quit.js', import.meta.url), 'utf8');

function fixture(url = 'app://-/index.html', options = {}) {
  const calls = [];
  const window = {
    location: { href: new URL(url).href },
    electronBridge: options.noBridge ? undefined : {
      windowType: options.windowType ?? 'electron',
      async sendMessageFromView(message) { calls.push(JSON.parse(JSON.stringify(message))); },
    },
  };
  window.top = options.subframe ? {} : window;
  return { window, calls };
}

test('owned main document requests application quit without relaunch or Browser.close', async () => {
  const state = fixture('app://-/index.html?window=main#/login');
  const result = await vm.runInNewContext(script, { window: state.window }, { timeout: 1000 });
  assert.equal(result.status, 'quit_requested');
  assert.deepEqual(state.calls, [{ type: 'quit-app' }]);
});

test('navigation, subframes and missing native bridge cannot dispatch a quit message', async () => {
  for (const state of [
    fixture('https://example.invalid/index.html'),
    fixture('app://other/index.html'),
    fixture('app://-/login.html'),
    fixture('app://user@-/index.html'),
    fixture('app://-:9000/index.html'),
    fixture(undefined, { subframe: true }),
    fixture(undefined, { noBridge: true }),
    fixture(undefined, { windowType: 'browser' }),
  ]) {
    const result = await vm.runInNewContext(script, { window: state.window }, { timeout: 1000 });
    assert.ok(['wrong_document', 'bridge_unavailable'].includes(result.status));
    assert.deepEqual(state.calls, []);
  }
});
