// Produce review excerpts from verified offsets; never evaluate the source.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { digest, relativeSourcePath } from './lib/native-source-snapshot.mjs';
import { parseSourceModel, normalizedSource } from './lib/native-source-index.mjs';
const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const { transformSync } = require('esbuild');
const [analysisPath, role, output] = process.argv.slice(2);
if (!path.isAbsolute(analysisPath ?? '') || !path.isAbsolute(output ?? '') || fs.existsSync(output)) throw Error('Pass analysis JSON, role name and a new absolute output directory');
const analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf8'));
const candidates = role === 'all' ? Object.entries(analysis.roles).flatMap(([name, value]) =>
  value.candidates.map(candidate => ({ ...candidate, role: name }))) : analysis.roles[role]?.candidates;
if (!candidates?.length) throw Error('The requested role has no located candidates');
fs.mkdirSync(output, { recursive: true });
const entries = candidates.map((candidate, index) => {
  const source = fs.readFileSync(path.join(analysis.snapshot, 'sources', relativeSourcePath(candidate.file)), 'utf8');
  if (digest(source) !== candidate.sha256) throw Error('Source identity differs from the analysis');
  const text = source.slice(candidate.start.offset, candidate.end.offset);
  const safeName = value => String(value).replace(/[^\w-]/g, '_');
  const name = `${candidate.role ? safeName(candidate.role) + '-' : ''}${index}-${safeName(candidate.local)}.js`;
  fs.writeFileSync(path.join(output, name), transformSync(`(${text})`, { loader: 'js', minify: false, treeShaking: false }).code, { flag: 'wx' });
  const dependencies = [...new Set(candidate.dependencies.map(value => value.name))];
  const prefix = dependencies.length ? `var ${dependencies.join(',')};\n` : '';
  const model = parseSourceModel(prefix + (['FunctionDeclaration', 'ClassDeclaration'].includes(candidate.type) ? text : `(${text});`));
  const statement = model.ast.body.at(-1), node = statement.type === 'ExpressionStatement' ? statement.expression : statement;
  const normalized = normalizedSource(node, model), normalizedFile = name.replace(/\.js$/, '.normalized.json');
  fs.writeFileSync(path.join(output, normalizedFile), JSON.stringify(normalized.normalized, null, 2) + '\n', { flag: 'wx' });
  return { ...candidate, excerpt: name, excerptSourceSha256: digest(text), normalizedFile,
    normalizedHashMatchesIndex: normalized.hash === candidate.normalizedHash };
});
fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify({ identity: analysis.identity,
  snapshotSha256: analysis.snapshotSha256, role, entries }, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ role, output, candidates: entries.length }));
