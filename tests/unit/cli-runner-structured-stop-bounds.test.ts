import type * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof childProcess>()),
  spawn
}));
import { signalGroupAs } from "../../packages/cli-runner/src/per-user-structured.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  spawn.mockReset();
});

describe("structured identity stop helper", () => {
  it("bounds a stuck stopper and kills only its fresh process group", async () => {
    vi.useFakeTimers();
    const stopper = Object.assign(new EventEmitter(), { pid: 41234 });
    spawn.mockReturnValue(stopper);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const pending = signalGroupAs(12345, "SIGKILL", { uid: 2000, gid: 2000 });
    let failure: unknown;
    void pending.catch((error: unknown) => {
      failure = error;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(failure).toEqual(new Error("structured stop helper timed out"));
    expect(kill).toHaveBeenCalledExactlyOnceWith(-41234, "SIGKILL");
    expect(spawn.mock.calls[0]?.[2]).toMatchObject({ detached: true, stdio: "ignore" });
  });
  it("clears the timeout after normal helper exit", async () => {
    vi.useFakeTimers();
    const stopper = Object.assign(new EventEmitter(), { pid: 41234 });
    spawn.mockReturnValue(stopper);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const pending = signalGroupAs(12345, "SIGKILL", { uid: 2000, gid: 2000 });
    stopper.emit("exit", 0);
    await pending;
    await vi.advanceTimersByTimeAsync(2000);
    expect(kill).not.toHaveBeenCalled();
  });
  it("rejects helper timeout even when permission prevents stopping it", async () => {
    vi.useFakeTimers();
    spawn.mockReturnValue(Object.assign(new EventEmitter(), { pid: 41234 }));
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    const outcome = expect(
      signalGroupAs(12345, "SIGKILL", { uid: 2000, gid: 2000 })
    ).rejects.toThrow("structured stop helper timed out");
    await vi.advanceTimersByTimeAsync(1000);
    await outcome;
  });
});
