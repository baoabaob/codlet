import fs from 'node:fs';
import path from 'node:path';
import { indexSnapshot } from './lib/native-source-index.mjs';

const args = process.argv.slice(2), options = {}, roots = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--all') { options.all = true; continue; }
  if (!['--snapshot', '--output', '--root'].includes(args[i]) || !args[i + 1]) throw Error('Use --snapshot DIR --output NEW_JSON [--root MODULE] [--all]');
  const key = args[i++].slice(2);
  if (key === 'root') roots.push(args[i]); else options[key] = args[i];
}
if (!path.isAbsolute(options.snapshot ?? '') || !path.isAbsolute(options.output ?? '') || fs.existsSync(options.output)) throw Error('Use an absolute snapshot path and a new absolute report path');
const report = await indexSnapshot(options.snapshot, { all: options.all, roots: roots.length ? roots : undefined,
  onModule: event => console.log(JSON.stringify(event)) });
fs.writeFileSync(options.output, JSON.stringify(report) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output: options.output, modules: report.modules.length,
  records: report.modules.reduce((sum, module) => sum + module.records.length, 0), missing: report.analysis.missing.length }));
