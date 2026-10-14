// Explicit offline probe. Never connects to a client or records application data.
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {uiFixture,uiSource,tick} from '../tests/support/ui-fixture.mjs';
const stats=values=>{const a=values.slice().sort((a,b)=>a-b);return {n:a.length,p50:a[Math.floor((a.length-1)*.5)]??null,p95:a[Math.floor((a.length-1)*.95)]??null,p99:a[Math.floor((a.length-1)*.99)]??null,max:a.at(-1)??null};};
const require=createRequire(new URL('../frontend/package.json',import.meta.url));
const hash=value=>createHash('sha256').update(value).digest('hex');
const bounded=promise=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('Core benchmark commit timeout')),10000);
  promise.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
});
function commitTracker(){
  let committed=0;const waiters=new Map();
  return {record(revision){committed=revision;for(const [target,resolve] of waiters)if(target<=revision){waiters.delete(target);resolve();}},wait(revision){return committed>=revision?Promise.resolve():new Promise(resolve=>waiters.set(revision,resolve));}};
}
const results=[];
for(const items of [20,200,2000])for(const count of [0,1,2,4,5,8]){
  const f=uiFixture(),baselineObservers=f.observers.size,ui=f.context.ui.create(),roots=[],requests=[],commits=[],containers=[],cleanup=[],initialCommits=[];
  let coalesced=0;
  try {
  const content=ui.React.createElement('div',null,...Array.from({length:items},(_,i)=>ui.React.createElement(i%4===0?'pre':i%4===1?'button':i%4===2?'aside':'p',{key:i},'synthetic fixture '+i)));
  for(let i=0;i<count;i++){
    const start=performance.now(),node=ui.container(undefined,{styled:false});containers.push(performance.now()-start);
    const times=new Map(),tracker=commitTracker(),mountedAt=performance.now();
    const root=ui.mountReact(node,content,{onCommit:revision=>{
      if(revision===1)initialCommits.push(performance.now()-mountedAt);
      if(times.has(revision))commits.push(performance.now()-times.get(revision));
      for(const key of times.keys())if(key<=revision){if(key<revision)coalesced++;times.delete(key);}
      tracker.record(revision);
    }});
    roots.push({root,times,tracker,lastRevision:1});
  }
  // Wait for real initial receipts rather than assuming a fixed sleep is warm.
  await bounded(Promise.all(roots.map(record=>record.tracker.wait(1))));
  for(let warm=0;warm<5;warm++){
    for(const record of roots)record.lastRevision=record.root.render(content);
    await bounded(Promise.all(roots.map(record=>record.tracker.wait(record.lastRevision))));
  }
  for(let round=0;count>0&&round<5;round++)for(let sample=0;sample<20;sample++){
    for(const record of roots){const start=performance.now();const revision=record.root.render(content);record.lastRevision=revision;record.times.set(revision,start);requests.push(performance.now()-start);}
    await tick();
  }
  // Drain the final requests: cancellation at teardown is not coalescing.
  await bounded(Promise.all(roots.map(record=>record.tracker.wait(record.lastRevision))));
  if(requests.length!==commits.length+coalesced||roots.some(record=>record.times.size))throw Error('Incomplete commit accounting');
  for(const {root} of roots){const start=performance.now();root.unmount();cleanup.push(performance.now()-start);}
  ui.dispose();
  if(f.observers.size!==baselineObservers||f.mediaListeners.size)throw Error('Core benchmark leaked owned observers/listeners');
  results.push({items,roots:count,request:stats(requests),commitLatency:stats(commits),coalescedRequests:coalesced,cancelledRequests:0,initialCommitLatency:stats(initialCommits),containerCreate:stats(containers),cleanup:stats(cleanup),remainingOwnedObservers:f.observers.size-baselineObservers,remainingMediaListeners:f.mediaListeners.size});
  } finally {f.dispose();}
}
const report=JSON.stringify({schemaVersion:2,runId:randomUUID(),layer:'core-offline-jsdom',fixture:'20/200/2000 synthetic items repeating pre/button/aside/p; identical React element per root; initial receipt + 5 committed warm-ups; 5 rounds x 20 requests; 4 zero-delay timers between batches; final receipt drain',fixtureSha256:hash(readFileSync(new URL('../tests/support/ui-fixture.mjs',import.meta.url))),benchmarkSha256:hash(readFileSync(new URL(import.meta.url))),bundleSha256:hash(uiSource),versions:{react:require('react/package.json').version,sdk:JSON.parse(readFileSync(new URL('../frontend/node_modules/@openai/apps-sdk-ui/package.json',import.meta.url))).version,jsdom:require('jsdom/package.json').version,node:process.version},limitations:'Commit is parent layout-effect receipt, not paint. Same React element exercises subtree reuse. No Native buttons, CPU, GPU, visible frames or retained heap claims. Container/initial/cleanup samples are small.',results},null,2);
if(process.argv[2])writeFileSync(process.argv[2],report+'\n','utf8');else console.log(report);
