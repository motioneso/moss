import { describe, expect, it, vi } from "vitest";
import type { BrowserSessionBinding, SessionBindingsService } from "@moss/auth";
import {
  ComputerInputControl,
  ComputerInputDenied
} from "../../apps/api/src/computer/input-control.js";

const instant = Date.parse("2026-10-23T22:00:00Z");
function binding(sessionId = "session-a", actorUserId = "owner"): BrowserSessionBinding {
  return { actorUserId, sessionId, requestId: "test", expiresAt: new Date(instant + 60_000) };
}
function fixture() {
  let now = instant;
  const assertLive = vi.fn<SessionBindingsService["assertLive"]>(async () => {});
  const deps = { ownerUserId: "owner", sessions: { assertLive }, now: () => new Date(now) };
  const control = new ComputerInputControl(deps);
  return { control, deps, assertLive, expire: () => (now = instant + 60_000) };
}
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("Computer local input authority (no remote transport claim)", () => {
  it("starts paused and watching neither seizes nor resumes input", async () => {
    const { control } = fixture();
    const viewer = await control.connect(binding());
    expect(control.snapshot()).toEqual({ mode: "paused", viewerCount: 1 });
    expect(() => control.acquireAgentLease("owner")).toThrow(ComputerInputDenied);
    const send = vi.fn(() => undefined);
    await expect(control.dispatchOwner(viewer, send)).rejects.toThrow(ComputerInputDenied);
    await control.returnToMoss(viewer);
    await control.connect(binding("session-b"));
    expect(control.snapshot()).toEqual({ mode: "moss", viewerCount: 2 });
    await control.dispatchAgent(control.acquireAgentLease("owner"), send);
    expect(send).toHaveBeenCalledOnce();
  });

  it("permits only the controlling viewer; a second viewer cannot steal or return control", async () => {
    const { control } = fixture();
    const first = await control.connect(binding());
    const second = await control.connect(binding("session-b"));
    await control.takeOver(first);
    await control.takeOver(first);
    const send = vi.fn(() => undefined);
    await control.dispatchOwner(first, send);
    await expect(control.takeOver(second)).rejects.toThrow(ComputerInputDenied);
    await expect(control.returnToMoss(second)).rejects.toThrow(ComputerInputDenied);
    await expect(control.dispatchOwner(second, send)).rejects.toThrow(ComputerInputDenied);
    expect(send).toHaveBeenCalledOnce();
  });

  it("fences agent input after takeover and keeps old leases invalid after explicit return", async () => {
    const { control } = fixture();
    const viewer = await control.connect(binding());
    await control.returnToMoss(viewer);
    const oldLease = control.acquireAgentLease("owner");
    await control.takeOver(viewer);
    const send = vi.fn(() => undefined);
    await expect(control.dispatchAgent(oldLease, send)).rejects.toThrow(ComputerInputDenied);
    await control.returnToMoss(viewer);
    await expect(control.dispatchAgent(oldLease, send)).rejects.toThrow(ComputerInputDenied);
    await control.dispatchAgent(control.acquireAgentLease("owner"), send);
    expect(send).toHaveBeenCalledOnce();
  });

  it("checks the actual grant session at every agent dispatch, including after viewer disconnect", async () => {
    const { control, assertLive } = fixture();
    const viewer = await control.connect(binding());
    await control.returnToMoss(viewer);
    const lease = control.acquireAgentLease("owner");
    control.disconnect(viewer);
    const send = vi.fn(() => undefined);
    await control.dispatchAgent(lease, send);
    await control.dispatchAgent(lease, send);
    expect(assertLive).toHaveBeenLastCalledWith({ actorUserId: "owner", sessionId: "session-a" });
    expect(assertLive).toHaveBeenCalledTimes(4);
    assertLive.mockRejectedValueOnce(new Error("session revoked"));
    await expect(control.dispatchAgent(lease, send)).rejects.toThrow("session revoked");
    expect(control.snapshot().mode).toBe("paused");
    expect(send).toHaveBeenCalledTimes(2);
    await expect(control.dispatchAgent(lease, send)).rejects.toThrow(ComputerInputDenied);
  });

  it("pauses on controller disconnect; reconnect requires an explicit choice and fresh leases", async () => {
    const { control } = fixture();
    const first = await control.connect(binding());
    await control.takeOver(first);
    control.disconnect(first);
    const second = await control.connect(binding());
    expect(control.snapshot().mode).toBe("paused");
    const send = vi.fn(() => undefined);
    await expect(control.dispatchOwner(first, send)).rejects.toThrow(ComputerInputDenied);
    await expect(control.dispatchOwner(second, send)).rejects.toThrow(ComputerInputDenied);
    await control.takeOver(second);
    await control.dispatchOwner(second, send);
    expect(send).toHaveBeenCalledOnce();
  });

  it("closing an unrelated watcher preserves owner control", async () => {
    const { control } = fixture();
    const owner = await control.connect(binding());
    const watcher = await control.connect(binding("session-b"));
    await control.takeOver(owner);
    control.disconnect(watcher);
    const send = vi.fn(() => undefined);
    await control.dispatchOwner(owner, send);
    expect(send).toHaveBeenCalledOnce();
  });

  it("rejects foreign owner/admin-equivalent actors and expired bindings before a live lookup", async () => {
    const { control, assertLive, expire } = fixture();
    await expect(control.connect(binding("foreign", "admin"))).rejects.toThrow(ComputerInputDenied);
    expect(assertLive).not.toHaveBeenCalled();
    expire();
    await expect(control.connect(binding())).rejects.toThrow(ComputerInputDenied);
    expect(assertLive).not.toHaveBeenCalled();
  });

  it("does not retain a caller-mutable Date or session object", async () => {
    const { control, assertLive } = fixture();
    const original = binding();
    const viewer = await control.connect(original);
    original.expiresAt.setTime(0);
    await control.takeOver(viewer);
    expect(assertLive).toHaveBeenLastCalledWith({ actorUserId: "owner", sessionId: "session-a" });
  });

  it("rejects expiry that occurs during authorization", async () => {
    const { control, assertLive, expire } = fixture();
    const viewer = await control.connect(binding());
    await control.returnToMoss(viewer);
    const pending = deferred();
    assertLive.mockReturnValueOnce(pending.promise);
    const send = vi.fn(() => undefined);
    const dispatch = control.dispatchAgent(control.acquireAgentLease("owner"), send);
    expire();
    pending.resolve();
    await expect(dispatch).rejects.toThrow(ComputerInputDenied);
    expect(control.snapshot().mode).toBe("paused");
    expect(send).not.toHaveBeenCalled();
  });

  it("never commits pending agent authorization across a takeover", async () => {
    const { control, assertLive } = fixture();
    const viewer = await control.connect(binding());
    await control.returnToMoss(viewer);
    const pending = deferred();
    assertLive.mockReturnValueOnce(pending.promise);
    const send = vi.fn(() => undefined);
    const dispatch = control.dispatchAgent(control.acquireAgentLease("owner"), send);
    await control.takeOver(viewer);
    pending.resolve();
    await expect(dispatch).rejects.toThrow(ComputerInputDenied);
    expect(send).not.toHaveBeenCalled();
    expect(control.snapshot().mode).toBe("owner");
  });

  it("does not let delayed revoked-agent authorization pause a newer unrelated grant", async () => {
    const { control, assertLive } = fixture();
    const first = await control.connect(binding());
    const second = await control.connect(binding("session-b"));
    await control.returnToMoss(first);
    const pending = deferred();
    assertLive.mockReturnValueOnce(pending.promise);
    const send = vi.fn(() => undefined);
    const dispatch = control.dispatchAgent(control.acquireAgentLease("owner"), send);
    await control.takeOver(second);
    await control.returnToMoss(second);
    pending.reject(new Error("old grant revoked"));
    await expect(dispatch).rejects.toThrow("old grant revoked");
    expect(control.snapshot().mode).toBe("moss");
    await control.dispatchAgent(control.acquireAgentLease("owner"), send);
    expect(send).toHaveBeenCalledOnce();
  });

  it("fences delayed owner input and delayed return across disconnect and takeover", async () => {
    const { control, assertLive } = fixture();
    const first = await control.connect(binding());
    const second = await control.connect(binding("session-b"));
    await control.takeOver(first);
    const inputCheck = deferred();
    const returnCheck = deferred();
    assertLive.mockReturnValueOnce(inputCheck.promise).mockReturnValueOnce(returnCheck.promise);
    const send = vi.fn(() => undefined);
    const input = control.dispatchOwner(first, send);
    const returning = control.returnToMoss(first);
    control.disconnect(first);
    await control.takeOver(second);
    inputCheck.resolve();
    returnCheck.resolve();
    await expect(input).rejects.toThrow(ComputerInputDenied);
    await expect(returning).rejects.toThrow(ComputerInputDenied);
    expect(control.snapshot().mode).toBe("owner");
    expect(send).not.toHaveBeenCalled();
  });

  it("only admits one of two concurrent takeovers", async () => {
    const { control, assertLive } = fixture();
    const first = await control.connect(binding());
    const second = await control.connect(binding("session-b"));
    const a = deferred();
    const b = deferred();
    assertLive.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const firstTakeover = control.takeOver(first);
    const secondTakeover = control.takeOver(second);
    b.resolve();
    await secondTakeover;
    a.resolve();
    await expect(firstTakeover).rejects.toThrow(ComputerInputDenied);
  });

  it("session invalidation pauses both owner control and the agent grant; other sessions survive", async () => {
    const { control } = fixture();
    const first = await control.connect(binding());
    const second = await control.connect(binding("session-b"));
    await control.takeOver(first);
    control.invalidateSession("session-a");
    expect(control.snapshot()).toEqual({ mode: "paused", viewerCount: 1 });
    await control.returnToMoss(second);
    const lease = control.acquireAgentLease("owner");
    control.invalidateSession("session-a");
    const send = vi.fn(() => undefined);
    await control.dispatchAgent(lease, send);
    control.invalidateSession("session-b");
    await expect(control.dispatchAgent(lease, send)).rejects.toThrow(ComputerInputDenied);
  });

  it("rejects capabilities from a prior controller instance, even at the same generation", async () => {
    const { control, deps } = fixture();
    const first = await control.connect(binding());
    await control.returnToMoss(first);
    const lease = control.acquireAgentLease("owner");
    const restarted = new ComputerInputControl(deps);
    const second = await restarted.connect(binding());
    await restarted.returnToMoss(second);
    const send = vi.fn(() => undefined);
    await expect(restarted.takeOver(first)).rejects.toThrow(ComputerInputDenied);
    await expect(restarted.dispatchAgent(lease, send)).rejects.toThrow(ComputerInputDenied);
    expect(() => restarted.acquireAgentLease("foreign")).toThrow(ComputerInputDenied);
    expect(send).not.toHaveBeenCalled();
  });

  it("closing during authorization rejects new viewers, leases and pending dispatch", async () => {
    const { control, assertLive } = fixture();
    const viewer = await control.connect(binding());
    await control.takeOver(viewer);
    const check = deferred();
    const connectCheck = deferred();
    assertLive.mockReturnValueOnce(check.promise).mockReturnValueOnce(connectCheck.promise);
    const send = vi.fn(() => undefined);
    const input = control.dispatchOwner(viewer, send);
    const connecting = control.connect(binding("session-b"));
    control.close();
    check.resolve();
    connectCheck.resolve();
    await expect(input).rejects.toThrow(ComputerInputDenied);
    await expect(connecting).rejects.toThrow(ComputerInputDenied);
    expect(control.snapshot()).toEqual({ mode: "paused", viewerCount: 0 });
    expect(() => control.acquireAgentLease("owner")).toThrow(ComputerInputDenied);
    expect(send).not.toHaveBeenCalled();
  });

  it("propagates writer failures without replaying input", async () => {
    const { control } = fixture();
    const viewer = await control.connect(binding());
    await control.takeOver(viewer);
    const send = vi.fn(() => {
      throw new Error("writer failed");
    });
    await expect(control.dispatchOwner(viewer, send)).rejects.toThrow("writer failed");
    expect(send).toHaveBeenCalledOnce();
  });
});
