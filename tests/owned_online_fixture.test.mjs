import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {captureProcessIdentity} from '../scripts/runtime-update-helper.mjs';
import {buildOwnedCandidate,publishOwnedCandidate} from '../scripts/owned-online-core-fixture.mjs';
const root=path.resolve(import.meta.dirname,'..'),artifacts=path.join(root,'.codlet-artifacts');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
test('owned builder pins exact residents, waits for explicit publication and rejects changed input',{skip:process.platform!=='win32'},async()=>{
  const directory=fs.mkdtempSync(path.join(artifacts,'owned-online-builder-test-'));
  const lab=path.join(directory,'lab'),install=path.join(directory,'install');fs.mkdirSync(path.join(lab,'codlet'),{recursive:true});fs.mkdirSync(path.join(install,'runtime'),{recursive:true});
  const marker=Buffer.from(JSON.stringify({schema_version:1,experimental:true,host_pid:process.pid}));fs.writeFileSync(path.join(lab,'.codlet-lab-owner.json'),marker);
  const executable=Buffer.alloc(128);executable.write('MZ');executable.writeUInt32LE(64,60);executable.write('PE\0\0',64,'binary');executable.writeUInt16LE(0x8664,68);fs.writeFileSync(path.join(install,'codlet-lab.exe'),executable);
  const node=Buffer.concat([executable,Buffer.from('fixture Node')]),license=Buffer.from('fixture license');
  fs.mkdirSync(path.join(install,'runtime/node-v24.18.1-win-x64'));
  fs.writeFileSync(path.join(install,'runtime/node-v24.18.1-win-x64/node.exe'),node);fs.writeFileSync(path.join(install,'runtime/node-v24.18.1-win-x64/LICENSE'),license);
  fs.writeFileSync(path.join(install,'runtime/node-runtime.json'),JSON.stringify({schema:1,version:'24.18.1',mode:'bundled',platforms:{'win-x64':{executableSha256:sha(node),licenseSha256:sha(license)}}}));
  const native=spawn(process.execPath,['-e',"const net=require('node:net');const server=net.createServer(s=>{let n=0;const interval=setInterval(()=>s.write(String(++n)+'\\n'),10);s.on('close',()=>clearInterval(interval));});server.listen(0,'127.0.0.1',()=>process.stdout.write(String(server.address().port)+'\\n'));process.stdin.resume();process.stdin.on('end',()=>server.close(()=>process.exit(0)));"],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  await new Promise((resolve,reject)=>{native.once('spawn',resolve);native.once('error',reject);});
  let socket;
  try {
    const identity=await captureProcessIdentity(native.pid);const template={schema:1,kind:'codlet-owned-online-update-fixture',id:null,hostPid:process.pid,native:identity,labRoot:fs.realpathSync.native(lab),installRoot:fs.realpathSync.native(install),markerSha256:sha(marker),version:null,bytes:0,sha256:null};
    const templatePath=path.join(lab,'codlet/template.json');fs.writeFileSync(templatePath,JSON.stringify({...template,native:{...identity,creationTime:String(BigInt(identity.creationTime)+1n)}}));
    await assert.rejects(buildOwnedCandidate(templatePath,path.join(directory,'stale')),/exact owned Host\/Native/);assert.equal(fs.existsSync(path.join(directory,'stale')),false);
    fs.writeFileSync(templatePath,JSON.stringify(template));
    const candidate=await buildOwnedCandidate(templatePath,path.join(directory,'candidate'));
    assert.equal(candidate.descriptorPublished,false);assert.equal(candidate.components.length,11);assert.equal(candidate.residentFiles[0].sha256,sha(executable));
    const descriptor=path.join(lab,'codlet/online-update-fixture.json');assert.equal(fs.existsSync(descriptor),false);
    const receipt=path.join(directory,'candidate/candidate-receipt.json'),zip=fs.readFileSync(candidate.zipPath);fs.appendFileSync(candidate.zipPath,'tampered');
    await assert.rejects(publishOwnedCandidate(templatePath,receipt),/Candidate ZIP changed/);assert.equal(fs.existsSync(descriptor),false);fs.writeFileSync(candidate.zipPath,zip);
    const port=await new Promise((resolve,reject)=>{const existing=native.stdout.read();if(existing)return resolve(Number(String(existing).trim()));native.stdout.once('data',bytes=>resolve(Number(String(bytes).trim())));native.once('exit',()=>reject(Error('Owned stream exited')));});
    socket=net.connect({host:'127.0.0.1',port});let seen='';await new Promise((resolve,reject)=>{socket.on('data',bytes=>{seen+=bytes;if(seen.trim().split('\n').length>=5)resolve();});socket.once('error',reject);});
    const published=await publishOwnedCandidate(templatePath,receipt);assert.equal(published.sha256,candidate.sha256);
    const delivered=JSON.parse(fs.readFileSync(descriptor));assert.equal(delivered.native.creationTime,identity.creationTime);assert.equal(delivered.sha256,sha(fs.readFileSync(path.join(lab,'codlet/online-update-fixture.zip'))));
    await assert.rejects(publishOwnedCandidate(templatePath,receipt),/already has a fixture input/);
    assert.equal(native.exitCode,null);assert.ok(Number(seen.trim().split('\n').at(-1))>=5);
  } finally {
    socket?.destroy();native.stdin.end();await new Promise(resolve=>{if(native.exitCode!==null)resolve();else native.once('exit',resolve);});
    assert.equal(path.dirname(directory),artifacts);fs.rmSync(directory,{recursive:true});
  }
});
