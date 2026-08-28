/**
 * Unit tests for transcript-reader and TmuxBridgeAdapter.
 * No Postgres — all I/O boundaries are mocked.
 */
import { describe, expect, it, vi } from "vitest";

import {
  captureAckCursor,
  hasExactUserAck,
  parseTranscript
} from "../../packages/ai/src/adapters/transcript-reader.js";
import { createRealTmuxIo, transcriptGlobDir } from "../../packages/ai/src/adapters/tmux-bridge.js";

// ---------------------------------------------------------------------------
// Fixtures: real JSONL schema per provider (discovered 2026-06-07)
//
// Claude Code (anthropic):
//   Each record: { type: "assistant"|"user"|..., message: { role, content[], stop_reason }, ... }
//   content items: { type: "thinking"|"text"|"tool_use", thinking?, text?, name? }
//   Final reply signal: stop_reason === "end_turn" AND content contains { type:"text", text:"..." }
//   Intermediate: stop_reason === "tool_use" (thinking / tool_use content items)
//
// Codex (openai-compatible):
//   Each record: { type: "event_msg"|"response_item"|"session_meta"|"turn_context", ... }
//   event_msg.payload.type: "agent_reasoning" (thinking), "exec_command_end" (tool),
//                           "agent_message" (status text), "task_complete" (final)
//   Final: type==="event_msg" && payload.type==="task_complete" &&
//           payload.last_agent_message (string)
//   Also: type==="response_item" && payload.role==="assistant" && payload.phase==="final_answer"
//          && payload.content[0].type==="output_text"
//
// Gemini CLI (google):
//   Each record: { type: "gemini"|"user"|"info"|"error"|... }
//   type==="gemini": intermediate if content === "" (only thoughts present);
//                   final if content is a non-empty string
//   thoughts: [{ subject, description }]
// ---------------------------------------------------------------------------

// ─── anthropic / Claude Code fixtures ───────────────────────────────────────

const CLAUDE_FIXTURE_THINKING = JSON.stringify({
  parentUuid: "abc",
  isSidechain: false,
  type: "assistant",
  message: {
    role: "assistant",
    stop_reason: "tool_use",
    content: [{ type: "thinking", thinking: "let me consider this" }]
  },
  uuid: "u1",
  timestamp: "2026-06-07T00:00:00.000Z",
  sessionId: "sess1"
});

const CLAUDE_FIXTURE_TOOL_USE = JSON.stringify({
  parentUuid: "abc",
  isSidechain: false,
  type: "assistant",
  message: {
    role: "assistant",
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]
  },
  uuid: "u2",
  timestamp: "2026-06-07T00:00:01.000Z",
  sessionId: "sess1"
});

const CLAUDE_FIXTURE_FINAL = JSON.stringify({
  parentUuid: "abc",
  isSidechain: false,
  type: "assistant",
  message: {
    role: "assistant",
    stop_reason: "end_turn",
    content: [{ type: "text", text: "Here is the final answer." }]
  },
  uuid: "u3",
  timestamp: "2026-06-07T00:00:02.000Z",
  sessionId: "sess1"
});

// ─── openai-compatible / Codex fixtures ──────────────────────────────────────

const CODEX_FIXTURE_REASONING = JSON.stringify({
  timestamp: "2026-06-06T11:01:50.000Z",
  type: "event_msg",
  payload: { type: "agent_reasoning", text: "thinking about the task" }
});

const CODEX_FIXTURE_EXEC = JSON.stringify({
  timestamp: "2026-06-06T11:01:55.000Z",
  type: "event_msg",
  payload: { type: "exec_command_end", command: ["/bin/bash", "-lc", "git status"] }
});

const CODEX_FIXTURE_FINAL = JSON.stringify({
  timestamp: "2026-06-06T11:02:44.000Z",
  type: "event_msg",
  payload: {
    type: "task_complete",
    turn_id: "turn1",
    last_agent_message: "All done, sir."
  }
});

const CODEX_EXEC_FUNCTION_CALL = JSON.stringify({
  timestamp: "2026-06-26T12:00:00.000Z",
  type: "response_item",
  payload: {
    type: "function_call",
    name: "shell",
    arguments: '{"cmd":"git status --short"}'
  }
});

const CODEX_EXEC_FUNCTION_OUTPUT = JSON.stringify({
  timestamp: "2026-06-26T12:00:01.000Z",
  type: "response_item",
  payload: {
    type: "function_call_output",
    output: "?? docs/superpowers/specs/example.md"
  }
});

// ─── codex `exec --json` stream fixtures (codex-cli 0.139.0+, #1242) ──────────
// A DIFFERENT schema from the rollout-session file above: thread.started → turn.started →
// item.completed{item:{type,text}} → turn.completed. This is what the headless one-shot
// CodexExecSession (P-02a / epic #1238) parses from `codex exec --json` stdout.

const CODEX_EXECJSON_THREAD = JSON.stringify({ type: "thread.started", thread_id: "t-abc" });
const CODEX_EXECJSON_TURN_START = JSON.stringify({ type: "turn.started" });
const CODEX_EXECJSON_REASONING = JSON.stringify({
  type: "item.completed",
  item: { type: "reasoning", text: "considering the request" }
});
const CODEX_EXECJSON_TOOL = JSON.stringify({
  type: "item.completed",
  item: { type: "command_execution", command: "git status --short" }
});
const CODEX_EXECJSON_AGENT_MESSAGE = JSON.stringify({
  type: "item.completed",
  item: { type: "agent_message", text: "PONG from codex." }
});
const CODEX_EXECJSON_TURN_DONE = JSON.stringify({
  type: "turn.completed",
  usage: { input_tokens: 10, output_tokens: 2 }
});

// ─── google / Gemini CLI fixtures ────────────────────────────────────────────
//
// #2028 — the real `-o stream-json` output of `@google/gemini-cli@0.57.0`, recorded from a live
// run. The reply arrives ONLY as `delta: true` chunks and the turn ends on `result`.

const GEMINI_FIXTURE_INIT = JSON.stringify({
  type: "init",
  timestamp: "2026-08-27T12:00:00.000Z",
  session_id: "11111111-2222-4333-8444-555555555555",
  model: "auto"
});

const GEMINI_FIXTURE_USER = JSON.stringify({
  type: "message",
  timestamp: "2026-08-27T12:00:00.100Z",
  role: "user",
  content: "say the alphabet"
});

const geminiChunk = (content: string) =>
  JSON.stringify({
    type: "message",
    timestamp: "2026-08-27T12:00:01.000Z",
    role: "assistant",
    content,
    delta: true
  });

const GEMINI_FIXTURE_TOOL_USE = JSON.stringify({
  type: "tool_use",
  timestamp: "2026-08-27T12:00:02.000Z",
  tool_name: "read_file",
  tool_id: "t1",
  parameters: { path: "./word.txt" }
});

const GEMINI_FIXTURE_TOOL_RESULT = JSON.stringify({
  type: "tool_result",
  timestamp: "2026-08-27T12:00:02.500Z",
  tool_id: "t1",
  status: "success",
  output: "alpha"
});

const GEMINI_FIXTURE_RESULT_OK = JSON.stringify({
  type: "result",
  timestamp: "2026-08-27T12:00:03.000Z",
  status: "success",
  stats: { turns: 1 }
});

const GEMINI_FIXTURE_RESULT_ERROR = JSON.stringify({
  type: "result",
  timestamp: "2026-08-27T12:00:03.000Z",
  status: "error",
  stats: { turns: 1 },
  error: { message: "quota exhausted" }
});

// ===========================================================================
// parseTranscript tests
// ===========================================================================

describe("parseTranscript — anthropic (Claude Code JSONL schema)", () => {
  it("returns thinking + tool activity events and the final reply on end_turn", () => {
    const jsonl = [CLAUDE_FIXTURE_THINKING, CLAUDE_FIXTURE_TOOL_USE, CLAUDE_FIXTURE_FINAL].join(
      "\n"
    );

    const result = parseTranscript("anthropic", jsonl, 0);

    expect(result.events.map((e) => e.kind)).toEqual(["thinking", "tool"]);
    expect(result.reply).toBe("Here is the final answer.");
    expect(result.complete).toBe(true);
  });

  it("reports incomplete when no end_turn record is present", () => {
    const jsonl = [CLAUDE_FIXTURE_THINKING, CLAUDE_FIXTURE_TOOL_USE].join("\n");

    const result = parseTranscript("anthropic", jsonl, 0);

    expect(result.complete).toBe(false);
    expect(result.reply).toBeNull();
    expect(result.events.length).toBe(2);
  });

  it("respects afterOffset (skips bytes already processed)", () => {
    const first = CLAUDE_FIXTURE_THINKING + "\n";
    const second = CLAUDE_FIXTURE_FINAL + "\n";
    const jsonl = first + second;

    const result = parseTranscript("anthropic", jsonl, first.length);

    expect(result.events.length).toBe(0);
    expect(result.complete).toBe(true);
    expect(result.reply).toBe("Here is the final answer.");
  });

  it("skips malformed / partial lines without throwing", () => {
    const jsonl = CLAUDE_FIXTURE_THINKING + "\n{bad json}\n" + CLAUDE_FIXTURE_FINAL;

    expect(() => parseTranscript("anthropic", jsonl, 0)).not.toThrow();
    const result = parseTranscript("anthropic", jsonl, 0);
    expect(result.complete).toBe(true);
  });
});

describe("parseTranscript — openai-compatible (Codex JSONL schema)", () => {
  it("returns thinking + tool activity events and the final reply on task_complete", () => {
    const jsonl = [CODEX_FIXTURE_REASONING, CODEX_FIXTURE_EXEC, CODEX_FIXTURE_FINAL].join("\n");

    const result = parseTranscript("openai-compatible", jsonl, 0);

    expect(result.events.map((e) => e.kind)).toEqual(["thinking", "tool"]);
    expect(result.reply).toBe("All done, sir.");
    expect(result.complete).toBe(true);
  });

  it("reports incomplete when no task_complete record is present", () => {
    const jsonl = [CODEX_FIXTURE_REASONING, CODEX_FIXTURE_EXEC].join("\n");

    const result = parseTranscript("openai-compatible", jsonl, 0);

    expect(result.complete).toBe(false);
    expect(result.reply).toBeNull();
  });

  it("maps non-interactive Codex function call records to tool activity", () => {
    const jsonl = [CODEX_EXEC_FUNCTION_CALL, CODEX_EXEC_FUNCTION_OUTPUT, CODEX_FIXTURE_FINAL].join(
      "\n"
    );

    const result = parseTranscript("openai-compatible", jsonl, 0);

    expect(result.events.map((e) => e.kind)).toEqual(["tool", "tool"]);
    expect(result.events[0]?.text).toContain("shell");
    expect(result.events[1]?.text).toContain("function_call_output");
    expect(result.complete).toBe(true);
    expect(result.reply).toBe("All done, sir.");
  });

  // #1242: codex-cli 0.139.0 `exec --json` stdout — the schema the headless one-shot engine reads.
  it("returns the agent_message item as the final reply on the exec --json stream", () => {
    const jsonl = [
      CODEX_EXECJSON_THREAD,
      CODEX_EXECJSON_TURN_START,
      CODEX_EXECJSON_REASONING,
      CODEX_EXECJSON_TOOL,
      CODEX_EXECJSON_AGENT_MESSAGE,
      CODEX_EXECJSON_TURN_DONE
    ].join("\n");

    const result = parseTranscript("openai-compatible", jsonl, 0);

    expect(result.events.map((e) => e.kind)).toEqual(["thinking", "tool"]);
    expect(result.events[1]?.text).toContain("git status");
    expect(result.reply).toBe("PONG from codex.");
    expect(result.complete).toBe(true);
  });

  it("reports incomplete on the exec --json stream before the agent_message item", () => {
    const jsonl = [CODEX_EXECJSON_THREAD, CODEX_EXECJSON_TURN_START, CODEX_EXECJSON_REASONING].join(
      "\n"
    );

    const result = parseTranscript("openai-compatible", jsonl, 0);

    expect(result.complete).toBe(false);
    expect(result.reply).toBeNull();
  });
});

describe("exact user ACK evidence", () => {
  const claudeUser = (text: string) =>
    JSON.stringify({ type: "user", message: { role: "user", content: text } });
  const codexUser = (text: string) =>
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: text } });

  it.each([["anthropic", claudeUser] as const, ["openai-compatible", codexUser] as const])(
    "requires an exact complete user record after the cursor for %s",
    (provider, userRecord) => {
      const old = userRecord("yes") + "\n";
      const cursor = captureAckCursor(old);

      expect(hasExactUserAck(provider, old, cursor, "yes")).toBe(false);
      expect(hasExactUserAck(provider, old + userRecord("say yes now") + "\n", cursor, "yes")).toBe(
        false
      );
      expect(hasExactUserAck(provider, old + userRecord("yes"), cursor, "yes")).toBe(false);
      expect(hasExactUserAck(provider, old + userRecord("yes") + "\n", cursor, "yes")).toBe(true);
    }
  );

  it("does not promote a pre-cursor partial record into a current-attempt ACK", () => {
    const prefix = claudeUser("yes").slice(0, -1);
    const cursor = captureAckCursor(prefix);
    const completedOldRecord = prefix + "}\n";

    expect(hasExactUserAck("anthropic", completedOldRecord, cursor, "yes")).toBe(false);
    expect(
      hasExactUserAck("anthropic", completedOldRecord + claudeUser("yes") + "\n", cursor, "yes")
    ).toBe(true);
  });

  // #1170 second kill link: non-bracketed tmux paste makes claude 2.1.215 record
  // multiline user turns with `\r` where the engine submitted `\n` (probe-confirmed).
  // The ack compare must tolerate newline flavor — and ONLY newline flavor.
  it.each([["anthropic", claudeUser] as const, ["openai-compatible", codexUser] as const])(
    "matches a CR-recorded multiline paste against the LF expectedText for %s",
    (provider, userRecord) => {
      const expected = "Read the file.\n\n<attachments>\nmanifest line\n</attachments>";
      const crRecorded = "Read the file.\r\r<attachments>\rmanifest line\r</attachments>";
      const crlfRecorded = expected.replace(/\n/g, "\r\n");
      const cursor = captureAckCursor("");

      expect(hasExactUserAck(provider, userRecord(crRecorded) + "\n", cursor, expected)).toBe(true);
      expect(hasExactUserAck(provider, userRecord(crlfRecorded) + "\n", cursor, expected)).toBe(
        true
      );
      // Normalization must not loosen the match beyond newline flavor.
      expect(
        hasExactUserAck(provider, userRecord("Read the file.\rDIFFERENT") + "\n", cursor, expected)
      ).toBe(false);
    }
  );
});

describe("parseTranscript — google (Gemini CLI stream-json schema)", () => {
  it("joins the assistant chunks in arrival order into one reply", () => {
    // The single most likely wrong implementation returns the FIRST chunk, which is one word.
    const jsonl = [
      GEMINI_FIXTURE_INIT,
      GEMINI_FIXTURE_USER,
      geminiChunk("alpha "),
      geminiChunk("bravo "),
      geminiChunk("charlie"),
      GEMINI_FIXTURE_RESULT_OK
    ].join("\n");

    const result = parseTranscript("google", jsonl, 0);

    expect(result.reply).toBe("alpha bravo charlie");
    expect(result.complete).toBe(true);
  });

  it("never treats the echoed user prompt as reply text", () => {
    const jsonl = [GEMINI_FIXTURE_INIT, GEMINI_FIXTURE_USER, GEMINI_FIXTURE_RESULT_OK].join("\n");

    const result = parseTranscript("google", jsonl, 0);

    expect(result.reply).toBe("");
    expect(result.reply).not.toContain("say the alphabet");
  });

  it("does not report the turn finished until the result line arrives", () => {
    const jsonl = [GEMINI_FIXTURE_INIT, geminiChunk("alpha "), geminiChunk("bravo")].join("\n");

    const result = parseTranscript("google", jsonl, 0);

    expect(result.complete).toBe(false);
    expect(result.reply).toBeNull();
  });

  it("finishes the turn and surfaces the message when the run failed", () => {
    // Without this the turn hangs until the idle watchdog fires and the founder sees nothing.
    const jsonl = [GEMINI_FIXTURE_INIT, GEMINI_FIXTURE_RESULT_ERROR].join("\n");

    const result = parseTranscript("google", jsonl, 0);

    expect(result.complete).toBe(true);
    expect(result.events).toEqual([{ kind: "status", text: "quota exhausted" }]);
  });

  it("reports tool lines as activity, never as part of the reply", () => {
    const jsonl = [
      GEMINI_FIXTURE_INIT,
      GEMINI_FIXTURE_TOOL_USE,
      GEMINI_FIXTURE_TOOL_RESULT,
      geminiChunk("done"),
      GEMINI_FIXTURE_RESULT_OK
    ].join("\n");

    const result = parseTranscript("google", jsonl, 0);

    expect(result.events).toEqual([
      { kind: "tool", text: "read_file" },
      { kind: "tool", text: "tool result: success" }
    ]);
    expect(result.reply).toBe("done");
  });
});

describe("transcriptGlobDir (anthropic project-dir encoding)", () => {
  it("keeps the leading dash and replaces '/' and '.' with '-'", () => {
    // Regression: Claude Code stores transcripts under
    //   ~/.claude/projects/-home-USER-Jarv1s-apps-worker/
    // The encoder previously stripped the leading dash, so the worker polled a
    // non-existent directory and always timed out waiting for the reply.
    // Uses an explicit homeBase so the expected path is deterministic (not tied
    // to the running user's homedir).
    const dir = transcriptGlobDir(
      "anthropic",
      "/home/operator/Jarv1s/apps/worker",
      "/home/operator"
    );
    expect(dir.endsWith("/-home-operator-Jarv1s-apps-worker")).toBe(true);
    expect(dir).toContain("/.claude/projects/");
  });

  it("encodes dotted path segments with dashes (e.g. .claude worktrees)", () => {
    const dir = transcriptGlobDir(
      "anthropic",
      "/home/operator/Jarv1s/.claude/worktrees/x",
      "/home/operator"
    );
    expect(dir.endsWith("/-home-operator-Jarv1s--claude-worktrees-x")).toBe(true);
  });

  it("#1353 — replaces a colon too, as Claude Code does", () => {
    // The live-chat neutral dir is `<neutralBase>/<sessionKey>`, and a session key
    // carries a surface suffix (`<userId>:drawer`). Claude Code encodes EVERY
    // character outside [a-zA-Z0-9-] as "-", so the colon becomes a dash. The old
    // encoder replaced only "/" and ".", kept the colon, and therefore polled a
    // directory that never existed — every prod chat turn produced no records at
    // all, ran the full 180s idle watchdog, and returned an empty reply with no
    // message persisted.
    const dir = transcriptGlobDir(
      "anthropic",
      "/data/cli-auth/chat/e5c01155-9c05-4f96-8059-8b0f56ec1bf2:drawer",
      "/data/cli-auth"
    );
    expect(dir.endsWith("/-data-cli-auth-chat-e5c01155-9c05-4f96-8059-8b0f56ec1bf2-drawer")).toBe(
      true
    );
    expect(dir).not.toContain(":");
  });

  it("#1353 — preserves case and does not collapse runs of separators", () => {
    // Two properties the character-class widening must NOT break: Claude Code keeps
    // the original casing, and `/.` produces a DOUBLE dash rather than one.
    const dir = transcriptGlobDir("anthropic", "/home/Op/A.B/.x", "/home/Op");
    expect(dir.endsWith("/-home-Op-A-B--x")).toBe(true);
  });

  it("#1353 — encodes every other character Claude Code rejects", () => {
    const dir = transcriptGlobDir("anthropic", "/tmp/a b_c@d+e", "/h");
    expect(dir.endsWith("/-tmp-a-b-c-d-e")).toBe(true);
  });
});

describe("createRealTmuxIo — env/cwd passthrough", () => {
  it("run() accepts an optional opts arg without throwing (env/cwd are optional)", async () => {
    const io = createRealTmuxIo();
    // `true` is a real binary that ignores args; opts must be accepted by the type + at runtime.
    const res = await io.run("true", [], { env: { JARVIS_TEST: "1" }, cwd: "/tmp" });
    expect(res.code).toBe(0);
  });

  it("uses the supplied base environment for launched processes", async () => {
    const io = createRealTmuxIo({ ...process.env, HOME: "/data/cli-auth" });
    const res = await io.run(process.execPath, [
      "-e",
      "process.stdout.write(process.env.HOME ?? '')"
    ]);

    expect(res).toMatchObject({ code: 0, stdout: "/data/cli-auth" });
  });
});

describe("transcriptGlobDir — homeBase override", () => {
  it("uses the provided homeBase instead of the OS homedir", () => {
    const dir = transcriptGlobDir("anthropic", "/tmp/x", "/custom/home");
    expect(dir.startsWith("/custom/home/.claude/projects/")).toBe(true);
  });

  it("defaults to the OS homedir when homeBase is omitted (unchanged behavior)", () => {
    // Machine-agnostic: the encoded segment is derived from the cwd string verbatim
    // (no ~ expansion), so assert the join shape without hardcoding a username.
    const dir = transcriptGlobDir("anthropic", "/tmp/x");
    expect(dir).toMatch(/[^/]+\/\.claude\/projects\/-tmp-x$/);
  });
});

describe("transcriptGlobDir — Codex date directory", () => {
  it("uses the host local date for Codex session directories", () => {
    vi.useFakeTimers();
    try {
      const now = new Date("2026-06-18T05:30:00.000Z");
      vi.setSystemTime(now);
      const dir = transcriptGlobDir("openai-compatible", "/tmp/x", "/custom/home");
      const localYear = now.getFullYear();
      const localMonth = String(now.getMonth() + 1).padStart(2, "0");
      const localDay = String(now.getDate()).padStart(2, "0");
      expect(dir).toBe(`/custom/home/.codex/sessions/${localYear}/${localMonth}/${localDay}`);
    } finally {
      vi.useRealTimers();
    }
  });
});
