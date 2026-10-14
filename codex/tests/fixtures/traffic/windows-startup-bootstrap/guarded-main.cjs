// Acceptance only: suppress unrelated first-run OS sandbox installation.
// This guard is absent from production; model traffic still uses the real CLI.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const root = process.env.CODLET_ACCEPTANCE_ROOT;
if (!root || !path.isAbsolute(root) || fs.readFileSync(path.join(root, 'owner.txt'), 'utf8') !== 'codlet-desktop-acceptance\n') throw Error('missing fixture owner');
const spawn = cp.spawn;
cp.spawn = function(executable, args, ...rest) {
  const child = spawn.call(this, executable, args, ...rest);
  if (path.basename(String(executable)).toLowerCase() !== 'codex.exe' || !args?.includes('app-server') || !child.stdin || !child.stdout) return child;
  const write = child.stdin.write.bind(child.stdin), decoder = new StringDecoder('utf8'); let pending = '';
  child.stdin.write = function(chunk, encoding, callback) {
    pending += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8'));
    if (pending.length > 4 * 1024 * 1024) throw Error('fixture request overflow');
    const lines = pending.split('\n'); pending = lines.pop(); const forwarded = [];
    for (const line of lines) {
      let request; try { request = JSON.parse(line); } catch {}
      if (request?.method === 'windowsSandbox/setupStart') {
        fs.appendFileSync(path.join(root, 'blocked-sandbox-setup.jsonl'), JSON.stringify({ blocked: true }) + '\n');
        queueMicrotask(() => child.stdout.emit('data', Buffer.from(JSON.stringify({ id: request.id, error: { code: -32000, message: 'Sandbox installation is disabled in this isolated acceptance fixture' } }) + '\n')));
      } else forwarded.push(line);
    }
    const done = typeof encoding === 'function' ? encoding : callback;
    if (forwarded.length) return write(forwarded.join('\n') + '\n', done);
    if (done) queueMicrotask(done);
    return true;
  };
  return child;
};
module.exports = require('../../../../host/electron-main.cjs');
