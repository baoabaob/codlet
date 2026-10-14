import {mkdirSync,writeFileSync} from 'node:fs';
import {spawnSync,execFileSync} from 'node:child_process';
// Run the entire UI lifecycle suite in a bounded child process. Enumerating
// test names with regex misses dynamically generated cleanup scenarios.
const baseline=process.argv.includes('--baseline');
if(baseline){mkdirSync('.codlet-artifacts',{recursive:true});writeFileSync('.codlet-artifacts/core-ui-baseline.js',execFileSync('git',['show','HEAD:bundled/runtime/ui.js'],{maxBuffer:10*1024*1024}));}
const env={...process.env};delete env.CODLET_UI_FIXTURE_SOURCE;
if(baseline)env.CODLET_UI_FIXTURE_SOURCE='.codlet-artifacts/core-ui-baseline.js';
const result=spawnSync(process.execPath,['--test','tests/ui_helpers.test.mjs'],{env,encoding:'utf8',timeout:60000});
console.log(result.stdout??'',result.stderr??'');
console.log(JSON.stringify({baseline,status:result.status,error:result.error?.code}));
process.exitCode=result.status===0?0:1;
