import fs from 'node:fs';
import path from 'node:path';
import { applySourceReviews, compareNativeSources, proposeWorkspaceLookupPatch, sourceDiffMarkdown } from './lib/native-source-diff.mjs';
const [previousPath, currentPath, output, ...options] = process.argv.slice(2);
let coreFile, reviewFile;
for (let i = 0; i < options.length; i++) {
  if (options[i] === '--core' && options[i + 1]) coreFile = options[++i];
  else if (options[i] === '--review' && options[i + 1]) reviewFile = options[++i];
  else if (options.length === 1 && path.isAbsolute(options[i])) coreFile = options[i];
  else throw Error('Optional arguments: --core FILE --review REVIEW_JSON');
}
if (![previousPath, currentPath, output].every(value => path.isAbsolute(value ?? '')) || fs.existsSync(output)) throw Error('Pass previous/current analysis JSON, a new output directory and optionally the Core discovery file');
const previous = JSON.parse(fs.readFileSync(previousPath, 'utf8')), current = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
const report = compareNativeSources(previous, current);
if (reviewFile) applySourceReviews(report, JSON.parse(fs.readFileSync(reviewFile, 'utf8')));
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'diff.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
fs.writeFileSync(path.join(output, 'diff.md'), sourceDiffMarkdown(report), { flag: 'wx' });
if (coreFile) {
  const proposal = proposeWorkspaceLookupPatch(fs.readFileSync(coreFile, 'utf8'), current);
  fs.writeFileSync(path.join(output, 'workspace-discovery.candidate.js'), proposal.candidate, { flag: 'wx' });
  fs.writeFileSync(path.join(output, 'workspace-discovery.patch'), proposal.patch, { flag: 'wx' });
  const { candidate, patch, ...metadata } = proposal;
  fs.writeFileSync(path.join(output, 'patch-evidence.json'), JSON.stringify({ coreFile, ...metadata }, null, 2) + '\n', { flag: 'wx' });
}
console.log(JSON.stringify({ output, mappedBindings: report.mappedBindings, changes: report.changes.map(change => ({
  role: change.role, classification: change.classification, from: change.previous?.file, to: change.current?.file })) }, null, 2));
