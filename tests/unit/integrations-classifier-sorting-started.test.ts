import { describe, expect, it, vi } from "vitest";

import {
  CLASSIFIER_ATTEMPT_LIVE_MS,
  classifierSortView,
  emptySortMap,
  toolRiskInputs,
  toolSortFingerprint,
  withSortResult,
  type ConnectionRow,
  type PreparationStructuredOutcome
} from "@moss/integrations";

import {
  connection,
  entry,
  harness,
  throughRouter,
  tool
} from "./helpers/integrations-classifier-sorting-harness.js";

/*
 * A sorting call that has started (#2984 R2.5b): no run sends its tools again, and no late save
 * from an older run puts them back where an automatic run would.
 */

describe("a sorting call that started", () => {
  const failedAt = "2026-10-03T00:00:00.000Z";

  /** One tool whose sort failed for want of a model, so a model being added resends it. */
  function noModelRow(): ConnectionRow {
    const lamp = tool("a");
    const sort = withSortResult(emptySortMap(), lamp.name, {
      status: "failed",
      failure: "no_model",
      sortFingerprint: toolSortFingerprint(toolRiskInputs(lamp)),
      sortedAt: failedAt
    })!;
    return connection([lamp], { classifierSort: sort });
  }

  function abortError(): Error {
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    return error;
  }

  it("is not resent by a model being added after the provider call was cut off", async () => {
    const h = harness(noModelRow(), {
      answer: (_ids, input) =>
        throughRouter(input, () => {
          throw abortError();
        })
    });
    expect(await h.run("model_ready")).toMatchObject({ status: "stopped" });
    expect(await h.run("model_ready")).toEqual({ status: "nothing_to_sort" });
    expect(h.runs).toHaveLength(1);
    expect(entry(h.state, "a")).toMatchObject({ status: "failed", failure: "interrupted" });
  });

  it("is not resent when its results could not be saved", async () => {
    let saveFails = true;
    const h = harness(noModelRow(), { resultSaveFails: () => saveFails });
    await expect(h.run("model_ready")).rejects.toThrow("connection lost");
    saveFails = false;
    await h.run("model_ready");
    expect(h.runs).toHaveLength(1);
  });

  it("keeps a run that starts meanwhile from sending the same tool", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const h = harness(noModelRow(), {
      answer: async (ids) => {
        if (h.runs.length === 1) await held;
        return {
          ok: true,
          object: { tools: ids.map((id) => ({ id, group: "reads_things", name: "Lamp" })) },
          usage: { inputTokens: 1, outputTokens: 1 }
        };
      }
    });
    const retry = h.run("retry");
    await vi.waitFor(() => expect(h.runs).toHaveLength(1));
    expect(await h.run("model_ready")).toEqual({ status: "nothing_to_sort" });
    expect(await h.run("retry")).toEqual({ status: "nothing_to_sort" });
    release();
    await retry;
    expect(h.runs).toHaveLength(1);
    expect(entry(h.state, "a")).toMatchObject({ status: "current" });
  });

  // The reviewer's order: an older run reads its targets, then waits on model selection while a
  // newer run claims the tool and reaches the provider. The older run's no-model write must not
  // put the tool back where a model being added would send it again.
  it.each([
    ["was cut off", () => ({ ok: false, error: "aborted" }) as const, "interrupted"],
    ["was sorted", undefined, "current"]
  ] as const)(
    "keeps an older run's no-model write off a tool whose call %s",
    async (_case, answer, after) => {
      let olderSelect = (_found: boolean) => {};
      const olderSelection = new Promise<boolean>((resolve) => (olderSelect = resolve));
      const selections: Promise<boolean>[] = [olderSelection];
      const h = harness(noModelRow(), {
        select: () => selections.shift() ?? Promise.resolve(true),
        ...(answer ? { answer } : {})
      });

      const older = h.run("retry");
      await vi.waitFor(() => expect(selections).toHaveLength(0));
      await h.run("model_ready");
      expect(h.runs).toHaveLength(1);
      olderSelect(false);
      expect(await older).toEqual({ status: "no_model" });

      expect(entry(h.state, "a")).toMatchObject({
        status: after === "current" ? "current" : "failed"
      });
      if (after === "interrupted")
        expect(entry(h.state, "a")).toMatchObject({ failure: "interrupted" });
      expect(await h.run("model_ready")).toEqual({ status: "nothing_to_sort" });
      expect(h.runs).toHaveLength(1);
    }
  );

  // The same orders with a discovery refresh in the wait. The older run's save is for the old
  // definition, so it must not displace the newer run's call for the new one.
  const changed = () => tool("a", { description: "Does a, now differently" });
  const sortedAnswer = (ids: string[]): PreparationStructuredOutcome => ({
    ok: true,
    object: { tools: ids.map((id) => ({ id, group: "reads_things", name: "Lamp" })) },
    usage: { inputTokens: 1, outputTokens: 1 }
  });

  it.each([
    ["was cut off", false],
    ["was sorted", true]
  ] as const)(
    "keeps an older run's no-model write for an old definition off a call that %s",
    async (_case, newerSorts) => {
      let olderSelect = (_found: boolean) => {};
      const olderSelection = new Promise<boolean>((resolve) => (olderSelect = resolve));
      const selections: Promise<boolean>[] = [olderSelection];
      const h = harness(noModelRow(), {
        select: () => selections.shift() ?? Promise.resolve(true),
        answer: (ids) => (newerSorts ? sortedAnswer(ids) : { ok: false, error: "aborted" })
      });

      const older = h.run("retry");
      await vi.waitFor(() => expect(selections).toHaveLength(0));
      h.state.row = { ...h.state.row, discoveredTools: [changed()] };
      await h.run("model_ready");
      expect(h.runs).toHaveLength(1);
      olderSelect(false);
      expect(await older).toEqual({ status: "no_model" });

      expect(await h.run("model_ready")).toEqual({ status: "nothing_to_sort" });
      expect(h.runs).toHaveLength(1);
    }
  );

  it.each([
    ["was cut off", false],
    ["was sorted", true]
  ] as const)(
    "keeps a late result for an old definition off a newer call that %s",
    async (_case, newerSorts) => {
      let release = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      const h = harness(noModelRow(), {
        answer: async (ids) => {
          if (h.runs.length === 1) {
            await held;
            return sortedAnswer(ids);
          }
          return newerSorts ? sortedAnswer(ids) : { ok: false, error: "aborted" };
        }
      });

      const older = h.run("model_ready");
      await vi.waitFor(() => expect(h.runs).toHaveLength(1));
      h.state.row = { ...h.state.row, discoveredTools: [changed()] };
      await h.run("model_ready");
      expect(h.runs).toHaveLength(2);
      release();
      await older;

      expect(await h.run("model_ready")).toEqual({ status: "nothing_to_sort" });
      expect(h.runs).toHaveLength(2);
    }
  );

  it("shows as waiting while it may run, then as a failure only Try again resends", async () => {
    const h = harness(noModelRow(), { answer: () => ({ ok: false, error: "aborted" }) });
    const started = new Date("2026-10-04T00:00:00.000Z");
    await h.run("model_ready", started);
    const marked = entry(h.state, "a")!;
    expect(marked).toMatchObject({ failure: "interrupted", sortedAt: started.toISOString() });

    const running = new Date(started.getTime() + CLASSIFIER_ATTEMPT_LIVE_MS - 1);
    expect(classifierSortView(h.state.row, { now: running })[0]).toMatchObject({
      status: "never_tried",
      failure: null,
      failedAt: null
    });
    expect(await h.run("retry", running)).toEqual({ status: "nothing_to_sort" });

    const over = new Date(started.getTime() + CLASSIFIER_ATTEMPT_LIVE_MS);
    expect(classifierSortView(h.state.row, { now: over })[0]).toMatchObject({
      status: "failed",
      failure: "error"
    });
    expect(await h.run("model_ready", over)).toEqual({ status: "nothing_to_sort" });
    expect(await h.run("sort", over)).toEqual({ status: "nothing_to_sort" });
    await h.run("retry", over);
    expect(h.runs).toHaveLength(2);
  });
});
