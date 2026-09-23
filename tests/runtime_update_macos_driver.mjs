// Invoked only by the native fixture, using the copied and pinned helper Node.
import fs from 'node:fs';
import path from 'node:path';
import { runInstall } from './runtime-update-helper-macos.mjs';

const [planPath, digest, mode, ownerPid] = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(planPath));
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let calls = 0;
const restartApp = () => {
  calls++;
  return mode === 'rollback' && calls === 1 ? 1 : mode === 'unknown' ? 42 : 0;
};
const onReady = message => {
  if (message.planSha256 !== digest) throw new Error('Helper acknowledged another plan');
  fs.writeFileSync(plan.handoffAckPath, JSON.stringify({ id: plan.id, planSha256: digest }));
  if (mode !== 'unclean') {
    fs.writeFileSync(path.join(path.dirname(planPath), 'owner-cleanup.json'), JSON.stringify({
      schema: 1, id: plan.id, planSha256: digest, hostsRetired: true, trafficRetired: true,
    }));
  }
  process.kill(Number(ownerPid), 'SIGTERM');
  send({ event: 'ready' });
};
try {
  const result = await runInstall(planPath, digest, onReady, { restartApp });
  send({ event: 'result', phase: result.phase, calls });
  if (mode === 'rollback' || mode === 'unclean') process.exitCode = 1;
} catch (error) {
  send({ event: 'error', phase: error.receipt?.phase, code: error.code, message: String(error.message ?? error).slice(0, 512), calls });
  if (mode !== 'rollback' && mode !== 'unclean') {
    console.error(error);
    process.exitCode = 1;
  }
}
