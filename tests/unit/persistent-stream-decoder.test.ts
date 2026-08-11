/**
 * Unit tests for PersistentStreamDecoder — the bounded, push-based line splitter over a
 * persistent Claude child's `--output-format stream-json` stdout (#1557 Phase 1, P1.2).
 */
import { describe, expect, it } from "vitest";

import {
  MAX_FRAME_BYTES,
  MAX_TOTAL_BUFFERED_BYTES,
  PersistentStreamDecoder
} from "../../packages/chat/src/live/persistent-stream-decoder.js";
import type { RuntimeTurnEvent } from "../../packages/chat/src/live/provider-runtime.js";

function assistantLine(opts: {
  readonly stopReason: "tool_use" | "end_turn";
  readonly content: unknown[];
}): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", stop_reason: opts.stopReason, content: opts.content },
    uuid: "u1",
    timestamp: "2026-08-10T00:00:00.000Z"
  });
}

const RESULT_LINE = JSON.stringify({ type: "result", subtype: "success", is_error: false });

async function drain(events: AsyncIterable<RuntimeTurnEvent>): Promise<RuntimeTurnEvent[]> {
  const out: RuntimeTurnEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("PersistentStreamDecoder", () => {
  it("delivers a reply record then turn-complete for one turn, one process", () => {
    const killed: string[] = [];
    const decoder = new PersistentStreamDecoder({ killChild: (reason) => killed.push(reason) });
    decoder.beginTurn("turn-1");
    decoder.write(
      assistantLine({ stopReason: "end_turn", content: [{ type: "text", text: "Here is the answer" }] }) + "\n"
    );
    decoder.write(RESULT_LINE + "\n");
    decoder.end();

    return drain(decoder.events()).then((events) => {
      expect(events).toEqual([
        { kind: "record", turnId: "turn-1", record: { kind: "reply", text: "Here is the answer" } },
        { kind: "turn-complete", turnId: "turn-1" }
      ]);
      expect(killed).toEqual([]);
    });
  });

  it("stays on the same child across three sequential turns", async () => {
    const killed: string[] = [];
    const decoder = new PersistentStreamDecoder({ killChild: (reason) => killed.push(reason) });

    for (let i = 1; i <= 3; i++) {
      const turnId = `turn-${i}`;
      decoder.beginTurn(turnId);
      decoder.write(
        assistantLine({ stopReason: "end_turn", content: [{ type: "text", text: `reply ${i}` }] }) + "\n"
      );
      decoder.write(RESULT_LINE + "\n");
    }
    decoder.end();

    const events = await drain(decoder.events());
    const completes = events.filter((e) => e.kind === "turn-complete");
    expect(completes).toHaveLength(3);
    expect(completes.map((e) => e.turnId)).toEqual(["turn-1", "turn-2", "turn-3"]);
    expect(killed).toEqual([]);
  });

  it("logs and skips a malformed JSON line without killing the child", async () => {
    const killed: string[] = [];
    const decoder = new PersistentStreamDecoder({ killChild: (reason) => killed.push(reason) });
    decoder.beginTurn("turn-1");
    decoder.write("not json at all\n");
    decoder.write(
      assistantLine({ stopReason: "end_turn", content: [{ type: "text", text: "still works" }] }) + "\n"
    );
    decoder.write(RESULT_LINE + "\n");
    decoder.end();

    const events = await drain(decoder.events());
    expect(events).toEqual([
      { kind: "record", turnId: "turn-1", record: { kind: "reply", text: "still works" } },
      { kind: "turn-complete", turnId: "turn-1" }
    ]);
    expect(killed).toEqual([]);
  });

  it("kills the child and surfaces a neutral turn failure when a single frame exceeds the bound", async () => {
    const killed: string[] = [];
    const decoder = new PersistentStreamDecoder({
      killChild: (reason) => killed.push(reason),
      maxFrameBytes: 100
    });
    decoder.beginTurn("turn-1");
    decoder.write(`${"x".repeat(200)}\n`);

    const events = await drain(decoder.events());
    expect(killed).toHaveLength(1);
    expect(events).toHaveLength(1);
    const failure = events[0];
    if (failure === undefined || failure.kind !== "turn-failed") throw new Error("expected turn-failed");
    expect(failure).toMatchObject({ kind: "turn-failed", turnId: "turn-1" });
    expect(failure.outcome.kind).toBe("neutral-failure");
    if (failure.outcome.kind !== "neutral-failure") throw new Error("expected neutral-failure");
    expect(failure.outcome.reason.toLowerCase()).not.toContain("claude");
    expect(failure.outcome.reason.toLowerCase()).not.toContain("anthropic");
  });

  it("kills the child when total buffered bytes back up past the bound (stalled consumer)", () => {
    const killed: string[] = [];
    const decoder = new PersistentStreamDecoder({
      killChild: (reason) => killed.push(reason),
      maxTotalBufferedBytes: 500
    });
    decoder.beginTurn("turn-1");
    // many small, well-formed, in-bound frames that the consumer never drains
    for (let i = 0; i < 20; i++) {
      decoder.write(
        assistantLine({ stopReason: "tool_use", content: [{ type: "thinking", thinking: `step ${i}` }] }) + "\n"
      );
    }
    expect(killed).toHaveLength(1);
    const [reason] = killed;
    if (reason === undefined) throw new Error("expected a kill reason");
    expect(reason.toLowerCase()).not.toContain("claude");
  });

  it("does not kill the child a second time once a bound has already tripped", () => {
    const killed: string[] = [];
    const decoder = new PersistentStreamDecoder({
      killChild: (reason) => killed.push(reason),
      maxFrameBytes: 50
    });
    decoder.beginTurn("turn-1");
    decoder.write(`${"x".repeat(100)}\n`);
    decoder.write(`${"y".repeat(100)}\n`);
    decoder.end();
    expect(killed).toHaveLength(1);
  });

  it("surfaces a neutral failure on stdout EOF without a terminal result frame", async () => {
    const killed: string[] = [];
    const decoder = new PersistentStreamDecoder({ killChild: (reason) => killed.push(reason) });
    decoder.beginTurn("turn-1");
    decoder.write(
      assistantLine({ stopReason: "tool_use", content: [{ type: "thinking", thinking: "still working" }] }) + "\n"
    );
    decoder.end(); // child died mid-turn, no `result` frame ever arrived

    const events = await drain(decoder.events());
    const last = events.at(-1);
    expect(last).toMatchObject({ kind: "turn-failed", turnId: "turn-1" });
    if (last === undefined || last.kind !== "turn-failed") throw new Error("expected turn-failed");
    expect(last.outcome.kind).toBe("neutral-failure");
    // EOF is not a bound violation — the decoder itself does not kill anything already dead
    expect(killed).toEqual([]);
  });

  it("does not surface a spurious failure on EOF after a clean turn-complete", async () => {
    const decoder = new PersistentStreamDecoder({ killChild: () => undefined });
    decoder.beginTurn("turn-1");
    decoder.write(
      assistantLine({ stopReason: "end_turn", content: [{ type: "text", text: "done" }] }) + "\n"
    );
    decoder.write(RESULT_LINE + "\n");
    decoder.end();

    const events = await drain(decoder.events());
    expect(events.filter((e) => e.kind === "turn-failed")).toHaveLength(0);
    expect(events.at(-1)).toEqual({ kind: "turn-complete", turnId: "turn-1" });
  });

  it("emits thinking and tool records as intermediate frames arrive", async () => {
    const decoder = new PersistentStreamDecoder({ killChild: () => undefined });
    decoder.beginTurn("turn-1");
    decoder.write(
      assistantLine({ stopReason: "tool_use", content: [{ type: "thinking", thinking: "let me check" }] }) + "\n"
    );
    decoder.write(
      assistantLine({
        stopReason: "tool_use",
        content: [{ type: "tool_use", name: "vault_read", input: {} }]
      }) + "\n"
    );
    decoder.write(assistantLine({ stopReason: "end_turn", content: [{ type: "text", text: "found it" }] }) + "\n");
    decoder.write(RESULT_LINE + "\n");
    decoder.end();

    const events = await drain(decoder.events());
    expect(events).toEqual([
      { kind: "record", turnId: "turn-1", record: { kind: "thinking", text: "let me check" } },
      {
        kind: "record",
        turnId: "turn-1",
        record: { kind: "tool", text: "vault_read", toolName: "vault_read" }
      },
      { kind: "record", turnId: "turn-1", record: { kind: "reply", text: "found it" } },
      { kind: "turn-complete", turnId: "turn-1" }
    ]);
  });

  it("exports rationale-bearing default bounds sized for real stream-json traffic", () => {
    expect(MAX_FRAME_BYTES).toBeGreaterThan(0);
    expect(MAX_TOTAL_BUFFERED_BYTES).toBeGreaterThan(MAX_FRAME_BYTES);
  });
});
