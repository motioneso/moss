import type { ModuleDto, TranscriptRecord } from "@moss/shared";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import {
  actionRefreshQueryKeys,
  useActionQueryRefresh
} from "../../apps/web/src/chat/use-action-query-refresh.js";

const modules: readonly ModuleDto[] = [
  {
    id: "jarvis.goals",
    name: "Goals",
    version: "1",
    lifecycle: "optional",
    navigation: [],
    settings: [],
    chatRefreshTokens: ["goals.list", "missing.key", "constructor.prototype"]
  }
];
const result: TranscriptRecord = {
  kind: "action_result",
  text: "Updated",
  outcome: "executed",
  actionRequestId: "action-1",
  affectsModules: ["jarvis.goals", "news", "news"],
  affectsQueryKeys: ["settings.themes", "goals.list"]
};

describe("action query refresh", () => {
  it("combines module prefixes and resolvable tokens and deduplicates keys", () => {
    expect(actionRefreshQueryKeys(result, modules)).toEqual([
      ["jarvis.goals"],
      ["news"],
      ["settings", "themes"],
      ["goals", "list"]
    ]);
  });

  it.each(["denied", "error", "allowed"] as const)("does not refresh a %s outcome", (outcome) => {
    expect(actionRefreshQueryKeys({ ...result, outcome }, modules)).toEqual([]);
  });

  it("ignores declarations on non-results and invalid tokens without broadening scope", () => {
    expect(actionRefreshQueryKeys({ ...result, kind: "reply" }, modules)).toEqual([]);
    expect(
      actionRefreshQueryKeys(
        { ...result, affectsModules: [""], affectsQueryKeys: ["missing", "ai.capability"] },
        []
      )
    ).toEqual([]);
  });

  it("the live effect invalidates only matching first-segment modules and tokens, once", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const matching = [
      ["news", "overview"],
      ["news", "story", "1"],
      ["goals", "list"],
      ["settings", "themes"]
    ];
    const unrelated = [
      ["news-archive", "overview"],
      ["other", "news"],
      ["settings", "locale"]
    ];
    for (const key of [...matching, ...unrelated]) client.setQueryData(key, "cached");
    const invalidate = vi.spyOn(client, "invalidateQueries");
    function Probe({
      records,
      loading = false
    }: {
      records: readonly TranscriptRecord[];
      loading?: boolean;
    }) {
      useActionQueryRefresh(records, modules, loading);
      return null;
    }
    const tree = (records: readonly TranscriptRecord[], loading = false) =>
      createElement(QueryClientProvider, { client }, createElement(Probe, { records, loading }));
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(tree([result], true));
    });
    expect(invalidate).not.toHaveBeenCalled();
    await act(async () => {
      renderer.update(tree([result]));
    });
    for (const key of matching)
      expect(client.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(true);
    for (const key of unrelated)
      expect(client.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(false);
    expect(invalidate).toHaveBeenCalledTimes(4);
    await act(async () => {
      renderer.update(tree([{ ...result }, { kind: "reply", text: "Done" }]));
    });
    expect(invalidate).toHaveBeenCalledTimes(4);
    await act(async () => {
      renderer.unmount();
    });
    client.clear();
  });
  it("refetches a cold in-flight read after an executed action", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const queryKey = ["settings", "themes"];
    let release!: () => void;
    const initialResponse = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const options = {
      queryKey,
      queryFn: async () => {
        calls += 1;
        if (calls === 1) {
          await initialResponse;
          return "light";
        }
        return "dark";
      }
    };
    const firstRead = client.fetchQuery(options).catch(() => undefined);
    const observer = new QueryObserver(client, options);
    const unsubscribe = observer.subscribe(() => undefined);
    function Probe() {
      useActionQueryRefresh([{ ...result, affectsModules: [] }], [], false);
      return null;
    }
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => {
        renderer = create(createElement(QueryClientProvider, { client }, createElement(Probe)));
      });
      await act(async () => {
        release();
        await firstRead;
      });
      expect(client.getQueryData(queryKey)).toBe("dark");
      expect(calls).toBe(2);
    } finally {
      release();
      await act(async () => {
        renderer?.unmount();
      });
      unsubscribe();
      client.clear();
    }
  });
});
