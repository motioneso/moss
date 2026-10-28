import { createHash } from "node:crypto";
import { existsSync, linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CompletionAttestation } from "./n3-fallback-observer-runner.js";

/**
 * File handshake between the worker (owns the observer) and the browser test child (cannot
 * call it). Every file lives in the private evidence directory and is written once.
 *
 * test:   window-<n>-request.json  -> worker begins the window
 * worker: window-<n>-ack.json      -> test may send its chat turn
 * test:   window-<n>-done.json     -> worker finishes the window with the receipts
 * worker: window-<n>-result.json   -> test may continue
 *
 * Either side fails closed on a timeout, a malformed file or an error reply.
 */
export type WindowMode = "terminal" | "positive";

/** The real-UI spec's turns, in order: one harmless positive, then the two terminal turns. */
export const EXPECTED_WINDOWS: readonly WindowMode[] = ["positive", "terminal", "terminal"];

export interface WindowRequest {
  readonly version: 1;
  readonly seq: number;
  readonly actorUserId: string;
  readonly threadId: string;
  readonly mode: WindowMode;
}
export interface WindowDone {
  readonly version: 1;
  readonly seq: number;
  readonly turnId: string;
  readonly http: {
    readonly status: number;
    readonly finished: true;
    readonly receiptSha256: string;
  };
  readonly ui: { readonly finished: true; readonly receiptSha256: string };
}
export interface WindowEntry {
  readonly seq: number;
  readonly mode: WindowMode;
  readonly window: number;
  readonly delta: Readonly<Record<string, number>>;
}
export interface WindowLog {
  readonly completed: readonly WindowEntry[];
  readonly failure: string | null;
  /** True when a window was begun and never finished. */
  readonly open: boolean;
}
/** The two observer calls the worker drives; the real consumer satisfies this shape. */
export interface WindowConsumer {
  beginWindow(actorUserId: string, threadId: string, mode: WindowMode): Promise<number>;
  finishWindow(
    attestation: CompletionAttestation
  ): Promise<{ delta: Readonly<Record<string, number>> }>;
}
interface Timing {
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HEX = /^[a-f0-9]{64}$/;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const path = (dir: string, seq: number, kind: "request" | "ack" | "done" | "result") =>
  join(dir, `window-${seq}-${kind}.json`);

function writeOnce(file: string, value: unknown): void {
  const staged = `${file}.tmp`;
  writeFileSync(staged, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
  try {
    linkSync(staged, file); // Fails if the file exists, so a reply can never be replaced.
  } finally {
    unlinkSync(staged);
  }
}
function readJson(file: string): unknown {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
}
async function waitFor(
  file: string,
  timing: Timing,
  stopped: () => boolean = () => false
): Promise<unknown> {
  const end = Date.now() + (timing.timeoutMs ?? 60_000);
  for (;;) {
    const value = readJson(file);
    if (value !== undefined) return value;
    if (stopped() || Date.now() > end) return undefined;
    await sleep(timing.pollMs ?? 100);
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Receipt hashes cover metadata only: path, status and message ids, never message text. */
export function receiptSha256(parts: Record<string, string | number | boolean>): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function parseRequest(value: unknown, seq: number): WindowRequest {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.seq !== seq ||
    typeof value.actorUserId !== "string" ||
    !UUID.test(value.actorUserId) ||
    typeof value.threadId !== "string" ||
    !UUID.test(value.threadId) ||
    (value.mode !== "terminal" && value.mode !== "positive")
  )
    throw new Error("window request malformed");
  return value as unknown as WindowRequest;
}
function parseDone(value: unknown, seq: number): WindowDone {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.seq !== seq ||
    typeof value.turnId !== "string" ||
    !UUID.test(value.turnId) ||
    !isRecord(value.http) ||
    value.http.finished !== true ||
    typeof value.http.status !== "number" ||
    typeof value.http.receiptSha256 !== "string" ||
    !HEX.test(value.http.receiptSha256) ||
    !isRecord(value.ui) ||
    value.ui.finished !== true ||
    typeof value.ui.receiptSha256 !== "string" ||
    !HEX.test(value.ui.receiptSha256)
  )
    throw new Error("window completion malformed");
  return value as unknown as WindowDone;
}
function expectOk(reply: unknown, seq: number, what: string): void {
  if (!isRecord(reply) || reply.version !== 1 || reply.seq !== seq)
    throw new Error(`N3 window ${seq}: ${what} reply malformed`);
  if (reply.ok !== true)
    throw new Error(`N3 window ${seq}: ${what} refused (${String(reply.reason)})`);
}

/** Test side: ask the worker to open a window, and block until it acknowledges. */
export async function requestWindow(
  dir: string,
  request: Omit<WindowRequest, "version">,
  timing: Timing = {}
): Promise<void> {
  writeOnce(path(dir, request.seq, "request"), { version: 1, ...request });
  const reply = await waitFor(path(dir, request.seq, "ack"), timing);
  if (reply === undefined) throw new Error(`N3 window ${request.seq}: no acknowledgement`);
  expectOk(reply, request.seq, "open");
}
/** Test side: hand over the completion receipts, and block until the worker closed the window. */
export async function completeWindow(
  dir: string,
  done: Omit<WindowDone, "version">,
  timing: Timing = {}
): Promise<void> {
  writeOnce(path(dir, done.seq, "done"), { version: 1, ...done });
  const reply = await waitFor(path(dir, done.seq, "result"), timing);
  if (reply === undefined) throw new Error(`N3 window ${done.seq}: window never closed`);
  expectOk(reply, done.seq, "close");
}

export interface WindowServer {
  /** Stops polling and reports what happened. A window still open is a failure. */
  stop(): Promise<WindowLog>;
}
/** Worker side: serve windows in sequence until stopped or the first failure. */
export function serveWindows(
  dir: string,
  consumer: WindowConsumer,
  timing: Timing = {}
): WindowServer {
  const completed: WindowEntry[] = [];
  let failure: string | null = null;
  let open = false;
  let stopped = false;
  const loop = (async () => {
    for (let seq = 1; !stopped && !failure; seq++) {
      let phase: "ack" | "result" = "ack";
      try {
        const raw = await waitFor(
          path(dir, seq, "request"),
          { ...timing, timeoutMs: 2 ** 31 },
          () => stopped
        );
        if (raw === undefined) return;
        const request = parseRequest(raw, seq);
        const window = await consumer.beginWindow(
          request.actorUserId,
          request.threadId,
          request.mode
        );
        open = true;
        writeOnce(path(dir, seq, "ack"), { version: 1, seq, ok: true });
        phase = "result";
        const rawDone = await waitFor(path(dir, seq, "done"), timing, () => stopped);
        if (rawDone === undefined) throw new Error("completion receipt never arrived");
        const done = parseDone(rawDone, seq);
        const finished = await consumer.finishWindow({
          actorUserId: request.actorUserId,
          threadId: request.threadId,
          surface: "drawer",
          turnId: done.turnId,
          complete: true,
          http: done.http,
          ui: done.ui
        });
        open = false;
        completed.push({ seq, mode: request.mode, window, delta: finished.delta });
        writeOnce(path(dir, seq, "result"), { version: 1, seq, ok: true });
      } catch (error) {
        failure = `window ${seq} ${phase}: ${error instanceof Error ? error.message : "failed"}`;
        // Tell a waiting test to fail now rather than time out.
        try {
          writeOnce(path(dir, seq, phase), {
            version: 1,
            seq,
            ok: false,
            reason: "observer error"
          });
        } catch {
          /* The test side will time out and fail closed. */
        }
      }
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
      return { completed, failure, open };
    }
  };
}

/** Run-level verdict: the exact windows, in order, all complete, nothing left open. */
export function verifyWindows(log: WindowLog, expected: readonly WindowMode[]): void {
  if (log.failure) throw new Error(`N3 windows failed: ${log.failure}`);
  if (log.open) throw new Error("N3 window left open");
  const modes = log.completed.map((entry) => entry.mode);
  if (modes.length !== expected.length || modes.some((mode, i) => mode !== expected[i]))
    throw new Error(`N3 windows incomplete: saw [${modes.join(",")}]`);
}
