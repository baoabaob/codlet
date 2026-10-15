// Acceptance evidence only. Runtime admission continues to pin whole-file hashes.
// Compare all bytes except the PE checksum, certificate-directory entry and
// Authenticode certificate blob, allowing a separately signed distribution of
// the same executable image to be exercised on a disposable CI runner.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const bytes = readFileSync(process.argv[2]);
assert.equal(bytes.toString('ascii', 0, 2), 'MZ');
const pe = bytes.readUInt32LE(0x3c), optional = pe + 24;
assert.equal(bytes.toString('ascii', pe, pe + 4), 'PE\0\0');
assert.equal(bytes.readUInt16LE(pe + 4), 0x8664, 'Expected an x64 PE image');
assert.equal(bytes.readUInt16LE(optional), 0x20b, 'Expected PE32+');
assert.ok(bytes.readUInt32LE(optional + 108) > 4);
const checksum = optional + 64, directory = optional + 112 + 4 * 8;
const certificateOffset = bytes.readUInt32LE(directory), certificateBytes = bytes.readUInt32LE(directory + 4);
assert.ok(certificateOffset > directory + 8 && certificateBytes >= 8);
assert.equal(certificateOffset + certificateBytes, bytes.length, 'Certificate must be the final file range');
const hash = createHash('sha256');
hash.update(bytes.subarray(0, checksum)).update(Buffer.alloc(4));
hash.update(bytes.subarray(checksum + 4, directory)).update(Buffer.alloc(8));
hash.update(bytes.subarray(directory + 8, certificateOffset));
console.log(JSON.stringify({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
  peImageSha256: hash.digest('hex'), certificateOffset, certificateBytes }));
