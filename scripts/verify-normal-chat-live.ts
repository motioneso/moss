/** Isolated real Chat/receiver UI proof. Must run inside verify-gate. */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertGateRunDatabaseAccess } from "@moss/db";
import { createCliRunner, readConfig } from "../packages/cli-runner/src/main.js";

assertGateRunDatabaseAccess(process.env);
const directory = await mkdtemp(join(tmpdir(), "moss-normal-chat-proof-"));
const socketDirectory = join("/run/jarv1s", `voice-proof-${randomUUID()}`);
await mkdir(socketDirectory, { mode: 0o700 });
process.env.JARVIS_CLI_RUNNER_SOCKET = join(socketDirectory, "runner.sock");
process.env.JARVIS_CLI_RUNNER_RPC_SECRET = randomBytes(32).toString("hex");
process.env.VOCCI_LIVE_BROWSER_SCRIPT = resolve("scripts/proofs/vocci-normal-chat-input.py");
await Promise.all(["homes", "chat", "tools"].map((name) => mkdir(join(directory, name))));
const runner = createCliRunner({
  ...readConfig(),
  socketPath: process.env.JARVIS_CLI_RUNNER_SOCKET,
  rpcSecret: process.env.JARVIS_CLI_RUNNER_RPC_SECRET,
  homeBase: join(directory, "homes"),
  neutralBase: join(directory, "chat"),
  toolsPrefix: join(directory, "tools"),
  perUserUid: false,
  allowSharedUid: true
});
try {
  await runner.start();
  await import("./verify-recording-import-live.js");
} finally {
  await runner.stop();
  await Promise.all([
    rm(directory, { recursive: true, force: true }),
    rm(socketDirectory, { recursive: true, force: true })
  ]);
}
