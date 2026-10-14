import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
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
