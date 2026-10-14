// Synchronous publication keeps event callbacks ordered. Retry only transient
// Windows rename failures; never unlink the destination or reuse failed temps.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const waits = [10, 20, 40, 80, 160, 250, 250]; // 8 attempts, at most 810 ms sleeping.
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function atomicJson(file, value, { io = fs, sleep = pause, platform = process.platform, nonce = () => randomBytes(12).toString('hex') } = {}) {
  const data = JSON.stringify(value, null, 2) + '\n';
  file = path.resolve(file);
  const directories = [];
  for (let dir = path.dirname(file);;) {
    const stat = io.lstatSync(dir, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('State directory is not plain: ' + dir);
    directories.push({ dir, dev: stat.dev, ino: stat.ino });
    const parent = path.dirname(dir); if (parent === dir) break; dir = parent;
  }
  function validate() {
    for (const expected of directories) {
      const stat = io.lstatSync(expected.dir, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== expected.dev || stat.ino !== expected.ino) throw new Error('State directory identity changed: ' + expected.dir);
    }
    let target;
    try { target = io.lstatSync(file, { bigint: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (target && (target.isSymbolicLink() || !target.isFile() || target.nlink !== 1n)) throw new Error('State destination is not a plain single-link file: ' + file);
  }
  let temporary, descriptor, identity, failure;
  try {
    // Exclusive creation also protects an unexpected collision. Existing files
    // are never removed, including temp evidence from older coordinator runs.
    for (let attempt = 0; attempt < 4; attempt++) {
      validate();
      temporary = file + '.' + process.pid + '.' + nonce() + '.tmp';
      try { descriptor = io.openSync(temporary, 'wx', 0o600); break; }
      catch (error) { if (error.code !== 'EEXIST' || attempt === 3) throw error; }
    }
    identity = io.fstatSync(descriptor, { bigint: true });
    io.writeFileSync(descriptor, data);
    io.fsyncSync(descriptor);
  } catch (error) { failure = error; }
  finally {
    if (descriptor !== undefined) {
      try { io.closeSync(descriptor); } catch (error) { failure ??= error; }
    }
  }
  try {
    if (failure) throw failure;
    for (let attempt = 0;; attempt++) {
      validate();
      const temp = io.lstatSync(temporary, { bigint: true });
      if (temp.isSymbolicLink() || !temp.isFile() || temp.nlink !== 1n || temp.dev !== identity.dev || temp.ino !== identity.ino) throw new Error('State temporary identity changed: ' + temporary);
      try { io.renameSync(temporary, file); return; }
      catch (error) {
        if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === waits.length) throw error;
        sleep(waits[attempt]);
      }
    }
  } catch (error) {
    // Retain the failed bytes for diagnosis, without promoting them to state.
    error.stateDestination = file;
    error.stateTemporary = temporary;
    throw error;
  }
}
