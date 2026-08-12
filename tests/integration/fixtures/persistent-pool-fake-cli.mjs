#!/usr/bin/env node
// Real, spawnable, long-lived OS process fixture standing in for the `claude` binary in
// tests/integration/persistent-pool-reap.test.ts (#1554 e2e-P2, "reap is real"). Started as an
// actual child process (via ClaudePersistentRuntime's injected `spawnChild` seam — the same seam
// production wires to `bash -lc '... claude ...'`), so `ps` sees a genuine PID and a genuine
// SIGTERM/SIGKILL genuinely ends it. No Claude CLI binary or API credentials are needed: this
// script only needs to emit the same stream-json shape `PersistentStreamDecoder` already parses
// in production (mirrors tests/unit/claude-persistent-runtime.test.ts's `emitAssistantReply`
// helper) and to stay alive — like the real CLI's persistent REPL — until killed.
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  let text = "ok";
  try {
    const frame = JSON.parse(line);
    if (frame && frame.type === "user" && frame.message && typeof frame.message.content === "string") {
      text = frame.message.content;
    }
  } catch {
    // Malformed input line: ignore, matching the real CLI's tolerance of unrelated stdin noise.
  }

  process.stdout.write(
    `${JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: `echo:${text}` }]
      }
    })}\n`
  );
  process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`);
});

// Real persistent CLI processes never exit on their own between turns — only stdin closing or a
// kill signal ends them. Node's default SIGTERM/SIGKILL handling already terminates this process;
// no explicit handler is installed so the real signal-delivery path (exercised by
// ClaudePersistentRuntime.killChildProcess) is the one under test, not a fixture-specific override.
rl.on("close", () => process.exit(0));
setInterval(() => {}, 60 * 60 * 1000);
