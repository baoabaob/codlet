'use strict';
// Client-specific fuse knowledge stays in the Adapter. Core only validates and
// executes a reversible module-data plan for its own suspended child.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const fail = code => Object.assign(new Error(code), { code });
const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
const reviewed = Object.freeze({
  b6f5c2323c642c3ad3dfdc3501aa94482970f88b4c12db0875ce593aece75c16: {
    offset: 281415264, wire: '010011001', version: 1,
  },
  // Signed Windows package 26.930.2377.0 retains the same single fuse wire.
  fc42df77197b9357672cc80baa1e6c9894b207756636a2ff6e44e666d4ba9a94: {
    offset: 281458144, wire: '010011001', version: 1,
  },
  // Signed Windows package 26.930.3930.0, Chromium 154.0.8037.98.
  '9ccf68d0580105bdb99b3ef5119829ca637d0d10251c58c984adbba59f37e7e0': {
    offset: 281113728, wire: '010011001', version: 1,
  },
});

function planForImage(sha256, matches) {
  if (matches.length !== 1) throw fail('client_bootstrap_fuse_ambiguous');
  const fuse = matches[0];
  if (fuse.version !== 1 || !/^[01r]{4,64}$/.test(fuse.wire)) throw fail('client_bootstrap_fuse_unsupported');
  // An already enabled inspector uses the existing attach handshake unchanged.
  if (fuse.wire[3] === '1') return { moduleData: null };
  const profile = reviewed[sha256];
  if (!profile || profile.offset !== fuse.offset || profile.wire !== fuse.wire || profile.version !== fuse.version) throw fail('client_bootstrap_version_unsupported');
  return { moduleData: { module: 'chrome.dll', sha256, patches: [
    { fileOffset: fuse.offset + sentinel.length + 2 + 3, expected: [48], replacement: [49] },
  ] } };
}

async function beforeClientResume({ expectedPid, executable, features, signal }) {
  if (process.platform !== 'win32' || features?.moduleDataBootstrap !== 1) throw fail('client_bootstrap_unsupported');
  if (!Number.isSafeInteger(expectedPid) || expectedPid <= 0 || !path.isAbsolute(executable)) throw fail('client_bootstrap_invalid');
  if (signal?.aborted) throw fail('host_stopping');
  const directory = path.dirname(fs.realpathSync(executable));
  const modulePath = path.join(directory, 'chrome.dll');
  // Older Electron distributions can place the wire in the executable instead.
  // Their supported inspector path needs no module-data edits.
  const image = fs.existsSync(modulePath) ? modulePath : executable;
  const size = fs.statSync(image).size;
  if (size < 64 || size > 512 * 1024 * 1024) throw fail('client_bootstrap_image_invalid');
  const hash = createHash('sha256'), matches = [];
  let tail = Buffer.alloc(0), consumed = 0;
  for await (const chunk of fs.createReadStream(image, { highWaterMark: 256 * 1024, signal })) {
    hash.update(chunk);
    const bytes = Buffer.concat([tail, chunk]);
    for (let at = bytes.indexOf(sentinel); at !== -1; at = bytes.indexOf(sentinel, at + 1)) {
      if (at + sentinel.length + 2 > bytes.length) continue;
      const count = bytes[at + sentinel.length + 1];
      const end = at + sentinel.length + 2 + count;
      if (end > bytes.length) continue;
      const offset = consumed - tail.length + at;
      if (matches.some(match => match.offset === offset)) continue;
      if (matches.length >= 2) throw fail('client_bootstrap_fuse_ambiguous');
      matches.push({ offset, version: bytes[at + sentinel.length], wire: count >= 4 && count <= 64
        ? bytes.toString('ascii', at + sentinel.length + 2, end) : '' });
    }
    consumed += chunk.length;
    tail = Buffer.from(bytes.subarray(-100));
  }
  if (consumed !== size) throw fail('client_bootstrap_image_changed');
  return planForImage(hash.digest('hex'), matches);
}
module.exports = { beforeClientResume, planForImage };
