// @vitest-environment jsdom
import "./helpers/install-module-runtime";
import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer, type ReactTestInstance } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExternalModuleToolsHandleV1 } from "@moss/module-web-sdk";
import { useTransactionNoteEditor } from "../../external-modules/finance/src/web/transaction-note-editor";
import {
  __resetStoreForTests,
  setToolQueryResult,
  useToolQuery
} from "../../external-modules/finance/src/web/store";
const roots = new Set<ReactTestRenderer>();
async function mount(component: () => ReturnType<typeof createElement>) {
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(createElement(component));
  });
  roots.add(root);
  return root;
}
async function unmount(root: ReactTestRenderer) {
  await act(async () => root.unmount());
  roots.delete(root);
}
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots.clear();
  __resetStoreForTests();
  vi.unstubAllGlobals();
});
function CachedReaders() {
  const budget = useToolQuery<{ value: string }>("finance.budget.status"),
    activity = useToolQuery<{ value: string }>("finance.activity.list");
  const value = (s: typeof budget) =>
    s.status === "settled" && s.outcome.kind === "ok" ? s.outcome.result.value : "loading";
  return createElement("output", {}, `${value(budget)}|${value(activity)}`);
}
describe("note saves and captured Finance read caches", () => {
  it("publishes an explicit bill read immediately and fences a prior delayed cache response", async () => {
    __resetStoreForTests();
    let finish!: () => void;
    const fetch = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({
              ok: true,
              status: 200,
              json: async () => ({
                invocation: {
                  status: "succeeded",
                  result: { value: "old" }
                }
              })
            });
        })
    );
    vi.stubGlobal("fetch", fetch);
    const scope = { from: "2026-10-01", to: "2026-10-31" };
    function Bill() {
      const snapshot = useToolQuery<{ value: string }>("finance.bills.read", scope);
      return createElement(
        "output",
        {},
        snapshot.status === "settled" && snapshot.outcome.kind === "ok"
          ? snapshot.outcome.result.value
          : "loading"
      );
    }
    const view = await mount(Bill);
    expect(view.root.findByType("output").children).toEqual(["loading"]);
    await act(async () => {
      setToolQueryResult("finance.bills.read", scope, { value: "fresh" });
    });
    expect(view.root.findByType("output").children).toEqual(["fresh"]);
    await act(async () => {
      finish();
    });
    expect(view.root.findByType("output").children).toEqual(["fresh"]);
    await unmount(view);
    const reopened = await mount(Bill);
    expect(reopened.root.findByType("output").children).toEqual(["fresh"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("refreshes an inactive budget fingerprint and activity list after note-only persistence", async () => {
    __resetStoreForTests();
    let current = "before";
    const counts = new Map<string, number>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const name = decodeURIComponent(url.split("/").at(-2)!);
        counts.set(name, (counts.get(name) ?? 0) + 1);
        const result =
          name === "finance.transaction.note-read"
            ? {
                available: true,
                transactionId: "synthetic:note",
                accountId: "synthetic:account",
                month: "2026-10",
                date: "2026-10-01",
                name: "Synthetic purchase",
                notes: "Old note",
                writeRevision: "1".repeat(32)
              }
            : { value: current };
        return {
          ok: true,
          status: 200,
          json: async () => ({ invocation: { status: "succeeded", result } })
        };
      })
    );
    const before = await mount(CachedReaders);
    expect(before.root.findByType("output").children).toEqual(["before|before"]);
    await unmount(before);
    const tools = {
      invoke: vi.fn(async () => {
        // SQL note edits change transaction xmin, which participates in budget review fingerprints.
        current = "after";
        return { status: "succeeded", result: { status: "ok" } };
      })
    } as unknown as ExternalModuleToolsHandleV1;
    function Editor() {
      const editor = useTransactionNoteEditor({
        tools,
        target: {
          transactionId: "synthetic:note",
          accountId: "synthetic:account",
          month: "2026-10"
        },
        onSaved: () => {}
      });
      return createElement(
        "div",
        {},
        createElement("button", { onClick: editor.start }, "Edit"),
        editor.editing
          ? createElement("section", {}, editor.body as ReactNode, editor.footer as ReactNode)
          : null
      );
    }
    const editor = await mount(Editor);
    const text = (node: ReactTestInstance): string =>
      node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");
    const button = (label: string) =>
      editor.root.findAllByType("button").find((n) => text(n) === label)!;
    await act(async () => {
      button("Edit").props.onClick();
    });
    await act(async () => {
      editor.root.findByType("textarea").props.onChange({ currentTarget: { value: "New note" } });
    });
    await act(async () => {
      button("Save private note").props.onClick();
    });
    await unmount(editor);
    const after = await mount(CachedReaders);
    expect(after.root.findByType("output").children).toEqual(["after|after"]);
    expect(counts.get("finance.budget.status")).toBe(2);
    expect(counts.get("finance.activity.list")).toBe(2);
  });
});
