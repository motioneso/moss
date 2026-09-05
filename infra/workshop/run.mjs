// Container entrypoint only: never run generated source in the application/host environment.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, readFile, writeFile, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";

import { readSource } from "./source.mjs";

const ROOT = "/attempt/module";
const OUTPUT_LIMIT = 1048576;
const workerAlias = {
  "@moss/module-sdk/worker": "/opt/module-sdk/worker.ts",
  "@moss/module-sdk/time": "/opt/module-sdk/time.ts",
  "@moss/module-sdk/list-limits": "/opt/module-sdk/list-limits.ts"
};
const webAlias = {
  "@moss/module-sdk/time": workerAlias["@moss/module-sdk/time"],
  "@moss/module-sdk/list-limits": workerAlias["@moss/module-sdk/list-limits"],
  react: "/opt/module-web-sdk/runtime.ts",
  "react-dom": "/opt/module-web-sdk/react-dom-runtime.ts",
  "@moss/module-web-sdk": "/opt/module-web-sdk/index.ts",
  "@moss/ui": "/opt/ui/index.ts",
  "lucide-react": "/opt/node_modules/lucide-react/dist/esm/lucide-react.js"
};

async function bundle(entry, outfile, browser = false) {
  const result = await build({
    entryPoints: [join(ROOT, entry)],
    outfile,
    bundle: true,
    platform: browser ? "browser" : "node",
    format: browser ? "esm" : "cjs",
    target: browser ? "es2022" : "node20",
    logLevel: "silent",
    sourcemap: false,
    metafile: true,
    alias: browser ? webAlias : workerAlias,
    ...(browser
      ? {
          jsx: "transform",
          jsxFactory: "h",
          jsxFragment: "Fragment",
          tsconfigRaw: {
            compilerOptions: { jsx: "react", jsxFactory: "h", jsxFragmentFactory: "Fragment" }
          },
          inject: ["/opt/module-web-sdk/runtime.ts"],
          loader: { ".css": "text" }
        }
      : {})
  });
  if (browser) {
    assert.ok(
      Object.values(result.metafile.outputs).every((output) => output.imports.length === 0)
    );
    assert.ok(
      Object.keys(result.metafile.inputs).every(
        (input) => !/(?:^|\/)node_modules\/react(?:\/|$)|react\.production/.test(input)
      )
    );
  }
}

async function artifact(path) {
  const file = join(ROOT, path);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes;
  try {
    const stat = await handle.stat();
    assert.ok(stat.isFile() && stat.size > 0 && stat.size <= OUTPUT_LIMIT);
    const buffer = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = await handle.read(buffer, count, buffer.length - count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    assert.equal(count, stat.size);
    bytes = buffer.subarray(0, count);
  } finally {
    await handle.close();
  }
  return {
    path,
    encoding: "base64",
    content: bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

async function main() {
  const mode = process.argv[2] ?? "build";
  assert.ok(process.argv.length <= 3 && ["build", "render"].includes(mode));
  // Fail closed on an accidental unconfined invocation. Controller enforcement remains the
  // actual boundary: generated processes cannot be trusted to report their own isolation.
  assert.equal(process.getuid(), 1000);
  const readLimit = async (name) => (await readFile(`/sys/fs/cgroup/${name}`, "utf8")).trim();
  const memory = Number(await readLimit("memory.max"));
  const pids = Number(await readLimit("pids.max"));
  const [quota, period] = (await readLimit("cpu.max")).split(" ").map(Number);
  assert.ok(
    memory > 0 &&
      memory <= 536870912 &&
      pids > 0 &&
      pids <= 128 &&
      quota > 0 &&
      quota / period <= 0.5
  );
  assert.equal(await readLimit("memory.swap.max"), "0");
  assert.match(await readFile("/proc/self/status", "utf8"), /^NoNewPrivs:\s*1$/m);
  // A fresh private tmpfs is required. Refuse to reuse an old module tree.
  await mkdir(ROOT);
  await mkdir("/attempt/home");
  await mkdir("/attempt/tmp");
  const source = await readSource(process.stdin);
  const paths = source.files.map((file) => file.path);
  assert.ok(paths.includes("src/worker/index.ts"));
  for (const file of source.files) {
    const destination = join(ROOT, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.content, { flag: "wx", mode: 0o600 });
  }
  await bundle("src/worker/index.ts", `${ROOT}/dist/worker.js`);
  const outputs = [await artifact("dist/worker.js")];
  const webEntry = paths.find(
    (path) => path === "src/web/index.ts" || path === "src/web/index.tsx"
  );
  if (webEntry) {
    await bundle(webEntry, `${ROOT}/dist/web/index.js`, true);
    outputs.push(await artifact("dist/web/index.js"));
  }
  const tests = paths.filter((path) => /^tests\/.*\.test\.ts$/.test(path));
  for (let i = 0; i < tests.length; i += 1) {
    const output = `${ROOT}/dist/test-${i}.cjs`;
    await bundle(tests[i], output);
    // stdout is captured and bounded, never promoted to a host check result or log.
    execFileSync(process.execPath, ["--test", output], {
      timeout: 15000,
      killSignal: "SIGKILL",
      maxBuffer: 65536,
      stdio: ["ignore", "pipe", "pipe"],
      env: { HOME: "/attempt/home", TMPDIR: "/attempt/tmp", PATH: "/usr/local/bin" }
    });
  }
  if (mode === "render") {
    assert.ok(webEntry, "render requires a web entry");
    const { render } = await import("./render.mjs");
    await render();
    outputs.push(await artifact("preview.png"));
  }
  // R1e/V1 must validate this entire untrusted proposal again and bind current authority.
  // Successful child exits are observations, not verified acceptance or promotion permission.
  const result = JSON.stringify({
    version: 1,
    sourceSha256: createHash("sha256").update(JSON.stringify(source)).digest("hex"),
    artifacts: outputs,
    observations: {
      workerBundled: true,
      webBundled: !!webEntry,
      testProcessesExitedZero: tests.length
    }
  });
  assert.ok(Buffer.byteLength(result) <= 2097152);
  process.stdout.write(result + "\n");
}

main().catch(() => {
  process.stderr.write("Workshop runtime rejected source or failed its fixed recipe.\n");
  process.exitCode = 1;
});
