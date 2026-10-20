import { digest } from './native-source-snapshot.mjs';
import { parseSourceModel, walkSource } from './native-source-index.mjs';

const roleLabels = { appScope: 'AppScope', composerScope: 'composer scope', threadScope: 'thread scope', routeScope: 'route scope' };
const candidateKey = value => `${value.file}#${value.binding}`;
const moduleRole = value => value.replace(/-[^/-]+\.js$/, '.js');
const singleton = role => role?.status === 'located' && role.candidates.length === 1 ? role.candidates[0] : null;

export function compareNativeSources(previous, current) {
  const mapping = new Map(), groups = values => {
    const result = new Map();
    for (const value of values) {
      if (value.unresolved) continue;
      if (!result.has(value.hash)) result.set(value.hash, new Set());
      result.get(value.hash).add(value.key);
    }
    return result;
  };
  const oldHashes = groups(previous.structures), newHashes = groups(current.structures);
  for (const [hash, old] of oldHashes) if (old.size === 1 && newHashes.get(hash)?.size === 1) {
    mapping.set([...old][0], { key: [...newHashes.get(hash)][0], evidence: 'unique-binding-normalized-structure' });
  }
  for (const [role, value] of Object.entries(previous.roles)) {
    const old = singleton(value), next = singleton(current.roles[role]);
    if (old && next) mapping.set(candidateKey(old), { key: candidateKey(next), evidence: `semantic-role:${role}` });
  }
  const changes = [];
  for (const name of new Set([...Object.keys(previous.roles), ...Object.keys(current.roles)])) {
    const before = previous.roles[name], after = current.roles[name], old = singleton(before), next = singleton(after);
    const change = { role: name, capabilities: after?.capabilities ?? before?.capabilities ?? [],
      previousStatus: before?.status ?? 'not-indexed', currentStatus: after?.status ?? 'not-indexed', previous: old, current: next,
      classification: 'unresolved', reasons: [], dependencies: [], automaticPatch: false };
    if (!old || !next) {
      change.reasons.push(!old ? 'The baseline has no unique located responsibility; missing source is not evidence of a removed API.' :
        'The current source has no unique located responsibility.');
    } else {
      change.dependencies = old.dependencies.map((dependency, i) => {
        const other = next.dependencies[i], mapped = dependency.resolved && mapping.get(dependency.resolved);
        return { previous: dependency, current: other ?? null,
          relation: dependency.resolved && other?.resolved && mapped?.key === other.resolved ? 'mapped' : 'unresolved',
          basis: mapped?.evidence ?? null };
      });
      if (old.normalizedHash === next.normalizedHash && old.dependencies.length === next.dependencies.length) {
        const complete = change.dependencies.every(dependency => dependency.relation === 'mapped');
        if (!complete) {
          change.reasons.push('The local AST is preserved, but one or more external binding relationships remain unresolved.');
        } else {
          change.classification = moduleRole(old.file) !== moduleRole(next.file) ? 'module-relocation' :
            old.local !== next.local || JSON.stringify(old.exports) !== JSON.stringify(next.exports) ? 'mechanical-rename' : 'structure-preserved';
          change.reasons.push('Binding-normalized syntax and corresponding external references match; live behavior is separately verified.');
          change.automaticPatch = true;
        }
      } else if (old.interfaceHash !== next.interfaceHash) {
        change.classification = 'interface-change';
        change.reasons.push('The declared parameters, object fields, call signature or class interface changed.');
      } else {
        change.classification = 'unresolved';
        change.reasons.push('The body changed without a declared signature change. Behavioral impact and compiler-only changes need source review.');
      }
    }
    changes.push(change);
  }
  const capabilities = {};
  for (const change of changes) for (const capability of change.capabilities) {
    const item = capabilities[capability] ??= { changes: [], sourceReviewRequired: false, simulated: 'not-verified', live: 'not-verified' };
    item.changes.push(change.role);
    if (!['structure-preserved', 'mechanical-rename', 'module-relocation'].includes(change.classification)) item.sourceReviewRequired = true;
  }
  return { schema: 1, kind: 'native-source-diff', previous: { identity: previous.identity, snapshot: previous.snapshot, sha256: previous.snapshotSha256 },
    current: { identity: current.identity, snapshot: current.snapshot, sha256: current.snapshotSha256 },
    changes, capabilities, mappedBindings: mapping.size,
    limits: ['A structure match is not a proof of semantic equivalence.', 'Behavioral changes require explicit source evidence or remain unresolved.',
      'No test or live compatibility result is inferred from a source diff.'] };
}

// Reviews are tied to both snapshots and both declarations. An old decision
// cannot silently classify a later build with a similarly named function.
export function applySourceReviews(report, reviews) {
  if (reviews?.schema !== 1 || reviews.previousSnapshotSha256 !== report.previous.sha256 ||
      reviews.currentSnapshotSha256 !== report.current.sha256) throw Error('Source review snapshot identity mismatch');
  const seen = new Set();
  for (const review of reviews.decisions ?? []) {
    if (seen.has(review.role)) throw Error('Duplicate source review role');
    seen.add(review.role);
    const change = report.changes.find(item => item.role === review.role);
    if (!change?.previous || !change.current) throw Error(`Review needs both source declarations: ${review.role}`);
    for (const side of ['previous', 'current']) for (const field of ['file', 'sha256', 'normalizedHash']) {
      if (review[side]?.[field] !== change[side][field]) throw Error(`Source review declaration identity mismatch: ${review.role}.${side}.${field}`);
    }
    if (!['interface-change', 'behavior-change', 'unresolved'].includes(review.classification) ||
        !review.observation || !review.coreImpact) throw Error('Source review requires an explicit observation, impact and supported classification');
    change.automaticClassification = change.classification;
    change.classification = review.classification; change.review = review; change.automaticPatch = false;
    change.reasons.push(review.observation);
  }
  for (const item of Object.values(report.capabilities)) {
    item.sourceReviewRequired = item.changes.some(name => {
      const change = report.changes.find(item => item.role === name);
      return change.classification === 'unresolved' || !change.review &&
        !['structure-preserved', 'mechanical-rename', 'module-relocation'].includes(change.classification);
    });
  }
  return report;
}

// Review-only codemod: retain each existing predicate and uniqueness check, while
// resolving its verified semantic role across Core's already loaded module pool.
// Semantic predicate/data-flow changes are deliberately not generated here.
export function proposeWorkspaceLookupPatch(source, analysis, target = 'codex/frontend/src/adapter/workspace-discovery.js') {
  const model = parseSourceModel(source), byLabel = new Map(), edits = [];
  for (const [name, role] of Object.entries(analysis.roles)) if (singleton(role)) byLabel.set(role.label ?? roleLabels[name], { name, role });
  walkSource(model.ast, node => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier' || node.callee.name !== 'uniqueExport') return;
    const binding = model.bindingFor.get(node.callee);
    if (!binding?.defs.some(definition => definition.type === 'ImportBinding' &&
        definition.node.imported?.name === 'uniqueExport' &&
        definition.parent?.source?.value?.endsWith('host-discovery.js'))) return;
    const label = node.arguments[2]?.value, located = byLabel.get(label);
    if (!located || !node.arguments[0]) return;
    edits.push({ role: located.name, start: node.callee.start, end: node.callee.end, before: 'uniqueExport', after: 'uniqueModuleExport' });
    edits.push({ role: located.name, start: node.arguments[0].start, end: node.arguments[0].end,
      before: source.slice(node.arguments[0].start, node.arguments[0].end), after: 'native.modules' });
  });
  if (!source.includes('uniqueModuleExport,') || !source.includes('modules: moduleNamespaces')) throw Error('Install the reviewed module-pool helper before proposing lookup edits');
  let candidate = source;
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
    if (candidate.slice(edit.start, edit.end) !== edit.before) throw Error('Core source changed during patch preparation');
    candidate = candidate.slice(0, edit.start) + edit.after + candidate.slice(edit.end);
  }
  const before = source.split(/\r?\n/), after = candidate.split(/\r?\n/);
  if (before.length !== after.length) throw Error('Lookup-only patch unexpectedly changed line count');
  const hunks = [];
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) hunks.push(`@@\n-${before[i]}\n+${after[i]}\n`);
  return { sourceSha256: digest(source), candidateSha256: digest(candidate), edits, candidate,
    patch: `*** Begin Patch\n*** Update File: ${target}\n${hunks.join('')}*** End Patch\n`,
    limitations: ['This lookup patch retains the old predicates; separately review changed interface predicates and source data flow.'] };
}

export function sourceDiffMarkdown(report) {
  const rows = report.changes.map(change => {
    const location = value => value ? `\`${value.file}:${value.start.line}:${value.start.column}\` (\`${value.local}\`)` : 'Not located in available source';
    return `| ${change.role} | ${change.classification} | ${location(change.previous)} | ${location(change.current)} | ${change.capabilities.join(', ')} |`;
  });
  return `# Native source comparison\n\n${report.previous.identity.packageVersion} → ${report.current.identity.packageVersion}\n\n` +
    '| Responsibility | Classification | Previous source | Current source | Core capabilities |\n| --- | --- | --- | --- | --- |\n' +
    rows.join('\n') + '\n\nThis report records source evidence. Simulated and live validation are separate results.\n';
}
