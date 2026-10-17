'use strict';
// First native preload: no tsx/application import until the one-use parent release.
const fs = require('node:fs');
const cp = require('node:child_process');
const wt = require('node:worker_threads');
const { syncBuiltinESMExports } = require('node:module');
const { performance } = require('node:perf_hooks');
const nonce = process.env.UAT_HOST_NONCE, resource = process.env.UAT_HOST_RESOURCE;
if (!/^[a-f0-9]{64}$/.test(nonce || '') || !/^[a-f0-9]{64}$/.test(resource || '')) {
  throw Error('barrier lacks launch reservation');
}
const deny = () => { throw Error('A1 refuses unexpected child/worker; esbuild closure requires B'); };
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[key] = deny;
wt.Worker = deny;
syncBuiltinESMExports();
const ready = { type: 'ready', nonce, resource, pid: process.pid, ppid: process.ppid };
fs.writeSync(5, JSON.stringify(ready) + '\n');
let input = '', release;
const deadline = performance.now() + 5500;
const sleepWord = new Int32Array(new SharedArrayBuffer(4));
try {
  while (performance.now() < deadline) {
    const buffer = Buffer.alloc(4097);
    let n;
    try { n = fs.readSync(4, buffer, 0, buffer.length, null); }
    catch (e) { if (e.code !== 'EAGAIN') throw e; Atomics.wait(sleepWord, 0, 0, 5); continue; }
    if (n === 0) throw Error('barrier release EOF');
    input += buffer.subarray(0, n).toString();
    if (Buffer.byteLength(input) > 4096) throw Error('barrier release overflow');
    if (!input.endsWith('\n')) continue;
    release = JSON.parse(input);
    if (release.type !== 'release' || release.nonce !== nonce || release.resource !== resource ||
        release.identity.pid !== process.pid || release.identity.ppid !== process.ppid) throw Error('barrier release mismatch');
    break;
  }
  if (!release || performance.now() > deadline) throw Error('barrier deadline');
} finally {
  fs.closeSync(4); fs.closeSync(5);
}
// Record topology for the built-in-only fixture. These are inner, already closed FDs.
Object.defineProperty(globalThis, '__A1_BARRIER_CLOSED', { value: true });
