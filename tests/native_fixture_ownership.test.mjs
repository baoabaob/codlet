import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { permissionPickerEvidence } from '../codex/tests/fixtures/workspace-acceptance/native-permission-ownership-readonly.js';
const require = createRequire(import.meta.url);
const { JSDOM } = createRequire(new URL('../frontend/package.json', import.meta.url))('jsdom');
const fixtures = new URL('../codex/tests/fixtures/workspace-acceptance/', import.meta.url);

test('permission diagnostic crosses former depth, node and cache cutoffs within its committed input', t => {
  const dom = new JSDOM('<div id="root"><div data-codex-composer-root><button></button></div></div>');
  t.after(() => dom.window.close());
  const document = dom.window.document, root = document.getElementById('root'), input = root.firstElementChild, trigger = input.firstElementChild;
  const current = {}, owner = { stateNode: input, return: current };
  root.__reactContainer$probe = { stateNode: { current } }; input.__reactFiber$probe = owner; current.child = owner;
  let previous;
  for (let index = 0; index < 2200; index++) { const node = {}; if (previous) previous.sibling = node; else owner.child = node; previous = node; }
  const branch = {}; previous.sibling = branch; previous = branch;
  for (let index = 0; index < 400; index++) { const node = {}; previous.child = node; previous = node; }
  function Picker() { return 'conversationId permissionProfilesOverride setAgentMode setPermissionProfileId'; }
  const arrays = Array.from({ length: 40 }, () => []); arrays[39] = Array(600).fill(null);
  arrays[39][599] = { resolvedConfig: {}, requirements: {}, isConfigDataPending: false };
  previous.type = Picker; previous.memoizedProps = { conversationId: 'synthetic-owned', hostId: 'local' }; previous.updateQueue = { memoCache: { data: arrays } };
  previous.child = { stateNode: trigger };
  const result = permissionPickerEvidence(trigger, { input, scope: { value: { conversationId: 'synthetic-owned' } } }, { threadId: 'synthetic-owned' }, root);
  assert.equal(result.proof, 'input-branch');
  assert.equal(result.conversationMatchesStrictBinding, true);
  assert.ok(result.visited > 2048); assert.ok(result.diagnostics.maxRelativeDepth > 128);
  assert.equal(result.cacheEvidence.arrayCount, 40); assert.equal(result.cacheEvidence.configRecords, 1);
});

test('Native probe Host refuses changed executable source before evaluation', async () => {
  const runId = 'adapter-00000000-0000-4000-a000-000000000000';
  const directory = path.resolve('codex/.artifacts/adapter-native', runId), root = path.join(directory, 'discovery-test');
  const spec = { runId, directory, coordinatorRunId: 'fixture-owner', targetId: 'current-target', registryScope: 'fixture-registry', expressionSha256: '0'.repeat(64) };
  const state = { state: 'ready', runId: spec.coordinatorRunId, labRoot: path.join(directory, 'profile') };
  const evidence = { ...spec, authenticated: true, sandboxReady: true };
  const calls = []; let report;
  const fakeFs = {
    readFileSync(file) { return path.basename(file) === 'owned-run.json' ? JSON.stringify(spec) : path.basename(file) === 'manual-client.json' ? JSON.stringify(state) : path.basename(file) === 'owned-runtime-evidence.json' ? JSON.stringify(evidence) : 'changed executable expression'; },
    writeFileSync(_file, text) { report = JSON.parse(text); },
  };
  const scope = { module: { exports: {} }, require: name => name === 'node:fs' ? fakeFs : require(name) };
  vm.runInNewContext(fs.readFileSync(new URL('native-owned-probe-host.cjs', fixtures), 'utf8'), scope);
  scope.module.exports.activate({ root, cdp: { async request(method) { calls.push(method); if (method === 'Target.getTargets') return { targetInfos: [{ targetId: spec.targetId, type: 'page', url: 'app://-/index.html' }] }; return { sessionId: 'owned-session' }; } } });
  await scope.module.exports.deactivate();
  assert.match(report.error, /expression changed/u);
  assert.equal(calls.includes('Runtime.evaluate'), false);
  assert.equal(calls.at(-1), 'Target.detachFromTarget');
});

test('navigation sampler uses the current unique fixture Target and rejects ambiguity', async () => {
  async function sample(count) {
    let complete; const result = new Promise(resolve => { complete = resolve; });
    const scope = { module: { exports: {} }, setTimeout(fn) { queueMicrotask(fn); return 1; }, clearTimeout() {},
      require: name => name === 'node:fs' ? { writeFileSync(_file, text) { complete(JSON.parse(text)); } } : require(name) };
    vm.runInNewContext(fs.readFileSync(new URL('navigation/host.cjs', fixtures), 'utf8'), scope);
    scope.module.exports.activate({ root: 'fixture', signal: { aborted: false }, cdp: { async request(method, params) {
      if (method === 'Target.getTargets') return { targetInfos: Array.from({ length: count }, (_, index) => ({ targetId: 'current-' + index, type: 'page', url: 'app://-/index.html' })) };
      if (method === 'Target.attachToTarget') return { sessionId: params.targetId };
      if (method === 'Runtime.evaluate') return { result: { value: params.expression.startsWith('!!') ? true : { result: { status: 'passed' } } } };
      return {};
    } } });
    return result;
  }
  assert.equal((await sample(1)).targetId, 'current-0');
  assert.match((await sample(2)).error, /unique current/u);
});
