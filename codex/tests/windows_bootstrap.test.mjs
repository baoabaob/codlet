import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { planForImage } = require('../host/windows-bootstrap.cjs');
const { sameExecutable } = require('../host/electron-bootstrap.cjs');
const hash = 'b6f5c2323c642c3ad3dfdc3501aa94482970f88b4c12db0875ce593aece75c16';
const fuse = { offset: 281415264, version: 1, wire: '010011001' };
test('reviewed disabled inspector yields one reversible data byte; unknown images are rejected', () => {
  assert.deepEqual(planForImage(hash, [fuse]), { moduleData: { module: 'chrome.dll', sha256: hash,
    patches: [{ fileOffset: 281415301, expected: [48], replacement: [49] }] } });
  for (const [sha, matches] of [['0'.repeat(64), [fuse]], [hash, [{ ...fuse, offset: 1 }]], [hash, [{ ...fuse, wire: '000011001' }]]]) {
    assert.throws(() => planForImage(sha, matches), { code: 'client_bootstrap_version_unsupported' });
  }
  assert.throws(() => planForImage(hash, []), { code: 'client_bootstrap_fuse_ambiguous' });
  assert.throws(() => planForImage(hash, [fuse, fuse]), { code: 'client_bootstrap_fuse_ambiguous' });
  assert.throws(() => planForImage(hash, [{ ...fuse, version: 2 }]), { code: 'client_bootstrap_fuse_unsupported' });
  assert.deepEqual(planForImage('old-inspector-enabled', [{ ...fuse, wire: '010111001' }]), { moduleData: null });
});
test('executable comparison accepts equivalent file names without accepting another file', () => {
  assert.equal(sameExecutable(process.execPath, process.execPath), true);
  assert.equal(sameExecutable(process.execPath, import.meta.filename), false);
  assert.equal(sameExecutable(process.execPath, 'relative.exe'), false);
  if (process.platform === 'win32') assert.equal(sameExecutable(process.execPath, `\\\\?\\${process.execPath}`), true);
});

test('Windows 26.930 retains exact-image and fuse-identity checks at its new offset',()=>{
  const image='fc42df77197b9357672cc80baa1e6c9894b207756636a2ff6e44e666d4ba9a94',current={...fuse,offset:281458144};
  assert.deepEqual(planForImage(image,[current]),{moduleData:{module:'chrome.dll',sha256:image,patches:[{fileOffset:281458181,expected:[48],replacement:[49]}]}});
  assert.throws(()=>planForImage(image,[fuse]),{code:'client_bootstrap_version_unsupported'});
  assert.throws(()=>planForImage(image,[{...current,wire:'000011001'}]),{code:'client_bootstrap_version_unsupported'});
});

test('Windows 26.930.3930 accepts only its reviewed signed image and exact fuse data',()=>{
  const image='9ccf68d0580105bdb99b3ef5119829ca637d0d10251c58c984adbba59f37e7e0',current={...fuse,offset:281113728};
  assert.deepEqual(planForImage(image,[current]),{moduleData:{module:'chrome.dll',sha256:image,patches:[{fileOffset:281113765,expected:[48],replacement:[49]}]}});
  assert.throws(()=>planForImage(image,[{...current,offset:current.offset+1}]),{code:'client_bootstrap_version_unsupported'});
  assert.throws(()=>planForImage(image,[{...current,wire:'000011001'}]),{code:'client_bootstrap_version_unsupported'});
  assert.throws(()=>planForImage('0'.repeat(64),[current]),{code:'client_bootstrap_version_unsupported'});
});

test('fuse scans use the public byte-length header across chunk boundaries and stream large images', async () => {
  const sentinel=Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'),size=513*1024*1024,offset=256*1024-sentinel.length-1;
  for (const adapter of [false,true]) {
    const wire=Buffer.alloc(255,48);wire[3]=adapter?49:48;
    const fuse=Buffer.concat([sentinel,Buffer.from([1,wire.length]),wire]);
    let hashed=0,largest=0;
    const virtualFs={realpathSync:value=>value,existsSync:()=>true,statSync:()=>({isFile:()=>true,size}),
      async *createReadStream(_file,options) {
        assert.equal(options.highWaterMark,256*1024);
        const zero=Buffer.alloc(options.highWaterMark);
        for(let position=0;position<size;position+=zero.length) {
          let chunk=zero.subarray(0,Math.min(zero.length,size-position));
          const start=Math.max(position,offset),end=Math.min(position+chunk.length,offset+fuse.length);
          if(start<end){chunk=Buffer.from(chunk);fuse.copy(chunk,start-position,start-offset,end-offset);}
          largest=Math.max(largest,chunk.length);yield chunk;
        }
      }};
    const file=new URL(adapter?'../host/windows-bootstrap.cjs':'../../runtime/client-bridge-bootstrap.cjs',import.meta.url);
    const module={exports:{}};
    const localRequire=name=>name==='node:fs'?virtualFs:name==='node:crypto'?{...require(name),createHash:()=>({update(bytes){hashed+=bytes.length;},digest:()=>hash})}:require(name);
    vm.runInNewContext(fs.readFileSync(file,'utf8'),{require:localRequire,module,exports:module.exports,process:{platform:'win32'},Buffer},{filename:file.pathname});
    const executable=path.resolve('owned-fuse-fixture','native.exe');
    const result=adapter?await module.exports.beforeClientResume({expectedPid:1,executable,features:{moduleDataBootstrap:1}}):await module.exports.plan(executable);
    assert.equal(hashed,size);assert(largest<=256*1024);
    if(adapter)assert.deepEqual(JSON.parse(JSON.stringify(result)),{moduleData:null});
    else assert.equal(result.moduleData.patches[0].fileOffset,offset+sentinel.length+5);
  }
});

test('Windows build 22391 accepts its reviewed image without accepting a neighboring offset or another wire',()=>{
  const image='616ec415a02e75b8abed4c38a34cf746ed1c2f1ba0adc77c500b815b8cc0dcc4',current={...fuse,offset:287200672};
  assert.deepEqual(planForImage(image,[current]),{moduleData:{module:'chrome.dll',sha256:image,patches:[{fileOffset:287200709,expected:[48],replacement:[49]}]}});
  assert.throws(()=>planForImage(image,[{...current,offset:current.offset+1}]),{code:'client_bootstrap_version_unsupported'});
  assert.throws(()=>planForImage(image,[{...current,wire:'000011001'}]),{code:'client_bootstrap_version_unsupported'});
  assert.throws(()=>planForImage('0'.repeat(64),[current]),{code:'client_bootstrap_version_unsupported'});
});
