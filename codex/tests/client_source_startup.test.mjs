import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const hash=code=>createHash('sha256').update(code).digest('hex');

function status(endpoint,command={op:'status'}) {
  return new Promise((resolve,reject)=>{
    const socket=net.createConnection({host:endpoint.host,port:endpoint.port});let data='';
    socket.on('connect',()=>socket.write(JSON.stringify({...command,token:endpoint.token})+'\n'));
    socket.on('data',bytes=>data+=bytes);socket.on('error',reject);
    socket.on('end',()=>{if(!data){reject(Object.assign(Error('Readiness reply socket retired'),{code:'fixture_empty_reply'}));return;}try{resolve(JSON.parse(data));}catch(error){reject(error);}});
  });
}

test('the packaged source activates across cold boots and delayed native module loading',
  {skip:!process.env.CODLET_CORE_ROOT,timeout:45000},async t=>{
  const core=process.env.CODLET_CORE_ROOT;
  const {attach}=require(path.join(core,'runtime','client-bridge-bootstrap.cjs'));
  const bridge=await readFile(path.join(core,'runtime','client-bridge-bundle.cjs'),'utf8');
  const packaged=require('../bundled/codex-desktop-adapter/host.cjs').clientSource().code;
  const plaintext=fileURLToPath(new URL('../host/electron-plaintext.cjs',import.meta.url));
  const bootstrap='let vY,DN;module.exports={initialize(){vY=class {fetch(){} request(){}};DN=class {routeIncomingMessage(){}};}};';
  const main='let kce;module.exports={initialize(){kce=class {performDesktopFetch(){return "native";}};}};';
  const expectedHashes={'bootstrap-CZlEGA2m.js':hash(bootstrap),'main-C_jM0dPl.js':hash(main)};
  const pids=new Set();
  for(let cycle=0;cycle<3;cycle++) {
    const root=await mkdtemp(path.join(tmpdir(),'codlet-cold-source-'));
    await mkdir(path.join(root,'node_modules','electron'),{recursive:true});
    await writeFile(path.join(root,'node_modules','electron','index.js'),`module.exports={app:{isReady:()=>globalThis.nativeReady===true,getAppPath:()=>${JSON.stringify(root)}}};`);
    await writeFile(path.join(root,'preload.cjs'),'process.type="browser";');
    await writeFile(path.join(root,'bootstrap-CZlEGA2m.js'),bootstrap);
    await writeFile(path.join(root,'main-C_jM0dPl.js'),main);
    await writeFile(path.join(root,'entry.cjs'),`const mark=phase=>require('node:fs').writeFileSync(require('node:path').join(__dirname,'native-state.json'),JSON.stringify({phase,inspector:!!require('node:inspector').url(),modules:Object.keys(require.cache).map(file=>require('node:path').basename(file))}));mark('entered');const initialization=setInterval(()=>{if(!require('node:inspector').url()){clearInterval(initialization);mark('resumed');setTimeout(()=>{require('./bootstrap-CZlEGA2m.js').initialize();require('./main-C_jM0dPl.js').initialize();globalThis.nativeReady=true;mark('initialized');},${cycle===2?12000:0});}},10);setInterval(()=>{},1000);`);
    const child=spawn(process.execPath,['--inspect-brk=127.0.0.1:0','--require',path.join(root,'preload.cjs'),path.join(root,'entry.cjs')],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
    child.stdout.on('error',()=>{});child.stderr.on('error',()=>{});
    let cleaned=false;
    const cleanup=async()=>{
      if(cleaned)return;cleaned=true;
      if(child.exitCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}
      assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));await rm(root,{recursive:true});
    };
    t.after(cleanup);
    try {
      const inspectorUrl=await new Promise((resolve,reject)=>{
        let data='';const timer=setTimeout(()=>reject(Error('owned_inspector_timeout')),5000);
        child.stderr.on('data',bytes=>{data+=bytes;const match=data.match(/ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]{36}/);if(match){clearTimeout(timer);resolve(match[0]);}});
        child.once('error',error=>{clearTimeout(timer);reject(error);});
      });
      const code=packaged+`\nconst original=module.exports;module.exports={...original,installElectronTraffic(electron,configuration,context){
        context.resources.set('plaintextSource',{ready:Promise.resolve(),interceptHttp(){}});
        return original.installElectronTraffic(electron,{...configuration,deadlineUnixMs:Date.now()-1},context,{
          installDesktop:(electron,options)=>require(${JSON.stringify(plaintext)}).installDesktopPlaintext(electron,options,{expectedHashes:${JSON.stringify(expectedHashes)}}),
          installBackend:()=>({ready:async()=>{${cycle===1?"throw Object.assign(Error(),{code:'backend_route_timeout'});":"return {available:false,reason:'child_unavailable'};"}},inspect:()=>({available:false,reason:'child_unavailable'}),ownsProcess:()=>false,close(){}}),
          recover:async()=>{throw Error('cold boot must not reconnect');}
        });
      }};`;
      const result=await attach({inspectorUrl,expectedPid:child.pid,executable:process.execPath,traffic:{},selection:{owner:'codex.desktop.adapter',generation:1,code,configuration:{source:{}}}},bridge);
      assert.equal(result.exactChildVerified,true);assert.equal(result.activation.installed,false);
      let receipt;
      try{receipt=await status(result.bridge,{op:'ready',operationId:'startup-ready',expectedEpoch:0});}
      catch(error){if(error.code!=='fixture_empty_reply')throw error;}
      const deadline=Date.now()+30000;
      while(!receipt||receipt.result.pending||receipt.result.unknown){
        assert.ok(Date.now()<deadline,'Original startup receipt did not settle');
        await new Promise(resolve=>setTimeout(resolve,25));
        receipt=await status(result.bridge,{op:'status',operationId:'startup-ready'});
      }
      const completed=receipt.result;
      assert.equal(completed.outcome,'applied');assert.equal(completed.activation.installed,true,JSON.stringify({completed,native:await readFile(path.join(root,'native-state.json'),'utf8')}));
      assert.deepEqual(completed.activation.activatedSources.map(source=>source.id),['desktop-main-http']);
      const observed=(await status(result.bridge)).result;
      assert.equal(observed.owner,'codex.desktop.adapter');assert.equal(observed.generation,1);assert.equal(observed.pid,child.pid);
      assert.equal(observed.activation.installed,true);assert.ok(observed.moduleObserver.modules>=2);
      assert.equal(pids.has(child.pid),false);pids.add(child.pid);
    } finally {await cleanup();}
  }
  assert.equal(pids.size,3);
});
