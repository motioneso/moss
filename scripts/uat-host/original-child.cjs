'use strict';
// Source observations only. No constructor accepts a reported PID or child object.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const states = new WeakMap();
const reservations = new WeakMap();
const usedNonces = new Set(), usedResources = new Set();
const now = () => performance.now();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function boundedRead(path, limit = 65536) {
  const fd = fs.openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(limit + 1);
    const n = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (n > limit) throw Error('read limit: ' + path);
    return buffer.subarray(0, n);
  } finally { fs.closeSync(fd); }
}
function environment(bytes) {
  return Object.fromEntries(bytes.toString().split('\0').filter(Boolean).map((s) => {
    const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)];
  }).filter(([k]) => !['NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE'].includes(k))
    .sort(([a], [b]) => a.localeCompare(b)));
}
function identity(pid) {
  const root = '/proc/' + pid;
  const stat = boundedRead(root + '/stat').toString();
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return {
    pid, state: fields[0], ppid: Number(fields[1]), birth: fields[19],
    boot: boundedRead('/proc/sys/kernel/random/boot_id', 128).toString().trim(),
    executable: fs.readlinkSync(root + '/exe'), cwd: fs.readlinkSync(root + '/cwd'),
    argv: boundedRead(root + '/cmdline').toString().split('\0').filter(Boolean),
    env: environment(boundedRead(root + '/environ')),
  };
}
function checkIdentity(actual, expected) {
  for (const key of ['pid', 'ppid', 'birth', 'boot', 'executable', 'cwd', 'argv', 'env']) {
    if (expected[key] !== undefined && !same(actual[key], expected[key])) throw Error('identity mismatch: ' + key);
  }
}
function verifyFiles(pins) {
  for (const pin of pins) {
    const st = fs.lstatSync(pin.path);
    if (!st.isFile() || (pin.mode !== undefined && (st.mode & 0o777) !== pin.mode) ||
        fs.realpathSync(pin.path) !== pin.path || hash(fs.readFileSync(pin.path)) !== pin.sha256) {
      throw Error('source/dependency pin mismatch: ' + pin.path);
    }
  }
}
function state(capability) {
  const s = states.get(capability);
  if (!s) throw Error('missing original capability');
  return s;
}
function reserve(nonce, resource) {
  if (!/^[a-f0-9]{64}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(resource)) throw Error('invalid reservation');
  if (usedNonces.has(nonce) || usedResources.has(resource)) throw Error('duplicate launch/resource reservation');
  usedNonces.add(nonce); usedResources.add(resource);
  const token = Object.freeze(Object.create(null));
  reservations.set(token, { nonce, resource, used: false });
  return token;
}
function spawnOriginal(file, args, options, onClose) {
  const child = spawn(file, args, { ...options, detached: false, shell: false });
  const capability = Object.freeze(Object.create(null));
  const s = { child, file, args: [...args], started: now(), error: null, terminal: null,
    close: null, ipc: !!child.connected, disconnected: false, streams: [], faults: [], identity: null, released: false, messageCount: 0 };
  states.set(capability, s);
  child.on('error', (e) => { s.error = { code: e.code || null, message: e.message }; });
  child.on('exit', (code, signal) => { s.terminal = { code, signal, at: now() }; });
  child.on('disconnect', () => { s.disconnected = true; });
  child.on('message', (value) => {
    if (++s.messageCount > 64 || Buffer.byteLength(JSON.stringify(value)) > 4096) s.faults.push('IPC frame/count bound');
  });
  for (const [fd, stream] of child.stdio.entries()) {
    if (!stream) continue;
    const entry = { fd, bytes: 0, data: '', end: false, close: false, error: null };
    s.streams.push(entry);
    stream.on('data', (chunk) => {
      entry.bytes += chunk.length;
      if (entry.bytes > 65536) { s.faults.push('stream overflow fd' + fd); stream.destroy(); }
      else entry.data += chunk.toString();
    });
    stream.on('end', () => { entry.end = true; });
    stream.on('close', () => { entry.close = true; });
    stream.on('error', (e) => { entry.error = e.code || e.message; s.faults.push('stream error fd' + fd); });
  }
  s.done = new Promise((resolve) => child.on('close', (code, signal) => {
    s.close = { code, signal, at: now() };
    if (onClose) onClose(snapshot(capability));
    resolve(snapshot(capability));
  }));
  return { child, capability };
}
function bind(capability, expected) {
  const s = state(capability);
  if (!s.child.pid || s.terminal || s.close || s.error) throw Error('original is not live');
  const actual = identity(s.child.pid);
  checkIdentity(actual, { ...expected, pid: s.child.pid, ppid: process.pid });
  s.identity = actual;
  return actual;
}
function release(capability, reservation, expected, send) {
  const s = state(capability), r = reservations.get(reservation);
  if (!r || r.used || s.released) throw Error('missing/reused reservation');
  if (!s.identity || s.terminal || s.close || s.error) throw Error('original not held/live');
  checkIdentity(identity(s.child.pid), s.identity);
  checkIdentity(s.identity, expected.identity || {});
  if (expected.nonce !== r.nonce || expected.resource !== r.resource) throw Error('stale launch challenge');
  r.used = true; s.released = true;
  // The caller is immutable trusted owner code; this function never accepts a receipt as capability.
  send({ type: 'release', nonce: r.nonce, resource: r.resource, identity: s.identity });
}
function signal(capability, signalName) {
  const s = state(capability);
  if (!s.identity || s.terminal || s.close || s.error) throw Error('no live original for signal');
  const current = identity(s.child.pid);
  if (['Z', 'X', 'x'].includes(current.state)) throw Error('original is no longer live');
  // exec may change argv/executable; PID/birth/PPID/boot remain the same original.
  checkIdentity(current, { pid: s.identity.pid, ppid: s.identity.ppid, birth: s.identity.birth, boot: s.identity.boot });
  if (!['SIGTERM', 'SIGKILL'].includes(signalName) || !s.child.kill(signalName)) throw Error('original signal failed');
}
function snapshot(capability) {
  const s = state(capability);
  return structuredClone({ started: s.started, error: s.error, terminal: s.terminal, close: s.close,
    identity: s.identity, disconnected: s.disconnected, streams: s.streams, faults: s.faults });
}
function completion(capability, deadline) {
  const s = state(capability);
  if (!s.close || s.close.at > deadline || now() > deadline || s.faults.length ||
      s.streams.some((p) => !p.close || p.error || (!s.error && p.fd !== 0 && !p.end)) ||
      (s.ipc && !s.disconnected) || (s.child.channel && s.child.connected)) throw Error('missing/late close or FD disposition');
  if (s.error) {
    if (s.terminal || s.child.pid) throw Error('spawn error has invented terminal status');
  } else if (!s.terminal || !same([s.terminal.code, s.terminal.signal], [s.close.code, s.close.signal])) {
    throw Error('terminal/close mismatch');
  }
  return snapshot(capability);
}
function lines(stream, receive, fail) {
  let buffer = '', count = 0, failed = false;
  const reject = (error) => { if (!failed) { failed = true; fail(error); } };
  stream.on('data', (chunk) => {
    if (failed) return;
    buffer += chunk.toString();
    for (;;) {
      const at = buffer.indexOf('\n');
      if (at < 0) break;
      const frame = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      if (Buffer.byteLength(frame) > 4096 || ++count > 64) return reject(Error('protocol frame/count bound'));
      try { receive(JSON.parse(frame)); } catch (e) { return reject(e); }
    }
    if (Buffer.byteLength(buffer) > 4096) reject(Error('protocol partial frame bound'));
  });
  stream.on('end', () => { if (buffer) reject(Error('truncated protocol frame')); });
  stream.on('error', reject);
}
module.exports = { spawnOriginal, bind, release, reserve, signal, snapshot, completion,
  done: (capability) => state(capability).done, identity, checkIdentity, verifyFiles,
  environment, hash, now, lines };
