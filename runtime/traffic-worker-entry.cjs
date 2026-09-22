'use strict';
const { readFileSync } = require('node:fs');
const { startTrafficWorker } = require('./traffic-worker.cjs');
module.exports = require('./traffic-worker.cjs');
if (require.main === module) {
const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGTERM', stop); process.once('SIGINT', stop);
(async () => {
  const bytes = readFileSync(process.argv[2]);
  if (bytes.length > 128 * 1024) throw new Error('invalid_configuration');
  const worker = await startTrafficWorker(JSON.parse(bytes), { signal: controller.signal });
  const close = () => worker.close().catch(() => {}).finally(() => { process.exitCode = 0; });
  if (controller.signal.aborted) close(); else controller.signal.addEventListener('abort', close, { once: true });
})().catch(() => { controller.abort(); process.exitCode = 1; });
}
