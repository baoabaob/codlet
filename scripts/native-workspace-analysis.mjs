import fs from 'node:fs';
import path from 'node:path';
import { workspaceSourceAnalysis } from './lib/native-workspace-analysis.mjs';

const [input, output] = process.argv.slice(2);
if (!path.isAbsolute(input ?? '') || !path.isAbsolute(output ?? '') || fs.existsSync(output)) throw Error('Pass an absolute index JSON and a new absolute output JSON');
const report = workspaceSourceAnalysis(JSON.parse(fs.readFileSync(input, 'utf8')));
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ identity: report.identity, roles: Object.fromEntries(Object.entries(report.roles).map(([name, value]) =>
  [name, { status: value.status, candidates: value.candidates.map(item => ({ file: path.basename(item.file), local: item.local, exports: item.exports })) }])) }, null, 2));
