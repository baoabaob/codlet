import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { indexSource } from '../scripts/lib/native-source-index.mjs';
import { digest } from '../scripts/lib/native-source-snapshot.mjs';
import { officialUpdateSourceAnalysis } from '../scripts/lib/native-official-update-analysis.mjs';

function fixture(t, { extra = '', callback = '({get:read})=>read(update).isUpdateReady', service = 'services' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codlet-update-source-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const sources = {
    'webview/assets/index-ab12.js': 'import "./app-initial-a.js";',
    'webview/assets/app-shared-b.js': 'export const scope=createScope("AppScope");export let services;export function init(value){services=value}',
    'webview/assets/app-initial-a.js': `import {scope,services} from './app-shared-b.js';
      const initial={downloadProgressPercent:null,installProgressPercent:null,isUpdateReady:false,lifecycleState:'idle',relaunchNotice:null,supportsAutoInstallWhenIdle:false};
      const update=atom(scope,initial);export const ready=derived(scope,${callback});
      export function install(){${service}.appUpdates?.installUpdate()}${extra}`,
  };
  const files = Object.entries(sources).map(([name, source]) => {
    const file = path.join(root, 'sources', name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, source);
    return { path: name, sha256: digest(source), bytes: Buffer.byteLength(source) };
  });
  const manifest = { files }, metadata = JSON.stringify(manifest);
  fs.writeFileSync(path.join(root, 'snapshot.json'), metadata);
  return { snapshot: root, snapshotSha256: digest(metadata), identity: { appVersion: '1.2.3', buildNumber: '42' },
    modules: Object.entries(sources).map(([name, source]) => indexSource(source, name)) };
}

test('update analysis follows scoped state and a moved service through imports without executing source', t => {
  const result = officialUpdateSourceAnalysis(fixture(t));
  assert.equal(result.status, 'located');
  assert.equal(result.profile.servicesModule, 'app://-/assets/app-shared-b.js');
  assert.equal(result.profile.officialUpdates.stateSelector, 'ready');
  assert.equal(result.evidence.installCalls.length, 1);
});

test('duplicate selectors or a shadowed install service cannot produce a profile', t => {
  assert.equal(officialUpdateSourceAnalysis(fixture(t, { extra: 'export const another=derived(scope,({get:r})=>r(update).isUpdateReady);' })).profile, null);
  assert.equal(officialUpdateSourceAnalysis(fixture(t, { service: 'unexportedLocal' })).profile, null);
  assert.equal(officialUpdateSourceAnalysis(fixture(t, { extra: 'export function other(services){services.appUpdates.installUpdate()}' })).evidence.installCalls.length, 1);
});

test('changed selector behavior and changed captured bytes fail the mapping gate', t => {
  assert.equal(officialUpdateSourceAnalysis(fixture(t, { callback: '({get:read})=>!read(update).isUpdateReady' })).profile, null);
  const input = fixture(t);
  fs.appendFileSync(path.join(input.snapshot, 'sources/webview/assets/app-shared-b.js'), '\n// changed');
  assert.throws(() => officialUpdateSourceAnalysis(input), /source changed/);
});
