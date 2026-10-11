// @vitest-environment jsdom
// #3217 WEB-11: a therapy note that fails to save stays in the box and shows an error.
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

const createTherapyNoteMock = vi.fn();

vi.mock("../../apps/web/src/api/client", () => ({
  listTherapyNotes: async () => ({ notes: [] }),
  createTherapyNote: (input: { body: string }) => createTherapyNoteMock(input),
  deleteTherapyNote: async () => undefined
}));

vi.mock("../../apps/web/src/locale/locale-format", () => ({
  useUserLocale: () => ({}),
  formatDate: () => ""
}));

import { WellnessTherapyNotes } from "../../apps/web/src/wellness/wellness-therapy-notes.js";

function textOf(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textOf).join("");
  return textOf((node as { children?: unknown }).children);
}

async function addNote(save: () => Promise<unknown>) {
  createTherapyNoteMock.mockImplementation(save);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      createElement(QueryClientProvider, { client }, createElement(WellnessTherapyNotes))
    );
  });
  const box = tree.root.findByType("textarea");
  await act(async () => {
    box.props.onChange({ target: { value: "bring up sleep" } });
  });
  const add = tree.root.findAll((n) => n.type === "button" && textOf(n.children) === "Add")[0]!;
  await act(async () => {
    add.props.onClick();
  });
  return tree;
}

// React Query settles the mutation on a later tick, so poll until the expectation holds.
async function settle(check: () => void) {
  for (let attempt = 0; ; attempt++) {
    try {
      check();
      return;
    } catch (error) {
      if (attempt >= 50) throw error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  }
}

describe("therapy note save failure", () => {
  it("keeps the text in the box and shows an error when the save fails", async () => {
    const tree = await addNote(() => Promise.reject(new Error("boom")));
    await settle(() => expect(textOf(tree.toJSON())).toContain("Couldn't save that note"));
    expect(tree.root.findByType("textarea").props.value).toBe("bring up sleep");
  });

  it("clears the box when the save succeeds", async () => {
    const tree = await addNote(() => Promise.resolve({ note: { id: "n1" } }));
    await settle(() => expect(tree.root.findByType("textarea").props.value).toBe(""));
    expect(textOf(tree.toJSON())).not.toContain("Couldn't save that note");
  });
});
