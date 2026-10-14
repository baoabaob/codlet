// Read-only installed-package preflight plus a NEW plan directory. Never starts
// Desktop/backend, copies credentials, contacts CDP or selects a current target.
import {readFileSync,writeFileSync,mkdirSync,existsSync,lstatSync,realpathSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export function auditedVersions(source){
  const first=source.match(/const AUDITED_PACKAGE_VERSION: &str = "([\d.]+)";/)?.[1];
  const rest=source.match(/const AUDITED_PACKAGE_VERSIONS: &\[&str\] = &\[([\s\S]*?)\];/)?.[1];
  if(!first||!rest)throw Error('Cannot identify the isolated-launcher version policy');
  return [...new Set([first,...[...rest.matchAll(/"([\d.]+)"/g)].map(match=>match[1])])];
}
export function preflightBlockers(packages,versions,files){
  const reasons=[];
  if(packages.length!==1)reasons.push('installed_package_not_unique');
  else if(!versions.includes(packages[0].Version)||packages[0].PackageFullName!==`OpenAI.Codex_${packages[0].Version}_x64__2p2nqsd0c76g0`)reasons.push('installed_package_ipc_isolation_not_reviewed');
  if(!files.labBinaryPresent)reasons.push('lab_binary_missing');
  if(!files.officialCliPresent)reasons.push('official_cli_missing');
  else if(files.officialCliSignature!=='Valid')reasons.push('official_cli_signature_not_valid');
  // A successful static preflight never attests a running instance or data.
  reasons.push('fresh_profile_and_backend_effective_config_not_verified','run_pid_target_and_synthetic_data_not_verified');
  return reasons;
}

function main(){
  if(process.platform!=='win32')throw Error('This preparation targets the Windows isolated launcher');
  const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const args=process.argv.slice(2);
  if(args.length!==0&&(args.length!==2||args[0]!=='--lab-binary'))throw Error('Optional argument is --lab-binary <absolute immutable owned executable>');
  const selected=args.length?args[1]:null;
  if(selected&&!path.isAbsolute(selected))throw Error('Selected lab executable must be absolute');
  const powershell=path.join(process.env.SYSTEMROOT??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const ps=(source,extra={})=>JSON.parse(execFileSync(powershell,['-NoProfile','-NonInteractive','-Command',source],{encoding:'utf8',windowsHide:true,env:{...process.env,...extra}}).trim()||'null');
  const found=ps('Get-AppxPackage -Name OpenAI.Codex | Select-Object Name,Version,PackageFullName,InstallLocation | ConvertTo-Json -Compress');
  const packages=found==null?[]:Array.isArray(found)?found:[found],versions=auditedVersions(readFileSync(path.join(repo,'src/lab.rs'),'utf8'));
  const installed=packages.length===1?packages[0]:null;
  const cli=installed?path.join(installed.InstallLocation,'app/resources/codex.exe'):null;
  const native=installed?path.join(installed.InstallLocation,'app/ChatGPT.exe'):null;
  const lab=selected?path.resolve(selected):path.join(repo,'target/debug/codlet-lab.exe');
  if(selected){const relative=path.relative(repo,lab),stat=lstatSync(lab);if(relative.startsWith('..')||path.isAbsolute(relative)||stat.isSymbolicLink()||!stat.isFile()||stat.nlink!==1||path.resolve(realpathSync(lab)).toLowerCase()!==lab.toLowerCase())throw Error('Selected executable must be a detached plain file within this workspace');}
  const nodeRuntime=path.join(path.dirname(lab),'runtime/node-v24.21.0-win-x64');
  for(const name of ['node.exe','LICENSE'])if(!existsSync(path.join(nodeRuntime,name)))throw Error('Selected lab runtime is incomplete: '+name);
  const runtimePin=path.join(path.dirname(lab),'runtime/node-runtime.json');
  if(!existsSync(runtimePin))throw Error('Selected lab runtime pin is missing');
  const files={labBinaryPresent:existsSync(lab),officialCliPresent:!!cli&&existsSync(cli),officialCliSignature:null};
  if(files.officialCliPresent)files.officialCliSignature=ps('(Get-AuthenticodeSignature -LiteralPath $env:CODLET_CORE_PREFLIGHT_CLI).Status.ToString() | ConvertTo-Json -Compress',{CODLET_CORE_PREFLIGHT_CLI:cli});
  const sha=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
  const runId='core-'+randomUUID(),directory=path.join(repo,'.codlet-artifacts/core-native',runId),profileRoot=path.join(directory,'profile');
  const record={schemaVersion:1,runId,state:'prepared_plan_only',launched:false,installedPackage:installed,reviewedIsolatedPackageVersions:versions,files,
    inputs:{labBinary:lab,nodeRuntime,runtimePin,nativeExecutable:native},
    hashes:{ui:sha(path.join(repo,'bundled/runtime/ui.js')),launcherSource:sha(path.join(repo,'src/lab.rs')),labBinary:files.labBinaryPresent?sha(lab):null,officialCli:files.officialCliPresent?sha(cli):null,nativeExecutable:native&&existsSync(native)?sha(native):null,runtimeNode:sha(path.join(nodeRuntime,'node.exe')),runtimeLicense:sha(path.join(nodeRuntime,'LICENSE')),runtimePin:sha(runtimePin)},
    planned:{profileRoot,registry:path.join(profileRoot,'codlet/config.json'),userData:path.join(profileRoot,'user-data'),codexHome:path.join(profileRoot,'codex-home'),sqliteHome:path.join(profileRoot,'sqlite'),project:path.join(profileRoot,'project')},
    effective:{registry:null,profile:null,managerPid:null,corePid:null,backendPid:null,desktopPid:null,target:null,backendConfigVerified:false,syntheticDataVerified:false},
    blockers:preflightBlockers(packages,versions,files),noCredentialsOrSessionsCopied:true};
  mkdirSync(directory,{recursive:true});writeFileSync(path.join(directory,'preflight.json'),JSON.stringify(record,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({runId,state:record.state,installedVersion:installed?.Version??null,blockers:record.blockers,manifest:path.join(directory,'preflight.json')}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main();
