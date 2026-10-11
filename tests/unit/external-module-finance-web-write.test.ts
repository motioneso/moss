// tests/unit/external-module-finance-web-write.test.ts
//
// The host drops a manual run started within five seconds of the last one on the same
// queue, answering 202 with no job id. runWrite must never lose a command to that.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  WRITE_SPACING_MS,
  resetWriteQueues,
  runWrite
} from "../../external-modules/finance/src/web/api.js";

let sent: Array<{ at: number; body: Record<string, unknown> }> = [];
let dropNext = 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
  sent = [];
  dropNext = 0;
  resetWriteQueues();
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    sent.push({ at: Date.now(), body: JSON.parse(init.body) });
    const dropped = dropNext > 0;
    if (dropped) dropNext -= 1;
    return { status: 202, json: async () => ({ jobId: dropped ? null : `j${sent.length}` }) };
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("runWrite", () => {
  it("spaces two writes on one queue apart so the host never drops the second", async () => {
    const first = runWrite("finance.budget-apply", "finance.budget-apply", { n: 1 });
    const second = runWrite("finance.budget-apply", "finance.budget-apply", { n: 2 });
    await vi.advanceTimersByTimeAsync(WRITE_SPACING_MS + 100);
    expect(await first).toEqual({ kind: "queued" });
    expect(await second).toEqual({ kind: "queued" });
    expect(sent).toHaveLength(2);
    expect(sent[1]!.at - sent[0]!.at).toBeGreaterThanOrEqual(WRITE_SPACING_MS);
  });

  it("reports a dropped run as an error, never as success", async () => {
    dropNext = 10;
    const outcome = runWrite("finance.budget-apply", "finance.budget-apply", { n: 1 });
    await vi.advanceTimersByTimeAsync(WRITE_SPACING_MS * 4);
    expect(await outcome).toEqual({ kind: "error", message: "The request was dropped" });
  });

  it("retries a dropped run and succeeds when the host lets it through", async () => {
    dropNext = 1;
    const outcome = runWrite("finance.budget-apply", "finance.budget-apply", { n: 1 });
    await vi.advanceTimersByTimeAsync(WRITE_SPACING_MS * 2);
    expect(await outcome).toEqual({ kind: "queued" });
    expect(sent).toHaveLength(2);
  });

  it("merges a waiting command when the caller allows it", async () => {
    const merge = (a: Record<string, unknown>, b: Record<string, unknown>) => ({
      ids: [...(a.ids as string[]), ...(b.ids as string[])]
    });
    const first = runWrite("q", "k", { ids: ["a"] }, merge);
    const second = runWrite("q", "k", { ids: ["b"] }, merge);
    const third = runWrite("q", "k", { ids: ["c"] }, merge);
    await vi.advanceTimersByTimeAsync(WRITE_SPACING_MS * 2);
    expect(await Promise.all([first, second, third])).toEqual([
      { kind: "queued" },
      { kind: "queued" },
      { kind: "queued" }
    ]);
    // The first goes out at once; the two that waited for the window travel together.
    expect(sent).toHaveLength(2);
    expect((sent[1]!.body.params as { ids: string[] }).ids).toEqual(["b", "c"]);
  });

  it("keeps commands apart when the merge refuses", async () => {
    const refuse = () => null;
    const first = runWrite("q", "k", { n: 1 }, refuse);
    const second = runWrite("q", "k", { n: 2 }, refuse);
    await vi.advanceTimersByTimeAsync(WRITE_SPACING_MS * 2);
    await Promise.all([first, second]);
    expect(sent).toHaveLength(2);
  });
});
