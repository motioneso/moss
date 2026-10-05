import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  setSessionUnsavedChanges,
  hasSessionUnsavedChanges,
  clearSessionUnsavedChanges
} from "@moss/module-web-sdk";
import { useSignOutGuard } from "../../apps/web/src/shell/use-sign-out-guard.js";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
});

describe("session unsaved changes and sign-out", () => {
  it("keeps only boolean markers across navigation and clears them with the session", () => {
    const client = new QueryClient();
    setSessionUnsavedChanges(client, "meetings:one:notes", true);
    expect(hasSessionUnsavedChanges(client)).toBe(true);
    expect(
      client
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data)
    ).toEqual([true]);
    expect(client.getQueryDefaults(["session-unsaved-changes"]).gcTime).toBe(Infinity);
    client.clear();
    expect(hasSessionUnsavedChanges(client)).toBe(false);
  });
  it("clears only the removed resource's markers", () => {
    const client = new QueryClient();
    setSessionUnsavedChanges(client, "meetings:one:notes", true);
    setSessionUnsavedChanges(client, "meetings:two:output:1", true);
    clearSessionUnsavedChanges(client, "meetings:one:");
    expect(hasSessionUnsavedChanges(client)).toBe(true);
    setSessionUnsavedChanges(client, "meetings:two:output:1", false);
    expect(hasSessionUnsavedChanges(client)).toBe(false);
    client.clear();
  });
  it("preserves edits on cancel and requires explicit confirmation before sign-out", async () => {
    const client = new QueryClient();
    const signOut = vi.fn();
    let guard!: ReturnType<typeof useSignOutGuard>;
    function Probe() {
      guard = useSignOutGuard(client, signOut);
      return null;
    }
    await act(async () => {
      renderer = create(<Probe />);
    });
    setSessionUnsavedChanges(client, "meetings:one:notes", true);
    await act(async () => guard.request());
    expect(guard.confirming).toBe(true);
    expect(signOut).not.toHaveBeenCalled();
    await act(async () => guard.cancel());
    expect(guard.confirming).toBe(false);
    expect(hasSessionUnsavedChanges(client)).toBe(true);
    expect(signOut).not.toHaveBeenCalled();
    await act(async () => guard.request());
    await act(async () => {
      guard.confirm();
      guard.confirm();
    });
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(guard.confirming).toBe(false);
    client.clear();
  });
  it("does not prompt after edits were saved", async () => {
    const client = new QueryClient();
    const signOut = vi.fn();
    let guard!: ReturnType<typeof useSignOutGuard>;
    function Probe() {
      guard = useSignOutGuard(client, signOut);
      return null;
    }
    await act(async () => {
      renderer = create(<Probe />);
    });
    setSessionUnsavedChanges(client, "meetings:one:notes", true);
    setSessionUnsavedChanges(client, "meetings:one:notes", false);
    await act(async () => guard.request());
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(guard.confirming).toBe(false);
    client.clear();
  });
});
