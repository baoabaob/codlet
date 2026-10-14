import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceMetrics } from '../frontend/src/adapter/workspace-metrics.js';

test('disabled test points do no setup and never read the supplied clock', () => {
  assert.equal(createWorkspaceMetrics(), null);
  assert.equal(createWorkspaceMetrics({ enabled: false, get now() { assert.fail('disabled clock setup'); } }), null);
});

test('measurement reports are bounded, chronological and contain only fixed fields and numeric aliases', () => {
  let clock = 0;
  const metrics = createWorkspaceMetrics({ enabled: true, runId: 'offline-fixture', capacity: 3, now: () => clock++ });
  const operationId = metrics.nextOperation(), viewId = metrics.nextView();
  metrics.add('composer.begin', { operationId, viewId, threadAlias: 1 });
  const start = metrics.start();
  metrics.end('composer.bind', start, { operationId, viewId, threadAlias: 1 });
  metrics.add('composer.close', { threadAlias: 'private-identity', draft: 'private text', path: 'private path' });
  metrics.add('surface.geometry');
  const report = metrics.report();
  assert.equal(report.written, 4); assert.equal(report.samples.length, 3);
  assert.deepEqual(report.samples.map(sample => sample.phase), ['composer.bind', 'composer.close', 'surface.geometry']);
  assert.equal(report.samples[0].duration, 1); assert.equal(report.samples[1].threadAlias, null);
  assert.equal(JSON.stringify(report).includes('private'), false);
  assert.equal(report.counts['composer.begin'], 1);
  assert.throws(() => metrics.add('draft content here'), TypeError);
});
