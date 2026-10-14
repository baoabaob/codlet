// Prepare an empty owned profile and exit BEFORE Desktop/backend startup.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {auditedVersions} from './prepare-core-native-run.mjs';
const manifestFile=path.resolve(process.argv[2]??'');
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
if(!/^core-[a-f0-9-]{36}$/.test(manifest.runId)||manifest.launched!==false)throw Error('Expected an unlaunched Core run plan');
const directory=path.join(repo,'.codlet-artifacts/core-native',manifest.runId);
if(manifestFile!==path.join(directory,'preflight.json')||path.resolve(manifest.planned.profileRoot)!==path.join(directory,'profile'))throw Error('Plan is not owned by this repository/run');
if(fs.existsSync(manifest.planned.profileRoot))throw Error('Profile already exists; preparation never resumes or overwrites it');
const version=manifest.installedPackage?.Version;
if(!auditedVersions(fs.readFileSync(path.join(repo,'src/lab.rs'),'utf8')).includes(version))throw Error('Current version has no static IPC review');
const lab=manifest.inputs?.labBinary??path.join(repo,'target/debug/codlet-lab.exe');
const relative=path.relative(repo,path.resolve(lab));if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('Planned lab executable is outside this workspace');
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if(sha(lab)!==manifest.hashes.labBinary)throw Error('Lab changed after preflight; generate a new run plan');
const reserve=net.createServer();await new Promise((resolve,reject)=>{reserve.once('error',reject);reserve.listen(0,'127.0.0.1',resolve);});
const endpoint='ws://127.0.0.1:'+reserve.address().port;
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|PATH|PATHEXT|OS|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|USERNAME|USERDOMAIN|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|COMMONPROGRAMFILES|COMMONPROGRAMFILES\(X86\)|COMMONPROGRAMW6432)$/i.test(key)));
const child=spawn(lab,['--experimental-isolated-client','--root',manifest.planned.profileRoot,'--expected-package-version',version,'--app-server-url',endpoint],{cwd:repo,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
child.stdin.on('error',()=>{});child.stdin.end('quit\n');
try{
  const exitCode=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
  fs.writeFileSync(path.join(directory,'prepare.stdout.jsonl'),stdout,{flag:'wx'});
  fs.writeFileSync(path.join(directory,'prepare.stderr.log'),stderr,{flag:'wx'});
  const rows=stdout.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
  if(exitCode!==0||rows.some(row=>row.event==='child_created'))throw Error('Preparation did not exit cleanly before Desktop creation; see owned prepare logs');
  const prepared=rows.find(row=>row.event==='prepared')?.detail;
  if(!prepared||path.resolve(prepared.root)!==manifest.planned.profileRoot||prepared.package_version!==version)throw Error('Prepared identity mismatch');
  const evidence={schema:1,runId:manifest.runId,state:'profile_prepared_no_client',labBinarySha256:sha(lab),exitCode,desktopCreated:false,backendCreated:false,prepared};
  fs.writeFileSync(path.join(directory,'prepared-profile.json'),JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({runId:manifest.runId,state:evidence.state,evidence:path.join(directory,'prepared-profile.json')}));
}finally{await new Promise(resolve=>reserve.close(resolve));}
