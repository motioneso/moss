import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXPECTED_WINDOWS,
  completeWindow,
  receiptSha256,
  requestWindow,
  serveWindows,
  verifyWindows,
  type WindowConsumer,
  type WindowLog
} from "./n3-window-handshake.js";

const ACTOR = "00000000-0000-4000-8000-000000000001";
const THREAD = "11111111-1111-4111-8111-111111111111";
const TURN = "22222222-2222-4222-8222-222222222222";
const fast = { pollMs: 2, timeoutMs: 400 };
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const evidence = () => {
  const dir = mkdtempSync(join(tmpdir(), "n3-window-"));
  dirs.push(dir);
  return dir;
};
const receipts = (seq: number) => ({
  seq,
  turnId: TURN,
  http: { status: 200, finished: true as const, receiptSha256: receiptSha256({ seq }) },
  ui: { finished: true as const, receiptSha256: receiptSha256({ ui: seq }) }
});
function fakeConsumer(overrides: Partial<WindowConsumer> = {}) {
  const calls: string[] = [];
  const consumer: WindowConsumer = {
    async beginWindow(_actor, _thread, mode) {
      calls.push(`begin:${mode}`);
      return calls.filter((c) => c.startsWith("begin")).length;
    },
    async finishWindow(attestation) {
      calls.push(`finish:${attestation.turnId}`);
      return { delta: { turn: 1 } };
    },
    ...overrides
  };
  return { consumer, calls };
}
const request = (seq: number, mode: "terminal" | "positive" = "terminal") => ({
  seq,
  actorUserId: ACTOR,
  threadId: THREAD,
  mode
});

describe("N3 window handshake", () => {
  it("runs open, turn and close in order across two sides", async () => {
    const dir = evidence();
    const { consumer, calls } = fakeConsumer();
    const server = serveWindows(dir, consumer, fast);
    for (const [seq, mode] of [
      [1, "positive"],
      [2, "terminal"]
    ] as const) {
      await requestWindow(dir, request(seq, mode), fast);
      expect(calls.at(-1)).toBe(`begin:${mode}`);
      await completeWindow(dir, receipts(seq), fast);
      expect(calls.at(-1)).toBe(`finish:${TURN}`);
    }
    const log = await server.stop();
    expect(log.failure).toBeNull();
    expect(log.open).toBe(false);
    verifyWindows(log, ["positive", "terminal"]);
  });

  it("fails the test side when no worker acknowledges", async () => {
    const dir = evidence();
    await expect(requestWindow(dir, request(1), fast)).rejects.toThrow("no acknowledgement");
  });

  it("fails the test side at once when the observer refuses to open", async () => {
    const dir = evidence();
    const { consumer } = fakeConsumer({
      beginWindow: () => Promise.reject(new Error("globally-open"))
    });
    const server = serveWindows(dir, consumer, fast);
    await expect(requestWindow(dir, request(1), { ...fast, timeoutMs: 2000 })).rejects.toThrow(
      "open refused"
    );
    const log = await server.stop();
    expect(log.failure).toContain("globally-open");
    expect(() => verifyWindows(log, ["terminal"])).toThrow("N3 windows failed");
  });

  it("fails the test side when the observer rejects the completion", async () => {
    const dir = evidence();
    const { consumer } = fakeConsumer({
      finishWindow: () => Promise.reject(new Error("single-turn"))
    });
    const server = serveWindows(dir, consumer, fast);
    await requestWindow(dir, request(1), fast);
    await expect(completeWindow(dir, receipts(1), { ...fast, timeoutMs: 2000 })).rejects.toThrow(
      "close refused"
    );
    const log = await server.stop();
    expect(log.open).toBe(true);
    expect(() => verifyWindows(log, ["terminal"])).toThrow();
  });

  it("rejects a malformed request and a malformed completion", async () => {
    const dir = evidence();
    const { consumer, calls } = fakeConsumer();
    const server = serveWindows(dir, consumer, fast);
    await expect(
      requestWindow(dir, { ...request(1), threadId: "not-a-uuid" }, { ...fast, timeoutMs: 2000 })
    ).rejects.toThrow("open refused");
    expect(calls).toEqual([]);
    const log = await server.stop();
    expect(log.failure).toContain("malformed");

    const dir2 = evidence();
    const second = serveWindows(dir2, fakeConsumer().consumer, fast);
    await requestWindow(dir2, request(1), fast);
    await expect(
      completeWindow(
        dir2,
        { ...receipts(1), http: { ...receipts(1).http, receiptSha256: "short" } },
        { ...fast, timeoutMs: 2000 }
      )
    ).rejects.toThrow("close refused");
    expect((await second.stop()).open).toBe(true);
  });

  it("reports a window left open when stopped before completion", async () => {
    const dir = evidence();
    const server = serveWindows(dir, fakeConsumer().consumer, fast);
    await requestWindow(dir, request(1), fast);
    const log = await server.stop();
    expect(log.open).toBe(true);
    expect(log.failure).toContain("never arrived");
  });

  it("refuses to write a request twice", async () => {
    const dir = evidence();
    const server = serveWindows(dir, fakeConsumer().consumer, fast);
    await requestWindow(dir, request(1), fast);
    await expect(requestWindow(dir, request(1), fast)).rejects.toThrow();
    await server.stop();
  });

  it("verifies the exact ordered window list", () => {
    const entry = (mode: "terminal" | "positive", seq: number) => ({
      seq,
      mode,
      window: seq,
      delta: {}
    });
    const log = (completed: WindowLog["completed"], extra: Partial<WindowLog> = {}): WindowLog => ({
      completed,
      failure: null,
      open: false,
      ...extra
    });
    const full = [entry("positive", 1), entry("terminal", 2), entry("terminal", 3)];
    verifyWindows(log(full), ["positive", "terminal", "terminal"]);
    expect(() =>
      verifyWindows(log(full.slice(0, 2)), ["positive", "terminal", "terminal"])
    ).toThrow("incomplete");
    expect(() =>
      verifyWindows(log([...full].reverse()), ["positive", "terminal", "terminal"])
    ).toThrow("incomplete");
    expect(() =>
      verifyWindows(log(full, { open: true }), ["positive", "terminal", "terminal"])
    ).toThrow("left open");
    expect(() =>
      verifyWindows(log(full, { failure: "x" }), ["positive", "terminal", "terminal"])
    ).toThrow("failed");
  });
});

describe("expected window list", () => {
  const SPEC = "tests/uat/specs/3529-scheduled-read-terminal-real.uat.spec.ts";
  const order = (source: string) =>
    [
      ...source
        .replace(/async function sendInMain[^\n]*\n/, "")
        .matchAll(/sendInMain\(\s*page,[\s\S]*?,\s*"(positive|terminal)"\s*\)/g)
    ].map((match) => match[1]);

  it("is one harmless reply and then two terminal turns", () => {
    expect(EXPECTED_WINDOWS).toEqual(["positive", "terminal", "terminal"]);
  });

  it("matches the order the real-UI spec sends its turns", () => {
    const source = readFileSync(SPEC, "utf8");
    expect(order(source)).toEqual([...EXPECTED_WINDOWS]);
    const swapped = source
      .replace('"positive")', '"terminal")')
      .replace(/(\n\s*)"terminal"(\n\s*\);)/, '$1"positive"$2');
    expect(order(swapped)).not.toEqual([...EXPECTED_WINDOWS]);
  });
});
