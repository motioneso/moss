#!/usr/bin/env python3
"""Disposable local image proof. Never installs a service or runs source on the host."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import selectors
import subprocess
import time
import uuid
import zlib
import struct


def docker(*args, timeout=30):
    return subprocess.run(["docker", *args], check=True, capture_output=True, timeout=timeout).stdout


def bounded_start(name, payload=b"", timeout=60):
    process = subprocess.Popen(["docker", "start", "-ai", name], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    output = {"stdout": bytearray(), "stderr": bytearray()}
    pending = memoryview(payload)
    deadline = time.monotonic() + timeout
    with selectors.DefaultSelector() as selector:
        for stream, kind in [(process.stdout, "stdout"), (process.stderr, "stderr")]:
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, kind)
        if pending:
            os.set_blocking(process.stdin.fileno(), False)
            selector.register(process.stdin, selectors.EVENT_WRITE, "stdin")
        else:
            process.stdin.close()
        try:
            while selector.get_map():
                if time.monotonic() > deadline:
                    raise TimeoutError("owned image proof exceeded wall limit")
                for key, _ in selector.select(min(1, max(0, deadline - time.monotonic()))):
                    if key.data == "stdin":
                        try:
                            count = os.write(key.fd, pending)
                            pending = pending[count:]
                        except BrokenPipeError:
                            pending = memoryview(b"")
                        if not pending:
                            selector.unregister(key.fileobj)
                            key.fileobj.close()
                        continue
                    chunk = os.read(key.fd, 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        key.fileobj.close()
                        continue
                    output[key.data].extend(chunk)
                    limit = 2097152 if key.data == "stdout" else 65536
                    if len(output[key.data]) > limit:
                        raise ValueError("owned image proof exceeded output limit")
            return process.wait(timeout=5), bytes(output["stdout"]), bytes(output["stderr"])
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            for stream in [process.stdin, process.stdout, process.stderr]:
                stream.close()


def report(check, **fields):
    print(json.dumps({"check": check, "status": "pass", **fields}), flush=True)


WORKER = """import { defineModuleWorker } from '@moss/module-sdk/worker';
export default defineModuleWorker({handlers: {'word.read': async () => ({word: 'quasar'})}});
"""
WEB = """import { h, useState } from '@moss/module-web-sdk';
import { Button } from '@moss/ui';
function Root() { const [word, setWord] = useState('');
  return h('main', null, h('h1', null, 'Daily word'), h(Button, {onClick: () => setWord('quasar')}, 'Show word'), h('p', null, word)); }
export default {contractVersion: 2, Root, css: '.word { padding: 16px; }'};
"""
TEST = """import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { createConnection } from 'node:net';
test('no external route', async () => {
  const code = await new Promise((resolve, reject) => {
    const socket = createConnection({host:'192.0.2.1',port:443});
    socket.setTimeout(1000, () => {socket.destroy();reject(new Error('timeout is not denial'));});
    socket.once('connect', () => {socket.destroy();reject(new Error('unexpected connection'));});
    socket.once('error', error => resolve(error.code));
  });
  assert.equal(code, 'ENETUNREACH');
});
test('actual public SDK invocation and confinement', () => {
  assert.equal(process.getuid(), 1000);
  assert.ok(!Object.keys(process.env).some(key => /TOKEN|KEY|SECRET|DATABASE/.test(key)));
  assert.equal(readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim(), '536870912');
  assert.equal(readFileSync('/sys/fs/cgroup/memory.swap.max', 'utf8').trim(), '0');
  assert.equal(readFileSync('/sys/fs/cgroup/pids.max', 'utf8').trim(), '128');
  assert.equal(readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim(), '50000 100000');
  assert.match(readFileSync('/proc/self/status', 'utf8'), /^CapEff:\\s*0+$/m);
  assert.match(readFileSync('/proc/self/status', 'utf8'), /^NoNewPrivs:\\s*1$/m);
  assert.deepEqual(readdirSync('/sys/class/net'), ['lo']);
  for (const path of ['/app', '/data', '/var/run/docker.sock', '/root/.claude', '/usr/bin/npm', '/bin/sh']) assert.equal(existsSync(path), false);
  assert.throws(() => writeFileSync('/escape', 'no'), {code:'EROFS'});
  const result = spawnSync(process.execPath, ['/attempt/module/dist/worker.js'], {
    input: JSON.stringify({jsonrpc:'2.0',id:'proof',method:'module.invoke',params:{handler:'word.read',input:{}}}) + '\\n',
    encoding:'utf8',timeout:5000,maxBuffer:65536});
  assert.equal(result.status, 0);
  const records = result.stdout.trim().split('\\n').map(line => JSON.parse(line));
  assert.ok(records.some(record => record.method === 'worker.ready'));
  assert.deepEqual(records.find(record => record.id === 'proof').result, {word:'quasar'});
});
"""


def envelope(test=TEST, web=True, browser=False):
    if test is not None and not browser:
        test = test.replace("536870912", "201326592").replace("'128'", "'64'").replace("50000 100000", "25000 100000")
    files = [{"path": "src/worker/index.ts", "content": WORKER}]
    if web:
        files.append({"path": "src/web/index.ts", "content": WEB})
    if test is not None:
        files.append({"path": "tests/runtime.test.ts", "content": test})
    return {"files": files}


def verify_artifacts(result, expected):
    assert result["version"] == 1
    assert {file["path"] for file in result["artifacts"]} == expected
    decoded = {}
    for file in result["artifacts"]:
        assert set(file) == {"path", "encoding", "content", "sha256"}
        assert file["encoding"] == "base64"
        data = base64.b64decode(file["content"], validate=True)
        assert 0 < len(data) <= 1048576
        assert hashlib.sha256(data).hexdigest() == file["sha256"]
        decoded[file["path"]] = data
    return decoded


def verify_png(data):
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    assert struct.unpack(">II", data[16:24]) == (900, 700)
    position = 8
    while position < len(data):
        length = struct.unpack(">I", data[position:position+4])[0]
        end = position + 12 + length
        assert end <= len(data)
        assert zlib.crc32(data[position+4:end-4]) & 0xffffffff == struct.unpack(">I", data[end-4:end])[0]
        position = end
    assert position == len(data) and data[-8:-4] == b"IEND"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True, help="immutable locally built sha256 image ID")
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    assert args.image.startswith("sha256:") and len(args.image) == 71
    args.output_dir.mkdir(parents=True, exist_ok=False)
    prefix = "workshop-r1c-" + uuid.uuid4().hex[:12]
    owned = []

    def create(label, *command, entry=None, browser=False):
        memory, pids, cpu = ("512m", "128", "0.5") if browser else ("192m", "64", "0.25")
        name = prefix + "-" + label
        command_line = ["create", "-i", "--name", name, "--network", "none", "--read-only", "--cap-drop", "ALL",
                        "--security-opt", "no-new-privileges", "--memory", memory, "--memory-swap", memory,
                        "--pids-limit", pids, "--cpus", cpu, "--log-driver", "none",
                        "--ulimit", "nofile=256:256", "--tmpfs", "/attempt:rw,noexec,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=0700"]
        if entry:
            command_line += ["--entrypoint", entry]
        docker(*command_line, args.image, *command)
        owned.append(name)
        return name

    def run(label, value, mode="build", success=True):
        name = create(label, mode, browser=mode == "render")
        code, stdout, stderr = bounded_start(name, json.dumps(value, separators=(",", ":")).encode())
        assert (code == 0) == success, f"{label}: exit {code}; {stderr[:200].decode(errors='replace')}"
        if success:
            assert not stderr, f"{label}: unexpected diagnostic output"
            return json.loads(stdout)
        assert not stdout, f"{label}: failure exported an artifact"
        assert stderr == b"Workshop runtime rejected source or failed its fixed recipe.\n"
        report(label, exitCode=code)
        return None

    try:
        peer = create("peer", "-e", "require('fs').writeFileSync('/attempt/peer','intact');setInterval(()=>{},1000)", entry="/usr/local/bin/node")
        docker("start", peer)
        value = envelope()
        built = run("build", value)
        artifacts = verify_artifacts(built, {"dist/worker.js", "dist/web/index.js"})
        assert built["observations"]["testProcessesExitedZero"] == 1
        canonical = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
        assert built["sourceSha256"] == hashlib.sha256(canonical).hexdigest()
        report("public-sdk-worker-invocation-and-profile", image=args.image)
        rendered = run("render", envelope(browser=True), "render")
        raster = verify_artifacts(rendered, {"dist/worker.js", "dist/web/index.js", "preview.png"})
        assert raster["dist/worker.js"] == artifacts["dist/worker.js"]
        assert raster["dist/web/index.js"] == artifacts["dist/web/index.js"]
        verify_png(raster["preview.png"])
        (args.output_dir / "preview.png").write_bytes(raster["preview.png"])
        report("offline-web-render-and-stable-bundles", pngBytes=len(raster["preview.png"]))
        for label, invalid in [
            ("traversal", {"files": [{"path": "../escape.ts", "content": "x"}]}),
            ("duplicate", {"files": [value["files"][0], value["files"][0]]}),
            ("extra-command", {**value, "command": "echo bad"}),
            ("oversized-source", {"files": [{"path": "SPEC.md", "content": "x" * 32769}]}),
            ("unsupported-dependency", {"files": [{"path": "src/worker/index.ts", "content": "import 'not-installed';"}]})
        ]:
            run(label, invalid, success=False)
        run("test-output-flood", envelope("process.stdout.write('x'.repeat(100000));", web=False), success=False)
        started = time.monotonic()
        run("test-wall-timeout", envelope("setInterval(() => {}, 1000);", web=False), success=False)
        assert time.monotonic() - started < 40
        stresses = {
            "workspace-ceiling": "const fs=require('fs');try{fs.writeFileSync('/attempt/full',Buffer.alloc(70*1024*1024,1));process.exit(2)}catch(e){if(e.code!=='ENOSPC')throw e}",
            "pid-ceiling": "const fs=require('fs'),cp=require('child_process');setInterval(()=>{cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}).on('error',()=>{});if(Number(fs.readFileSync('/sys/fs/cgroup/pids.events','utf8').match(/max (\\d+)/)[1])>0)process.exit(0)},50)",
            "cpu-throttling": "new(require('worker_threads').Worker)('while(true){}',{eval:true});setTimeout(()=>{const s=require('fs').readFileSync('/sys/fs/cgroup/cpu.stat','utf8');process.exit(Number(s.match(/nr_throttled (\\d+)/)[1])>0?0:2)},3000)"
        }
        for label, script in stresses.items():
            name = create(label, "-e", script, entry="/usr/local/bin/node")
            code, out, err = bounded_start(name, timeout=30)
            assert code == 0, f"{label}: {code} {err[:200]}"
            report(label)
        oom = create("oom", "-e", "const held=[];setInterval(()=>held.push(Buffer.alloc(8*1024*1024,1)),20)", entry="/usr/local/bin/node")
        code, out, err = bounded_start(oom, timeout=30)
        assert code == 137 and docker("inspect", "--format", "{{.State.OOMKilled}}", oom).strip() == b"true"
        report("memory-ceiling", exitCode=code)
        assert docker("inspect", "--format", "{{.State.Running}}", peer).strip() == b"true"
        assert docker("exec", peer, "/usr/local/bin/node", "-e", "process.stdout.write(require('fs').readFileSync('/attempt/peer'))") == b"intact"
        report("peer-survives-failures-and-child-timeout")
        (args.output_dir / "evidence.json").write_text(json.dumps({"image": args.image, "checksPassed": True, "previewSha256": hashlib.sha256(raster["preview.png"]).hexdigest()}, indent=2) + "\n")
    finally:
        for name in reversed(owned):
            docker("rm", "-f", name)
        remaining = docker("ps", "-aq", "--filter", "name=" + prefix).strip()
        assert not remaining
        report("owned-container-cleanup", count=len(owned))


if __name__ == "__main__":
    if not __debug__:
        raise RuntimeError("This proof requires assertions; do not use Python -O")
    main()
