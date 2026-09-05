import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";

// A killed control process must not leave deliberate runaways burning indefinitely.
setTimeout(() => process.exit(124), 90_000).unref();

const mode = process.argv[2];
const read = (path) => readFile(path, "utf8");
const report = (check) => console.log(JSON.stringify({ check, status: "pass" }));

if (mode === "baseline" || mode === "baseline-browser") {
  assert.equal(process.getuid(), 1000);
  assert.equal(process.getgid(), 1000);
  const status = await read("/proc/self/status");
  assert.match(status, /^CapEff:\s*0+$/m);
  assert.match(status, /^NoNewPrivs:\s*1$/m);
  const browser = mode === "baseline-browser";
  assert.equal(
    (await read("/sys/fs/cgroup/memory.max")).trim(),
    browser ? "536870912" : "201326592"
  );
  assert.equal((await read("/sys/fs/cgroup/memory.swap.max")).trim(), "0");
  assert.equal((await read("/sys/fs/cgroup/pids.max")).trim(), browser ? "128" : "64");
  assert.equal(
    (await read("/sys/fs/cgroup/cpu.max")).trim(),
    browser ? "50000 100000" : "25000 100000"
  );
  report("identity-and-cgroup-ceilings");

  await writeFile("/attempt/value", "private-attempt");
  assert.equal(await read("/attempt/value"), "private-attempt");
  await assert.rejects(writeFile("/outside", "escape"), { code: "EROFS" });
  // Control-side harness creates and verifies this sentinel before mounting it.
  assert.ok((await stat("/fixtures/denied")).isFile());
  await assert.rejects(read("/fixtures/denied"), { code: "EACCES" });
  await assert.rejects(writeFile("/fixtures/denied", "escape"), (error) =>
    ["EACCES", "EROFS"].includes(error.code)
  );
  for (const path of ["/app", "/data", "/var/run/docker.sock", "/root/.claude"]) {
    await assert.rejects(stat(path), { code: "ENOENT" });
  }
  report("workspace-readonly-root-and-existing-sentinel-denial");

  assert.deepEqual((await readdir("/sys/class/net")).sort(), ["lo"]);
  for (const host of ["192.0.2.1", "10.251.0.1"]) {
    const code = await new Promise((resolve, reject) => {
      const socket = createConnection({ host, port: 443 });
      socket.setTimeout(1000, () => {
        socket.destroy();
        reject(new Error("A timeout does not prove network denial"));
      });
      socket.once("connect", () => {
        socket.destroy();
        reject(new Error("Unexpected network connection"));
      });
      socket.once("error", (error) => resolve(error.code));
    });
    assert.equal(code, "ENETUNREACH");
  }
  report("no-external-network-route");
} else if (mode === "peer") {
  await writeFile("/attempt/peer-only", "peer-remains-intact");
  setInterval(() => {}, 1000);
} else if (mode === "second") {
  await assert.rejects(stat("/attempt/peer-only"), { code: "ENOENT" });
  await writeFile("/attempt/second-only", "separate-attempt");
  report("second-attempt-has-separate-workspace");
} else if (mode === "peer-check") {
  assert.equal(await read("/attempt/peer-only"), "peer-remains-intact");
  await assert.rejects(stat("/attempt/second-only"), { code: "ENOENT" });
  report("peer-survives-other-attempts");
} else if (mode === "tree" || mode === "child") {
  process.on("SIGTERM", () => {});
  const child = spawn(process.execPath, ["/probe.mjs", mode === "tree" ? "child" : "grandchild"], {
    detached: true,
    stdio: "ignore"
  });
  child.on("error", (error) => {
    throw error;
  });
  child.on("exit", (code, signal) => {
    throw new Error(`Tree child exited early: ${code ?? signal}`);
  });
  setInterval(() => {}, 1000);
} else if (mode === "grandchild") {
  process.on("SIGTERM", () => {});
  await writeFile("/attempt/tree-ready", "ready");
  setInterval(() => {}, 1000);
} else if (mode === "ready") {
  const path = process.argv[3];
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await stat(path).catch(() => false)) process.exit(0);
    await delay(100);
  }
  throw new Error("Container did not produce readiness sentinel");
} else if (mode === "oom") {
  const retained = [];
  setInterval(() => retained.push(Buffer.alloc(8 * 1024 * 1024, 1)), 20);
} else if (mode === "pids") {
  // Each child is idle; the cgroup ceiling bounds even a parent that keeps trying.
  setInterval(() => {
    const child = spawn(process.execPath, ["/probe.mjs", "idle"], { stdio: "ignore" });
    child.on("error", () => {});
  }, 50);
} else if (mode === "idle") {
  setInterval(() => {}, 1000);
} else if (mode === "cpu") {
  new Worker("while (true) {}", { eval: true });
} else if (mode === "cpu-check") {
  const match = (await read("/sys/fs/cgroup/cpu.stat")).match(/^nr_throttled (\d+)$/m);
  assert.ok(match && Number(match[1]) > 0, "CPU throttling must actually occur");
  report(mode);
} else if (["module-build", "module-web-build", "module-browser-build"].includes(mode)) {
  let encoded = "";
  for await (const chunk of process.stdin) {
    encoded += chunk.toString();
    assert.ok(Buffer.byteLength(encoded) <= 16_384, "Source envelope exceeds proof limit");
  }
  const envelope = JSON.parse(encoded);
  assert.deepEqual(Object.keys(envelope), ["files"]);
  const paths =
    mode !== "module-build"
      ? ["src/worker/index.ts", "src/web/index.ts", "src/web/styles.css"]
      : ["src/worker/index.ts"];
  assert.ok(Array.isArray(envelope.files));
  assert.equal(envelope.files.length, paths.length);
  for (const [index, source] of envelope.files.entries()) {
    assert.deepEqual(Object.keys(source).sort(), ["content", "path"]);
    assert.equal(source.path, paths[index], "Unexpected source artifact");
    assert.equal(typeof source.content, "string");
  }
  assert.ok(!Object.keys(process.env).some((key) => /TOKEN|KEY|SECRET|DATABASE/.test(key)));
  await mkdir("/attempt/module/src/worker", { recursive: true });
  await mkdir("/attempt/module/src/web", { recursive: true });
  for (const source of envelope.files) {
    await writeFile(`/attempt/module/${source.path}`, source.content);
  }
  const built = spawnSync(
    "/opt/esbuild",
    [
      "/attempt/module/src/worker/index.ts",
      "--bundle",
      "--platform=node",
      "--format=cjs",
      "--target=node20",
      "--alias:@moss/module-sdk/worker=/opt/module-sdk/worker.ts",
      "--outfile=/attempt/module/dist/worker.js"
    ],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 65_536 }
  );
  assert.equal(built.status, 0, `Sandbox compilation failed: ${built.stderr}`);
  const invoked = spawnSync(process.execPath, ["/attempt/module/dist/worker.js"], {
    input:
      JSON.stringify({
        jsonrpc: "2.0",
        id: "proof",
        method: "module.invoke",
        params: { handler: "word.read", input: {} }
      }) + "\n",
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 65_536
  });
  assert.equal(invoked.status, 0, "Compiled worker must exit successfully");
  const records = invoked.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(records.some((record) => record.method === "worker.ready"));
  assert.deepEqual(
    records.find((record) => record.id === "proof"),
    {
      jsonrpc: "2.0",
      id: "proof",
      result: { word: "quasar" }
    }
  );
  report("data-only-envelope-confined-compile-and-real-sdk-invocation");
  if (mode !== "module-build") {
    const { buildAndCheckWeb } = await import("./web-bundle-case.mjs");
    await buildAndCheckWeb();
  }
  if (mode === "module-browser-build") {
    const { renderAndCheckWeb } = await import("./browser-render-case.mjs");
    await renderAndCheckWeb();
  }
} else if (mode === "output") {
  setInterval(() => process.stdout.write("x".repeat(1024)), 50);
} else {
  throw new Error(`Unknown probe case: ${mode}`);
}
