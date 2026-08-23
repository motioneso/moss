import { describe, it, expect, vi } from "vitest";

import {
  TASK_CHANGES_POLICY_KEY,
  TasksCompatibilityHelper
} from "../../packages/tasks/src/action-policy.js";
import type { DataContextDb, PreferencesPort } from "@moss/db";

function makePrefs(): PreferencesPort {
  return {
    get: vi.fn(),
    getWithMetadata: vi.fn(),
    upsert: vi.fn()
  } satisfies PreferencesPort;
}

const db = {} as DataContextDb;

describe("tasks action policy fallback (#1339-C degrade a failed heal closed)", () => {
  it("a rejected install-grant attempt resolves to ask_each_time, not a rejected promise", async () => {
    const prefs = makePrefs();
    vi.mocked(prefs.getWithMetadata).mockResolvedValue(null);
    const helper = new TasksCompatibilityHelper(prefs);
    vi.spyOn(helper, "grantInstallTimeTrustIfUnset").mockRejectedValue(new Error("insert failed"));

    await expect(helper.getResolvedTaskChangesPolicy(db)).resolves.toBe("ask_each_time");
  });

  it("the insertion is attempted exactly once; no retry", async () => {
    const prefs = makePrefs();
    vi.mocked(prefs.getWithMetadata).mockResolvedValue(null);
    const helper = new TasksCompatibilityHelper(prefs);
    const grantSpy = vi
      .spyOn(helper, "grantInstallTimeTrustIfUnset")
      .mockRejectedValue(new Error("insert failed"));

    await helper.getResolvedTaskChangesPolicy(db);

    expect(grantSpy).toHaveBeenCalledTimes(1);
  });

  it("a rejected attempt never reaches the canonical reread", async () => {
    const prefs = makePrefs();
    const getWithMetadata = vi.mocked(prefs.getWithMetadata).mockResolvedValue(null);
    const helper = new TasksCompatibilityHelper(prefs);
    vi.spyOn(helper, "grantInstallTimeTrustIfUnset").mockRejectedValue(new Error("insert failed"));

    await helper.getResolvedTaskChangesPolicy(db);

    // Only the two initial probe reads (canonical, legacy) from getResolvedTaskChangesPolicy —
    // no third read from inside healInstallGrantAndReread after the rejection.
    expect(getWithMetadata).toHaveBeenCalledTimes(2);
  });

  it("the existing success path is unchanged: reread still runs and returns the stored tier", async () => {
    const prefs = makePrefs();
    const getWithMetadata = vi
      .mocked(prefs.getWithMetadata)
      .mockResolvedValueOnce(null) // canonical probe
      .mockResolvedValueOnce(null) // legacy probe
      .mockResolvedValueOnce({ value: "trusted_auto", updatedAt: new Date() }); // post-insert reread
    const helper = new TasksCompatibilityHelper(prefs);
    vi.spyOn(helper, "grantInstallTimeTrustIfUnset").mockResolvedValue(undefined);

    const tier = await helper.getResolvedTaskChangesPolicy(db);

    expect(tier).toBe("trusted_auto");
    expect(getWithMetadata).toHaveBeenCalledTimes(3);
    expect(getWithMetadata).toHaveBeenLastCalledWith(db, TASK_CHANGES_POLICY_KEY);
  });
});
