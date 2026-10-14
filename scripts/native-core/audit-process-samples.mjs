// Historical, read-only audit. Does not enumerate/control live processes.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const [runArg,adapterBeforeArg,adapterClosedArg,outputArg]=process.argv.slice(2);
if(!outputArg)throw Error('Usage: audit-process-samples.mjs <Core run> <Adapter before> <Adapter closed> <new output>');
const run=path.resolve(runArg),output=path.resolve(outputArg),manifest=[];
const hash=b=>createHash('sha256').update(b).digest('hex');
function read(file){const bytes=fs.readFileSync(file);manifest.push({path:path.resolve(file),sha256:hash(bytes),bytes:bytes.length});return JSON.parse(bytes);}
const epoch=116444736000000000n;
function ticks(value){
 if(/^\d+$/.test(String(value)))return BigInt(value);
 const m=/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?Z$/.exec(value);
 if(!m)throw Error('Unrecognized creation timestamp');
 return epoch+BigInt(Date.parse(m[1]+'Z'))*10000n+BigInt((m[2]??'').padEnd(7,'0'));
}
const key=p=>`${p.pid}:${ticks(p.filetime??p.created)}`;
const microKey=p=>`${p.pid}:${ticks(p.filetime??p.created)/10n}`;
const utc=t=>new Date(Number((t-epoch)/10000n)).toISOString();
const proof=read(path.join(run,'owned-runtime-evidence.json'));
const state=read(path.join(run,'profile/logs','coordinator-'+proof.coordinatorRunId,'state.json'));
const roots=new Map(proof.processes.map(p=>[key(p),p]));
const earliest=[...roots.values()].map(p=>ticks(p.filetime)).reduce((a,b)=>a<b?a:b);
const adapterBefore=read(adapterBeforeArg),adapterClosed=read(adapterClosedArg);
const adapterRootPid=Number(adapterBefore.coordinatorRunId.split('-').at(-1));
const adapterRoots=adapterBefore.processes.filter(p=>p.pid===adapterRootPid);
if(adapterRoots.length!==1)throw Error('Ambiguous Adapter coordinator record');
// Identify the reported suspect set by time/identity, never by image name.
const suspects=adapterBefore.processes.filter(p=>ticks(p.created)<ticks(adapterRoots[0].created));
const suspectKeys=new Set(suspects.map(key)),priorKeys=new Set(state.before.map(microKey));
const closedKeys=new Set(adapterClosed.remainingOwnedProcesses.map(key));
const rows=[],union=new Map();let cellSet;
for(const count of [0,1,2,4,5,8])for(const style of ['neutral-split','styled']){
 const file=path.join(run,`idle-${count}-${style}.json`),data=read(file),beforeKeys=data.before.map(key),afterKeys=data.after.map(key);
 const sameEndpoints=beforeKeys.length===afterKeys.length&&beforeKeys.every(k=>afterKeys.includes(k));
 const current=new Set(beforeKeys),sameAsFirst=cellSet==null||current.size===cellSet.size&&[...current].every(k=>cellSet.has(k));cellSet??=current;
 const entries=[...data.before,...data.after];entries.forEach(p=>union.set(key(p),p));
 const base=new Map(data.before.map(p=>[key(p),p.cpuSeconds]));
 const cpu=data.after.reduce((n,p)=>n+p.cpuSeconds-(base.get(key(p))??0),0);
 rows.push({file:path.basename(file),startedAt:data.startedAt,rowsBefore:data.before.length,rowsAfter:data.after.length,uniqueBefore:current.size,sameEndpoints,sameAsFirst,
   allRootsMatch:[...roots.keys()].every(k=>current.has(k)),olderThanEarliestRoot:entries.filter(p=>ticks(p.created)<earliest).map(key),
   knownPriorOverlap:[...new Set(entries.filter(p=>priorKeys.has(microKey(p))).map(key))],suspectIdentityOverlap:[...new Set(entries.filter(p=>suspectKeys.has(key(p))).map(key))],
   cpuDeltaMatches:Math.abs(cpu-data.cpuSeconds)<1e-9,
   hasParentEdges:entries.every(p=>p.parentPid!=null&&p.parentCreated!=null),hasSamplerDigest:!!data.samplerSha256});
}
const retired=read(path.join(run,'background-exit-receipt.json'));
const retiredKeys=new Set(retired.recorded.map(key));
const creationTimes=[...union.values()].map(p=>ticks(p.created));
const audit={schema:1,auditedAt:new Date().toISOString(),coreRun:proof.runId,coordinatorRunId:proof.coordinatorRunId,
 scope:'Historical files only; no live process lookup, client startup, measurement rerun or process control',
 sourceInputs:manifest,
 roots:proof.processes.map(p=>({pid:p.pid,filetime:p.filetime,created:p.created})),
 samples:rows,identities:[...union.values()].map(p=>({pid:p.pid,filetime:p.created,createdUtc:utc(ticks(p.created)),name:p.name,independentlyAnchoredRoot:roots.has(key(p))})),
 sampleSummary:{cells:rows.length,endpointRows:rows.reduce((n,r)=>n+r.rowsBefore+r.rowsAfter,0),uniqueIdentities:union.size,allCellsSameIdentities:rows.every(r=>r.sameAsFirst&&r.sameEndpoints),
   earliestCreatedUtc:utc(creationTimes.reduce((a,b)=>a<b?a:b)),latestCreatedUtc:utc(creationTimes.reduce((a,b)=>a>b?a:b)),
   allRootIdentitiesPresent:rows.every(r=>r.allRootsMatch),allCpuDeltasRecompute:rows.every(r=>r.cpuDeltaMatches),olderThanEarliestRoot:rows.some(r=>r.olderThanEarliestRoot.length),knownPriorIdentityOverlap:rows.some(r=>r.knownPriorOverlap.length)},
 adapterComparison:{suspectSelection:'Created before that run coordinator; no process-name filter',suspectCount:suspects.length,suspects:suspects.map(p=>({pid:p.pid,created:p.created,filetime:String(ticks(p.created))})),allSuspectsInClosedRemaining:suspects.every(p=>closedKeys.has(key(p))),coreSampleIdentityMatches:[...union.keys()].filter(k=>suspectKeys.has(k)),coreExitIdentityMatches:[...retiredKeys].filter(k=>suspectKeys.has(k))},
 exit:{recorded:retired.recorded.length,uniqueIdentities:retiredKeys.size,exactRootIdentitiesPresent:[...roots.keys()].every(k=>retiredKeys.has(k)),overlapWithSample:[...retiredKeys].filter(k=>union.has(k)).length,
   olderThanEarliestRoot:retired.recorded.filter(p=>ticks(p.filetime)<earliest).map(key),knownPriorOverlap:retired.recorded.filter(p=>priorKeys.has(microKey(p))).map(key),
   receiptState:retired.state,hostExit:retired.hostExit,recordedRemaining:retired.remaining.length,independentReceiptRemaining:retired.independentExitCheck?.remaining?.length??null,
   missingAncestry:retired.recorded.some(p=>p.parentPid==null||p.parentCreated==null)},
 conclusion:{knownReportedExternalIdentitiesPresent:false,completeHistoricalOwnershipCertification:false,
   limitation:'Files retain PID+creation identity but not historical parent PID/creation edges, full selection snapshots or the sampler digest. Age bounds and non-overlap exclude the reported older-process pattern and known identities, but cannot prove that every later-created non-root was an owned descendant or eliminate a scan-to-handle PID-reuse race. Do not infer total ownership from executable names.'}};
audit.conclusion.knownReportedExternalIdentitiesPresent=audit.adapterComparison.coreSampleIdentityMatches.length>0||audit.adapterComparison.coreExitIdentityMatches.length>0;
if(fs.existsSync(output))throw Error('Audit output already exists; preserve prior evidence');
for(const entry of manifest)if(hash(fs.readFileSync(entry.path))!==entry.sha256)throw Error('An input changed during read-only audit');
fs.writeFileSync(output,JSON.stringify(audit,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output,samples:audit.sampleSummary,adapter:audit.adapterComparison,exit:audit.exit,conclusion:audit.conclusion}));
