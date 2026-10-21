import fs from 'node:fs';
import path from 'node:path';
import { officialUpdateSourceAnalysis } from './lib/native-official-update-analysis.mjs';
const [input, output] = process.argv.slice(2);
if (!input || !path.isAbsolute(output ?? '') || fs.existsSync(output)) throw Error('Use INDEX_JSON NEW_ABSOLUTE_REPORT_JSON');
const report = officialUpdateSourceAnalysis(JSON.parse(fs.readFileSync(input, 'utf8')));
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, status: report.status, counts: report.counts, profile: report.profile }, null, 2));
if (report.status !== 'located') process.exitCode = 1;
