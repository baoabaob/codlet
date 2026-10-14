import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolveThreadInteraction, hasBlockingOverlay } from '../frontend/src/adapter/workspace-dom.js';
const require = createRequire(new URL('../frontend/package.json', import.meta.url)), { JSDOM } = require('jsdom');
test('semantic sidebar interactions retain row actions and reject embedded controls and owned surfaces', t => {
  const dom = new JSDOM('<nav><button id="row"><span data-thread-title><span id="title">Task</span><button id="menu">Menu</button></span></button></nav>');
  t.after(() => dom.window.close());
  const document = dom.window.document, title = document.getElementById('title'), marker = title.closest('[data-thread-title]');
  marker.__reactFiber$fixture = { memoizedProps: { thread: { id: 'thread-owned-123', hostId: 'local' } }, return: null };
  assert.deepEqual(resolveThreadInteraction(document, title), { threadId: 'thread-owned-123', hostId: 'local' });
  const menu = document.createElement('button'); menu.textContent = 'Menu'; marker.appendChild(menu);
  assert.equal(resolveThreadInteraction(document, menu), null);
  marker.parentElement.dataset.codletWorkspaceOwned = 'dev.consumer:1';
  assert.equal(resolveThreadInteraction(document, title), null);
  assert.equal(resolveThreadInteraction(document, document.body), null);
});
test('semantic blocking overlays include target ancestors and visible global overlays, excluding hidden surfaces', t => {
  const dom = new JSDOM('<div role="dialog"><button id="inside">Inside</button></div><div role="menu" hidden></div>');
  t.after(() => dom.window.close());
  const document = dom.window.document, dialog = document.querySelector('[role=dialog]');
  dialog.getClientRects = () => [{}];
  assert.equal(hasBlockingOverlay(document, document.getElementById('inside')), true);
  assert.equal(hasBlockingOverlay(document), true);
  dialog.hidden = true;
  assert.equal(hasBlockingOverlay(document), false);
  dialog.hidden = false; dialog.style.display = 'none';
  assert.equal(hasBlockingOverlay(document), false);
});
