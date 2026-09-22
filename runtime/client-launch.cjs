'use strict';
// Optional Host ABI phases, using the same immutable source snapshot as activate.
// No public RPC endpoint or ambient Native gateway is exposed by this executor.
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const controller = new AbortController();
let stage = 'prepare', pending = Buffer.alloc(0), busy = false;
const send = value => {
  const bytes = JSON.stringify(value);
  if (Buffer.byteLength(bytes) > 16 * 1024) throw new Error('launch_reply_too_large');
  process.stdout.write(bytes + '\n');
};
const fail = () => { controller.abort(); process.exitCode = 1; process.stdin.destroy(); };
let plugin;
try {
  const entry = process.argv[2], source = fs.readFileSync(process.argv[3], 'utf8');
  plugin = new Module(entry); plugin.filename = entry; plugin.paths = Module._nodeModulePaths(path.dirname(entry));
  plugin._compile(source, entry);
  if (typeof plugin.exports.prepareClientLaunch !== 'function' || typeof plugin.exports.attachClientLaunch !== 'function') throw new Error('launch_exports_missing');
} catch { fail(); }
process.stdin.on('end', fail); process.stdin.on('error', fail);
process.stdin.on('data', chunk => {
  if (busy || pending.length + chunk.length > 512 * 1024) { fail(); return; }
  pending = Buffer.concat([pending, chunk]);
  const end = pending.indexOf(10); if (end < 0) return;
  if (end !== pending.length - 1) { fail(); return; }
  let input; try { input = JSON.parse(pending.subarray(0, end)); } catch { fail(); return; }
  pending = Buffer.alloc(0); busy = true;
  if (input.phase !== stage) { fail(); return; }
  const timer = setTimeout(fail, 10000);
  Promise.resolve().then(() => plugin.exports[stage === 'prepare' ? 'prepareClientLaunch' : 'attachClientLaunch']({ ...input.context, signal: controller.signal }))
    .then(result => {
      send({ ok: true, result }); busy = false;
      if (stage === 'attach') { process.stdout.write('', () => process.exit(0)); }
      else stage = 'attach';
    }, () => { try { send({ ok: false }); } finally { fail(); } })
    .finally(() => clearTimeout(timer));
});
