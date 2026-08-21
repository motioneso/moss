/**
 * TerminalHost (#1059): single-active-session lifecycle manager on top of the
 * TerminalSession PTY primitive. Uses `makeSession` injection so these tests are
 * pure/fast/deterministic — no real PTY spawns, no timers left dangling.
 */
import { describe, it, expect, vi } from "vitest";
import { TerminalHost } from "../../packages/cli-runner/src/terminal-host.js";
import type { TerminalSession } from "../../packages/cli-runner/src/terminal-session.js";

function fakeSession(id: string) {
  const listeners: Array<(b: Buffer) => void> = [];
  return {
    id,
    killed: false,
    onData: (cb: (b: Buffer) => void) => listeners.push(cb),
    onExit: (_: (c: number) => void) => {},
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    // #1059: `this` is the fake-session object; only `.killed` is touched.
    kill: vi.fn(function (this: { killed: boolean }) {
      this.killed = true;
    }),
    _emit: (s: string) => listeners.forEach((l) => l(Buffer.from(s)))
  };
}

// #1059: the fake stands in for the real TerminalSession PTY primitive; cast
// through `unknown` at the makeSession boundary so tests stay strongly typed
// (no `any`) while only implementing the surface TerminalHost actually calls.
type FakeSession = ReturnType<typeof fakeSession>;
const asSession = (s: FakeSession): TerminalSession => s as unknown as TerminalSession;

describe("TerminalHost (#1059)", () => {
  it("opening a second terminal evicts the first (single active session)", () => {
    const made: FakeSession[] = [];
    const host = new TerminalHost({
      homeBase: "/tmp",
      toolsBinDir: "/usr/bin",
      makeSession: (o) => {
        const s = fakeSession(o.id);
        made.push(s);
        return asSession(s);
      }
    });
    const sink = { data: vi.fn(), exit: vi.fn() };
    host.open({ cols: 80, rows: 24 }, sink);
    host.open({ cols: 80, rows: 24 }, sink);
    expect(made[0]!.kill).toHaveBeenCalledTimes(1);
    expect(made[1]!.kill).not.toHaveBeenCalled();
  });

  it("routes PTY output to the sink by terminalId", () => {
    let made!: FakeSession;
    const host = new TerminalHost({
      homeBase: "/tmp",
      toolsBinDir: "/usr/bin",
      makeSession: (o) => {
        made = fakeSession(o.id);
        return asSession(made);
      }
    });
    const sink = { data: vi.fn(), exit: vi.fn() };
    const { terminalId } = host.open({ cols: 80, rows: 24 }, sink);
    made._emit("out");
    expect(sink.data).toHaveBeenCalledWith(terminalId, Buffer.from("out"));
  });

  it("write with a non-matching terminalId does not extend the idle timer", () => {
    vi.useFakeTimers();
    try {
      let made!: FakeSession;
      const host = new TerminalHost({
        homeBase: "/tmp",
        toolsBinDir: "/usr/bin",
        idleMs: 1000,
        makeSession: (o) => {
          made = fakeSession(o.id);
          return asSession(made);
        }
      });
      const sink = { data: vi.fn(), exit: vi.fn() };
      host.open({ cols: 80, rows: 24 }, sink);
      // #1059: bogus terminalId — forId() no-ops the write, and must also skip touch()
      host.write({
        terminalId: "bogus-id-not-the-session",
        dataB64: Buffer.from("x").toString("base64")
      });
      vi.advanceTimersByTime(1001);
      expect(made.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("trailing output from an evicted session does not rearm the successor's idle timer", () => {
    vi.useFakeTimers();
    try {
      const made: FakeSession[] = [];
      const host = new TerminalHost({
        homeBase: "/tmp",
        toolsBinDir: "/usr/bin",
        idleMs: 1000,
        makeSession: (o) => {
          const s = fakeSession(o.id);
          made.push(s);
          return asSession(s);
        }
      });
      const sink = { data: vi.fn(), exit: vi.fn() };
      host.open({ cols: 80, rows: 24 }, sink); // made[0] — evicted by the next open()
      host.open({ cols: 80, rows: 24 }, sink); // made[1] — the live session
      // #1059: straggler async output from the killed session must not rearm made[1]'s timer
      made[0]!._emit("straggler");
      vi.advanceTimersByTime(1001);
      expect(made[1]!.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a false return from sink.data pauses the live PTY once (#1526)", () => {
    let made!: FakeSession;
    const host = new TerminalHost({
      homeBase: "/tmp",
      toolsBinDir: "/usr/bin",
      makeSession: (o) => {
        made = fakeSession(o.id);
        return asSession(made);
      }
    });
    const sink = { data: vi.fn().mockReturnValue(false), exit: vi.fn() };
    host.open({ cols: 80, rows: 24 }, sink);
    made._emit("out");
    expect(made.pause).toHaveBeenCalledTimes(1);
  });

  it("resume() is a no-op for an evicted terminal id (#1526)", () => {
    const made: FakeSession[] = [];
    const host = new TerminalHost({
      homeBase: "/tmp",
      toolsBinDir: "/usr/bin",
      makeSession: (o) => {
        const s = fakeSession(o.id);
        made.push(s);
        return asSession(s);
      }
    });
    const sink = { data: vi.fn(), exit: vi.fn() };
    const { terminalId: firstId } = host.open({ cols: 80, rows: 24 }, sink); // made[0] — evicted
    host.open({ cols: 80, rows: 24 }, sink); // made[1] — the live session
    host.resume(firstId);
    expect(made[0]!.resume).not.toHaveBeenCalled();
  });

  it("resume() resumes the live terminal by id (#1526)", () => {
    let made!: FakeSession;
    const host = new TerminalHost({
      homeBase: "/tmp",
      toolsBinDir: "/usr/bin",
      makeSession: (o) => {
        made = fakeSession(o.id);
        return asSession(made);
      }
    });
    const sink = { data: vi.fn(), exit: vi.fn() };
    const { terminalId } = host.open({ cols: 80, rows: 24 }, sink);
    host.resume(terminalId);
    expect(made.resume).toHaveBeenCalledTimes(1);
  });
});
