'use strict';
// This adapter is only for the pinned direct tsx invocation; never a general monitor.
const cp = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { syncBuiltinESMExports } = require('node:module');
const core = require('./original-child.cjs');
const packet = process.env.UAT_HOST_PACKET;
const nonce = process.env.UAT_HOST_NONCE, resource = process.env.UAT_HOST_RESOURCE;
const root = path.resolve(__dirname, '../..');
const deps = path.resolve(root, '../node_modules');
const cli = path.join(deps, 'tsx/dist/cli.mjs');
const fixture = path.join(packet || '', 'fixture.cjs');
const mode = process.argv[process.argv.length - 1];
const publicProfile = process.env.UAT_HOST_PROFILE === 'a2a-public-r1';
const publicInputs = publicProfile ? JSON.parse(fs.readFileSync(path.join(packet, 'inputs.json'), 'utf8')) : null;
const publicPlan = publicProfile && publicInputs.plans.find((p) => p.mode === process.env.UAT_HOST_CASE);
const publicCli = publicProfile && publicInputs.public.cli;
const expectedParent = publicProfile ? ['/usr/bin/node', publicCli, 'tests/uat/run-uat.ts', publicPlan?.publicArgv[1]] :
  ['/usr/bin/node', cli, '--no-cache', fixture, mode];
if (!packet || !/^[a-f0-9]{64}$/.test(nonce || '') || !/^[a-f0-9]{64}$/.test(resource || '') ||
    JSON.stringify(process.argv) !== JSON.stringify(expectedParent) ||
    !process.send) throw Error('unselected tsx parent');
if (publicProfile && (process.env.NODE_OPTIONS !== publicInputs.public.tsxOptions ||
    process.cwd() !== publicInputs.public.cwd || !publicPlan)) throw Error('unselected A2a profile');
const control = new net.Socket({ fd: 4, readable: true, writable: false });
const observation = new net.Socket({ fd: 5, readable: false, writable: true });
let cleanupTimer;
let selected, childReady = false, barrierConsumed = false, released = false, finished = false, exitCode;
const nativeExit = process.exit.bind(process);
const nativeKill = process.kill.bind(process);
const publicIdentity = (id) => {
  if (!publicProfile || !id) return id;
  const { env, ...rest } = id; return { ...rest, envHash: core.hash(JSON.stringify(env)) };
};
const send = (value) => {
  const frame = JSON.stringify({ ...value, nonce, resource, parent: process.pid }) + '\n';
  if (Buffer.byteLength(frame) > 4096) throw Error('parent observation overflow');
  observation.write(frame);
};
if (publicProfile) send({ type: 'tsx-held', identity: publicIdentity(core.identity(process.pid)) });
function fail(error) {
  if (finished) return;
  send({ type: 'fault', message: error.message });
  if (selected) {
    try { core.signal(selected.capability, 'SIGKILL'); } catch (e) { send({ type: 'fault', message: e.message }); }
  } else nativeExit(74);
}
core.lines(control, (frame) => {
  if (!selected || !childReady || frame.nonce !== nonce || frame.resource !== resource ||
      frame.parent !== process.pid) throw Error('wrong original parent/challenge');
  if (frame.type === 'cancel') {
    core.checkIdentity(frame.identity, core.snapshot(selected.capability).identity);
    core.signal(selected.capability, 'SIGTERM'); return;
  }
  if (frame.type !== 'release' || released) throw Error('reused/unknown release');
  const id = core.snapshot(selected.capability).identity;
  core.checkIdentity(frame.identity, id);
  core.release(selected.capability, selected.reservation, {
    nonce: publicProfile ? process.env.UAT_HOST_INNER_NONCE : nonce,
    resource: publicProfile ? process.env.UAT_HOST_INNER_RESOURCE : resource, identity: id }, (inner) => {
    selected.child.stdio[4].end(JSON.stringify(inner) + '\n');
  });
  released = true;
}, fail);
const deny = () => { throw Error('A1 refuses unexpected parent spawn/worker; esbuild requires B'); };
require('node:worker_threads').Worker = deny;
for (const key of ['spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[key] = deny;
cp.spawn = (file, args, options) => {
  const selectedDeps = publicProfile ? path.dirname(path.dirname(publicCli)) : path.join(deps, 'tsx');
  const expected = ['--require', path.join(selectedDeps, 'dist/preflight.cjs'), '--import',
    pathToFileURL(path.join(selectedDeps, 'dist/loader.mjs')).href,
    ...(publicProfile ? ['tests/uat/run-uat.ts', publicPlan.publicArgv[1]] : [fixture, mode])];
  const env = { ...process.env, TSX_DISABLE_CACHE: '1' };
  if (selected || file !== '/usr/bin/node' || JSON.stringify(args) !== JSON.stringify(expected) ||
      JSON.stringify(options.stdio) !== JSON.stringify(['inherit', 'inherit', 'inherit', 'ipc']) ||
      JSON.stringify(options.env) !== JSON.stringify(env) || Object.keys(options).some((k) => !['env', 'stdio'].includes(k))) {
    throw Error('A1 unexpected tsx original spawn; refused before dispatch');
  }
  const innerNonce = publicProfile ? process.env.UAT_HOST_INNER_NONCE : nonce;
  const innerResource = publicProfile ? process.env.UAT_HOST_INNER_RESOURCE : resource;
  const childEnv = { ...env };
  if (publicProfile) {
    delete childEnv.NODE_OPTIONS;
    childEnv.UAT_HOST_NONCE = innerNonce; childEnv.UAT_HOST_RESOURCE = innerResource;
  }
  const dispatched = publicProfile && publicPlan.mode !== 'real-producer-held-only' ?
    [...args.slice(0, 4), fixture, publicPlan.fixtureMode] : args;
  const childArgs = ['--require', path.join(__dirname, 'producer-barrier.cjs'), ...dispatched];
  const reservation = core.reserve(innerNonce, innerResource);
  const result = core.spawnOriginal(file, childArgs, { ...options, env: childEnv, stdio: [...options.stdio, 'pipe', 'pipe'] });
  selected = { ...result, reservation };
  cleanupTimer = setTimeout(() => {
    send({ type: 'fault', message: 'inner original cleanup deadline' });
    try { core.signal(selected.capability, 'SIGKILL'); } catch (e) { send({ type: 'fault', message: e.message }); }
  }, 5500);
  cleanupTimer.unref();
  const { child, capability } = selected;
  // Both endpoints are new inner pipes. The producer cannot write the outer observation pipe.
  const outerTarget = fs.readlinkSync('/proc/self/fd/5');
  const innerTarget = fs.readlinkSync('/proc/self/fd/' + child.stdio[5]._handle.fd);
  if (outerTarget === innerTarget) throw Error('inner observation aliases outer');
  child.stdio[5].end();
  core.lines(child.stdio[5], (ready) => {
    if (ready.type === 'release-consumed') {
      if (!childReady || !released || barrierConsumed || ready.nonce !== innerNonce || ready.resource !== innerResource ||
          ready.pid !== child.pid || ready.ppid !== process.pid) throw Error('unordered barrier release consumption');
      barrierConsumed = true;
      send({ type: 'barrier-consumed', identity: publicIdentity(core.snapshot(capability).identity) });
      return;
    }
    if (childReady || ready.type !== 'ready' || ready.nonce !== innerNonce || ready.resource !== innerResource ||
        ready.pid !== child.pid || ready.ppid !== process.pid) throw Error('wrong child barrier readiness');
    const id = core.bind(capability, { executable: '/usr/bin/node', cwd: process.cwd(),
      argv: [file, ...childArgs], env: core.environment(Buffer.from(Object.entries(childEnv).map(([k,v]) => k + '=' + v).join('\0'))) });
    childReady = true;
    send({ type: 'original', identity: publicIdentity(id), distinctInnerPipes: outerTarget !== innerTarget,
      ...(publicProfile ? { requestedArgs: args, dispatchedArgs: childArgs } : {}) });
  }, fail);
  core.done(capability).then(() => {
    clearTimeout(cleanupTimer);
    let summary;
    try {
      const result = core.completion(capability, core.now() + 1);
      summary = { type: 'closed', terminal: result.terminal, close: result.close,
        disconnected: result.disconnected, streams: result.streams.map(({fd,end,close,error,bytes}) => ({fd,end,close,error,bytes})),
        identity: publicIdentity(result.identity), faults: result.faults };
    } catch (e) { summary = { type: 'fault', message: e.message }; }
    finished = true;
    send(summary);
    control.destroy();
    observation.end(() => {
      observation.destroy();
      if (process.connected) process.disconnect();
      nativeExit(exitCode === undefined ? 74 : exitCode);
    });
  }).catch(fail);
  return child;
};
// tsx exits in its child's close listener. Flush the separate trusted observation first.
process.exit = (code = 0) => { exitCode = code; if (!selected) nativeExit(code); };
// No PID/group signaling is added; tsx's own direct-original relay remains intact.
process.kill = nativeKill;
syncBuiltinESMExports();
