'use strict';
// One immutable source-only public-pnpm profile; no runtime admission is exported.
const fs = require('node:fs'), cp = require('node:child_process'), net = require('node:net');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const core = require('./original-child.cjs');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function requireMatch(ok, message) { if (!ok) throw Error('A2a refuses ' + message); }
function publicArgv(argv, basenames) {
  requireMatch(argv.length === 2 && argv[0] === 'test:uat' && basenames.includes(argv[1]), 'public argv');
}
function frameBinding(frame, nonce, resource, parent) {
  requireMatch(frame.nonce === nonce && frame.resource === resource && frame.parent === parent, 'hop binding');
}
function endpoints(actual, expected) {
  requireMatch(actual.length === 2 && actual[0] && actual[1] && actual[0] !== actual[1] && same(actual, expected), 'FD custody');
}
function denyKind(kind) { throw Error('A2a unexpected ' + kind); }
module.exports = { publicArgv, frameBinding, endpoints, denyKind };
if (process.env.UAT_HOST_PROFILE !== 'a2a-public-r1') return;
const packet = process.env.UAT_HOST_PACKET;
const inputs = JSON.parse(fs.readFileSync(path.join(packet, 'inputs.json'), 'utf8'));
const profile = inputs.public;
const plan = inputs.plans.find((p) => p.mode === process.env.UAT_HOST_CASE);
requireMatch(plan && same(process.argv, ['/usr/bin/node', profile.globalShim, ...plan.publicArgv]), 'initial public parent');
publicArgv(plan.publicArgv, inputs.basenames);
core.verifyFiles(inputs.files);
requireMatch(process.cwd() === profile.cwd && process.send && process.env.NODE_OPTIONS === profile.pnpmOptions, 'parent cwd/preload/IPC');
const nativeExit = process.exit.bind(process), nativeKill = process.kill.bind(process);
const nonce = process.env.UAT_HOST_NONCE, resource = process.env.UAT_HOST_RESOURCE;
const emit = (value) => {
  const text = JSON.stringify({ ...value, nonce, resource, parent: process.pid }) + '\n';
  requireMatch(Buffer.byteLength(text) <= 4096, 'observation overflow');
  fs.writeSync(5, text);
};
// Synchronous hold precedes Corepack and pnpm imports, using only native builtins.
emit({ type: 'pnpm-held', pid: process.pid, ppid: process.ppid });
const until = core.now() + 1500, sleep = new Int32Array(new SharedArrayBuffer(4));
let text = '', admitted = false;
while (core.now() < until) {
  const buffer = Buffer.alloc(4097); let n;
  try { n = fs.readSync(4, buffer, 0, buffer.length, null); }
  catch (e) { if (e.code !== 'EAGAIN') throw e; Atomics.wait(sleep, 0, 0, 5); continue; }
  requireMatch(n > 0, 'initial release EOF'); text += buffer.subarray(0, n).toString();
  requireMatch(Buffer.byteLength(text) <= 4096, 'initial frame bound');
  if (!text.endsWith('\n')) continue;
  const frame = JSON.parse(text); frameBinding(frame, nonce, resource, process.pid);
  requireMatch(frame.type === 'admit', 'initial admission'); admitted = true; break;
}
requireMatch(admitted && core.now() <= until, 'initial admission deadline');
const control = new net.Socket({ fd: 4, readable: true, writable: false });
const observation = new net.Socket({ fd: 5, readable: false, writable: true });
control.unref(); observation.unref(); process.channel.unref();
let selected, shellBound, execUsed = false, done = false, requestedExit, closing = false, selfSignal;
const shellNonce = process.env.UAT_HOST_SHELL_NONCE, shellResource = process.env.UAT_HOST_SHELL_RESOURCE;
const innerNonce = process.env.UAT_HOST_INNER_NONCE, innerResource = process.env.UAT_HOST_INNER_RESOURCE;
requireMatch(new Set([nonce, shellNonce, innerNonce, resource, shellResource, innerResource]).size === 6, 'cross-hop reuse');
const summarize = (id) => {
  if (!id) return id;
  const { env, ...rest } = id; return { ...rest, envHash: core.hash(JSON.stringify(env)) };
};
function finish() {
  if (!done || (requestedExit === undefined && !selfSignal) || closing) return;
  closing = true; control.destroy();
  observation.end(() => {
    observation.destroy(); if (process.connected) process.disconnect();
    if (selfSignal) nativeKill(process.pid, selfSignal); else nativeExit(requestedExit);
  });
}
function deny(kind) { emit({ type: 'dispatch-refused', kind }); return denyKind(kind); }
require('node:worker_threads').Worker = () => deny('Worker');
for (const key of ['spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[key] = () => deny(key);
process.kill = (pid, signal) => {
  if (pid === process.pid) { selfSignal = signal; finish(); return true; }
  return deny('numeric process.kill');
};
process.exit = (code = 0) => { requestedExit = code; if (!selected) nativeExit(code); else finish(); };
process.on('beforeExit', (code) => { requestedExit = code; if (!selected) nativeExit(74); else finish(); });
core.lines(control, (frame) => {
  frameBinding(frame, nonce, resource, process.pid);
  requireMatch(selected && shellBound, 'command before shell identity');
  if (frame.type === 'exec') {
    requireMatch(!execUsed, 'reused exec');
    core.release(selected.capability, selected.reservation, { nonce: shellNonce, resource: shellResource, identity: shellBound }, () => {
      selected.child.stdio[4].write(`exec-ack ${shellNonce} ${shellResource} ${selected.child.pid} ${process.pid}\n`);
    });
    execUsed = true; return;
  }
  if (frame.type === 'shell-cancel') { requireMatch(!execUsed, 'late shell cancellation'); core.signal(selected.capability, 'SIGTERM'); return; }
  requireMatch(execUsed && frame.type === 'inner-command', 'unordered inner relay');
  selected.child.stdio[4].write(JSON.stringify(frame.command) + '\n');
}, (e) => { emit({ type: 'fault', message: e.message }); });
cp.spawn = (file, args, options) => {
  if (selected) return deny('second spawn/pidtree helper');
  const command = 'tsx tests/uat/run-uat.ts ' + plan.publicArgv[1];
  requireMatch(file === 'sh' && same(args, ['-c', command]) && options.cwd === profile.cwd &&
    options.stdio === 'inherit' && same(Object.keys(options).sort(), ['cwd', 'env', 'stdio']), 'lifecycle call');
  const env = options.env;
  requireMatch(env.NODE_OPTIONS === profile.pnpmOptions && env.npm_lifecycle_event === 'test:uat' &&
    env.npm_lifecycle_script === command && env.INIT_CWD === profile.cwd && env.PNPM_SCRIPT_SRC_DIR === profile.cwd &&
    !env.npm_config_script_shell && !env.npm_config_shell_emulator && env.COREPACK_HOME === profile.corepackHome, 'lifecycle env');
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('npm_') && k !== 'PATH') requireMatch(env[k] === v, 'inherited lifecycle env ' + k);
  }
  // Explicit profile transformation: dispatch a scrubbed frozen shell/tsx environment.
  const childEnv = { ...inputs.environments[plan.mode], UAT_HOST_PROFILE: 'a2a-public-r1',
    UAT_HOST_PACKET: packet, UAT_HOST_CASE: plan.mode, UAT_HOST_NONCE: shellNonce, UAT_HOST_RESOURCE: shellResource,
    UAT_HOST_INNER_NONCE: innerNonce, UAT_HOST_INNER_RESOURCE: innerResource,
    UAT_HOST_TSX_CLI: profile.cli, NODE_OPTIONS: profile.tsxOptions, PWD: profile.cwd };
  const childArgs = [path.join(__dirname, 'public-shell-entry.sh'), command, plan.publicArgv[1], shellNonce, shellResource, String(process.pid)];
  const actualFile = plan.mode === 'shell-spawn-error' ? path.join(profile.cwd, 'ABSENT-A2A-SHELL') : '/usr/bin/dash';
  selected = { ...core.spawnOriginal(actualFile, childArgs, { cwd: profile.cwd, env: childEnv,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc', 'pipe', 'pipe'] }), reservation: core.reserve(shellNonce, shellResource) };
  emit({ type: 'shell-dispatch', requested: { file, args, cwd: options.cwd, stdio: options.stdio,
    envHash: core.hash(JSON.stringify(core.environment(Buffer.from(Object.entries(env).map(([k,v]) => k+'='+v).join('\0'))))) },
    dispatched: { file: actualFile, args: childArgs, envHash: core.hash(JSON.stringify(childEnv)) } });
  selected.child.stdio[5].end();
  core.lines(selected.child.stdio[5], (frame) => {
    if (frame.type === 'shell-held') {
      requireMatch(!shellBound && frame.pid === selected.child.pid && frame.ppid === process.pid &&
        frame.nonce === shellNonce && frame.resource === shellResource, 'shell original');
      shellBound = core.bind(selected.capability, { executable: '/usr/bin/dash', argv: ['/usr/bin/dash', ...childArgs],
        cwd: profile.cwd, env: core.environment(Buffer.from(Object.entries(childEnv).map(([k,v]) => k+'='+v).join('\0'))) });
      const targets = [4,5].map((n) => fs.readlinkSync('/proc/self/fd/' + n));
      const fresh = [4,5].map((n) => fs.readlinkSync('/proc/self/fd/' + selected.child.stdio[n]._handle.fd));
      endpoints(fresh, fresh); requireMatch(!fresh.some((v) => targets.includes(v)), 'outer/inner FD alias');
      emit({ type: 'shell-original', identity: summarize(shellBound), targets, fresh }); return;
    }
    requireMatch(execUsed, 'tsx before exec ACK');
    emit({ type: 'tsx-observation', frame });
  }, (e) => emit({ type: 'fault', message: e.message }));
  selected.child.on('message', (m) => { if (process.connected) process.send(m); });
  process.on('message', (m) => { if (selected.child.connected) selected.child.send(m); });
  core.done(selected.capability).then(() => {
    let result;
    try { result = core.completion(selected.capability, core.now() + 1); }
    catch (e) { emit({ type: 'fault', message: e.message }); return; }
    emit({ type: 'shell-closed', ...result, identity: summarize(result.identity),
      streams: result.streams.map(({data,...rest}) => rest) });
    done = true; finish();
  });
  // Nested reserve: tsx's retained inner must settle before this outer deadline.
  setTimeout(() => { if (!done) emit({ type: 'fault', message: 'pnpm shell cleanup deadline' }); }, 7500).unref();
  return selected.child;
};
syncBuiltinESMExports();
