import { describe, expect, it } from "vitest";
import { orderedTeardown, type TeardownSteps } from "./n3-teardown.js";

const clean = { completed: [], failure: null, open: false };

function steps(overrides: Partial<TeardownSteps> = {}) {
  const events: string[] = [];
  const base: TeardownSteps = {
    project: "uat-1_aaaaaaaa",
    stopWindows: async () => {
      events.push("windows");
      return clean;
    },
    closeObserver: async () => {
      events.push("observer");
      return { disposed: true };
    },
    removeStack: async () => {
      events.push("credentials");
      events.push("volumes");
    },
    listOwned: async () => {
      events.push("inventory");
      return { containers: ["c"], volumes: ["v"], networks: [] };
    },
    beforeStep: () => {}
  };
  return { events, steps: { ...base, ...overrides } };
}

describe("N3 ordered teardown", () => {
  it("stops windows, closes the observer, then removes credentials before volumes", async () => {
    const t = steps();
    const report = await orderedTeardown(t.steps);
    expect(t.events).toEqual(["windows", "observer", "credentials", "volumes"]);
    expect(report).toMatchObject({ errors: 0, retained: false, left: undefined });
    expect(report.ran).toEqual(["windows", "observer", "stack"]);
  });

  it("keeps the stack and lists what remains when a window is still open", async () => {
    const t = steps({
      stopWindows: async () => ({ ...clean, open: true }),
      closeObserver: async () => ({ disposed: false })
    });
    const report = await orderedTeardown(t.steps);
    expect(t.events).not.toContain("credentials");
    expect(report.retained).toBe(true);
    expect(report.errors).toBe(2);
    expect(report.left).toEqual({ containers: ["c"], volumes: ["v"], networks: [] });
  });

  it("keeps the stack when the observer will not close even though windows were clean", async () => {
    const t = steps({ closeObserver: async () => ({ disposed: false }) });
    const report = await orderedTeardown(t.steps);
    expect(t.events).toEqual(["windows", "inventory"]);
    expect(report).toMatchObject({ retained: true, errors: 1 });
  });

  it("keeps the stack when a window reported a failure", async () => {
    const t = steps({ stopWindows: async () => ({ ...clean, failure: "window 1 ack: boom" }) });
    const report = await orderedTeardown(t.steps);
    expect(t.events).not.toContain("credentials");
    expect(report.retained).toBe(true);
    expect(report.reasons.join(" ")).not.toContain("boom");
  });

  it("keeps everything once the cleanup deadline has passed", async () => {
    const t = steps({
      beforeStep: () => {
        throw new Error("aggregate protocol deadline exhausted");
      }
    });
    const report = await orderedTeardown(t.steps);
    expect(t.events).toEqual(["inventory"]);
    expect(report.retained).toBe(true);
    expect(report.errors).toBeGreaterThanOrEqual(2);
  });

  it("reports a failed stack removal as retained with an inventory", async () => {
    const t = steps({
      removeStack: async () => {
        throw new Error("down failed");
      }
    });
    const report = await orderedTeardown(t.steps);
    expect(report).toMatchObject({ retained: true, errors: 1 });
    expect(report.left?.volumes).toEqual(["v"]);
  });

  it("marks the run red when the inventory itself cannot be read", async () => {
    const t = steps({
      closeObserver: async () => ({ disposed: false }),
      listOwned: async () => {
        throw new Error("docker down");
      }
    });
    const report = await orderedTeardown(t.steps);
    expect(report.left).toBeUndefined();
    expect(report.errors).toBe(2);
  });

  it("treats a run that never opened the observer as nothing to close", async () => {
    const t = steps({ stopWindows: async () => undefined, closeObserver: async () => undefined });
    const report = await orderedTeardown(t.steps);
    expect(report).toMatchObject({ errors: 0, retained: false });
  });
});
