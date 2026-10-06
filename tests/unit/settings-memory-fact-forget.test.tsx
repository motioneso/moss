// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MemoryDashboardItem } from "../../apps/web/src/api/memory-client";

const deleteMemoryFact = vi.fn(async (_id: string) => undefined);
const deleteMemoryEntity = vi.fn(async (_id: string) => undefined);

vi.mock("../../apps/web/src/api/memory-client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  deleteMemoryFact: (id: string) => deleteMemoryFact(id),
  deleteMemoryEntity: (id: string) => deleteMemoryEntity(id)
}));

vi.mock("../../apps/web/src/locale/locale-format", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useUserLocale: () => ({ locale: "en-US", timeZone: "UTC" })
}));

vi.mock("../../apps/web/src/settings/settings-feedback", () => ({
  useFeedback: () => ({
    toast: vi.fn(),
    confirm: (options: { onConfirm: () => void }) => options.onConfirm()
  })
}));

const { FactActions } = await import("../../apps/web/src/settings/settings-memory-dashboard");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FACT = {
  id: "fact-1",
  itemKind: "fact",
  title: "Likes tea",
  status: "active",
  editableFields: ["pinned"],
  sources: []
} as unknown as MemoryDashboardItem;

describe("fact panel Forget", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("deletes through the facts route, not the entity route", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <FactActions item={FACT} onDone={() => undefined} />
        </QueryClientProvider>
      );
    });
    const forget = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Forget")
    );
    await act(async () => {
      forget?.click();
    });
    expect(deleteMemoryFact).toHaveBeenCalledWith("fact-1");
    expect(deleteMemoryEntity).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});
