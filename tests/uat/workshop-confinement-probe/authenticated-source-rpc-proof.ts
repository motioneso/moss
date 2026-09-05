// Bundle the current worktree, then stream into the trusted Moss container (README).
// Returned source is validated as data and never executed in this process.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, readlink, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CliStructuredAdapter } from "../../../packages/chat/src/live/cli-structured-adapter.js";
import {
  ChatEngineRpcClient,
  RpcConnection
} from "../../../packages/chat/src/live/chat-engine-rpc-client.js";
import { CliChatEngineHost } from "../../../packages/cli-runner/src/engine-host.js";
import { createSanitizedTmuxIo } from "../../../packages/cli-runner/src/runner-io.js";
import { CliRunnerServer } from "../../../packages/cli-runner/src/server.js";
import { TerminalHost } from "../../../packages/cli-runner/src/terminal-host.js";
import { createCliRunner } from "../../../packages/cli-runner/src/main.js";

const model = process.env.WORKSHOP_PROOF_MODEL;
const abortProof = process.env.WORKSHOP_PROOF_ABORT === "1";
const deadlineProof = process.env.WORKSHOP_PROOF_DEADLINE === "1";
const fullRunnerProof = process.env.WORKSHOP_PROOF_FULL_RUNNER === "1";
assert.ok(!(abortProof && deadlineProof), "Choose one lifecycle proof per run");
assert.ok(model && model !== "default", "Supply the previously selected concrete model");
const root = await mkdtemp(join(tmpdir(), "workshop-source-rpc-"));
const socketDir = `/run/jarv1s/workshop-proof-${randomUUID()}`;
const home = join(root, "home");
const credential = "/data/cli-auth/.jarvis/cli-tokens/anthropic";
const toolsPrefix = fullRunnerProof ? join(root, "tools") : "/data/cli-tools";
// All provider and adapter temporary homes belong to this run, including failed launches.
process.env.TMPDIR = root;
process.env.JARVIS_CLI_TOOLS_PREFIX = toolsPrefix;
const secret = randomUUID();
const sessionKeys: string[] = [];
const clients: ChatEngineRpcClient[] = [];
const methods = new Set<string>();
const exits: string[] = [];
const observedPids: string[] = [];
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(), 135_000);
const io = createSanitizedTmuxIo({ HOME: home, PATH: process.env.PATH });
const host = new CliChatEngineHost({
  io,
  homeBase: home,
  neutralBase: join(root, "neutral"),
  singleUser: false,
  cliPresent: async () => {
    await access(join(toolsPrefix, "bin/claude"));
    return true;
  }
});
const server = fullRunnerProof
  ? createCliRunner({
      socketPath: join(socketDir, "runner.sock"),
      rpcSecret: secret,
      singleUser: false,
      perUserUid: false,
      homeBase: home,
      neutralBase: join(root, "neutral"),
      toolsPrefix,
      persistentRuntimeEnabled: false,
      persistentPoolCap: 1,
      persistentIdleReapMinutes: 1
    })
  : new CliRunnerServer({
      host,
      socketPath: join(socketDir, "runner.sock"),
      socketDir,
      secret,
      terminalHost: new TerminalHost({ homeBase: home, toolsBinDir: join(toolsPrefix, "bin") })
    });
const rpc = new RpcConnection({
  socketPath: join(socketDir, "runner.sock"),
  rpcSecret: secret
});
const adapter = new CliStructuredAdapter(
  "anthropic",
  (provider, key, options) => {
    sessionKeys.push(key);
    const client = new ChatEngineRpcClient(
      provider,
      key,
      rpc,
      options?.executionMode,
      undefined,
      options?.needsStructuredOutput
    );
    clients.push(client);
    // Withhold stdin only for the deadline stimulus: the installed CLI must wait without a
    // model request while the unmodified engine enforces its real 120-second wall limit.
    if (deadlineProof) client.submitStructured = async () => {};
    if (abortProof || deadlineProof) {
      const read = client.readStructured.bind(client);
      client.readStructured = async (offset) => {
        const result = await read(offset);
        assert.equal(result.complete, false, "Generation completed before lifecycle check");
        if (observedPids.length === 0) {
          for (const pid of (await readdir("/proc")).filter((name) => /^\d+$/.test(name))) {
            const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => "");
            if (cwd.startsWith(join(root, "moss-source-claude-"))) observedPids.push(pid);
          }
        }
        assert.ok(observedPids.length > 0, "No live source process observed");
        if (abortProof) controller.abort();
        return result;
      };
    }
    return client;
  },
  deadlineProof ? 130_000 : 120_000
);
const peer = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  cwd: root,
  stdio: "ignore",
  env: {}
});
const peerClosed = new Promise<void>((resolve) => peer.once("close", () => resolve()));
peer.on("error", () => controller.abort());
let stage = "setup";
try {
  await mkdir(join(home, ".jarvis/cli-tokens"), { recursive: true, mode: 0o700 });
  // Never copy or print credentials; only the real runner's launch policy reads this link.
  await symlink(credential, join(home, ".jarvis/cli-tokens/anthropic"));
  await access(credential);
  if (fullRunnerProof) await mkdir(join(toolsPrefix, "bin"), { recursive: true, mode: 0o700 });
  await server.start();
  if (fullRunnerProof) {
    // Let the actual installer sweep/reconcile its empty PRIVATE inventory first. Then
    // expose only this installed executable, avoiding any shared release/config mutation.
    await symlink("/data/cli-tools/bin/claude", join(toolsPrefix, "bin/claude"));
  }
  stage = "generation";
  const startedAt = performance.now();
  const generation = adapter.generateStructured({
    model: { provider_kind: "anthropic", provider_model_id: model },
    messages: [
      {
        role: "user",
        content:
          "Return one source file src/worker/index.ts containing exactly: " +
          "export const word = 'quasar';\nDo not read files, call tools, or execute source."
      }
    ],
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["files"],
      properties: {
        files: {
          type: "array",
          minItems: 1,
          maxItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "content"],
            properties: {
              path: { const: "src/worker/index.ts" },
              content: { type: "string", maxLength: 128 }
            }
          }
        }
      }
    },
    maxOutputTokens: 256,
    sourceGeneration: true,
    signal: controller.signal,
    telemetry: {
      emit: (event) => {
        methods.add(event.kind);
        if (event.kind === "exit" && event.exit) exits.push(event.exit);
      }
    }
  });
  const result =
    abortProof || deadlineProof
      ? await generation.then(
          () => assert.fail("Stopped source generation returned a result"),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            if (deadlineProof) {
              assert.match(error.message, /Source generation timed out/);
              assert.equal(controller.signal.aborted, false);
              assert.ok(performance.now() - startedAt >= 120_000);
              assert.ok(performance.now() - startedAt < 130_000);
            } else assert.equal(error.name, "AbortError");
            assert.ok(observedPids.length > 0);
            assert.deepEqual(exits, [deadlineProof ? "no-reply" : "timeout"]);
            return undefined;
          }
        )
      : await generation;
  stage = "validation";
  if (result) {
    assert.ok("rawText" in result);
    assert.ok(Buffer.byteLength(result.rawText) <= 1024);
    const artifact = JSON.parse(result.rawText);
    assert.deepEqual(Object.keys(artifact), ["files"]);
    assert.equal(artifact.files.length, 1);
    assert.deepEqual(Object.keys(artifact.files[0]).sort(), ["content", "path"]);
    assert.equal(artifact.files[0].path, "src/worker/index.ts");
    assert.equal(artifact.files[0].content.trim(), "export const word = 'quasar';");
  }
  assert.equal(sessionKeys.length, 1);
  assert.ok(methods.has("invoked") && methods.has("exit"));
  assert.equal(await clients[0]!.isAlive(), false);
  for (const pid of observedPids) await assert.rejects(access(`/proc/${pid}`));
  assert.deepEqual(
    (await readdir(root)).filter((name) => /^(moss-source-claude-|jarv1s-structured-)/.test(name)),
    []
  );
  // A child retaining a deleted temporary cwd still exposes its original path via /proc.
  for (const pid of (await readdir("/proc")).filter((name) => /^\d+$/.test(name))) {
    const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => "");
    assert.ok(!cwd.startsWith(join(root, "moss-source-claude-")), "Provider process survived");
  }
  assert.ok(peer.pid);
  process.kill(peer.pid, 0);
  console.log(
    JSON.stringify({
      check: deadlineProof
        ? "installed-source-rpc-deadline"
        : abortProof
          ? "authenticated-source-rpc-abort"
          : "authenticated-source-rpc",
      status: "pass",
      model,
      fullRunnerComposition: fullRunnerProof,
      ...(deadlineProof
        ? { elapsedMs: Math.round(performance.now() - startedAt), promptSubmitted: false }
        : {}),
      ...(result && "rawText" in result
        ? {
            artifactBytes: Buffer.byteLength(result.rawText),
            artifactSha256: createHash("sha256").update(result.rawText).digest("hex")
          }
        : { observedSourceProcessesRemoved: observedPids.length, returnedArtifact: false }),
      privateHomesRemoved: true,
      providerCwdAbsent: true,
      peerAlive: true
    })
  );
} catch {
  // No raw exception/provider text: the proof never publishes credentials or returned content.
  console.error(JSON.stringify({ check: "authenticated-source-rpc", status: "fail", stage }));
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  const cleanup = await Promise.allSettled(clients.map((client) => client.kill()));
  rpc.close();
  peer.kill("SIGKILL");
  await peerClosed;
  await server.stop();
  await rm(socketDir, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
  assert.ok(
    cleanup.every((result) => result.status === "fulfilled"),
    "Runner cleanup failed"
  );
  await assert.rejects(access(root));
  await assert.rejects(access(socketDir));
  console.log(JSON.stringify({ check: "authenticated-source-rpc-cleanup", status: "pass" }));
}
