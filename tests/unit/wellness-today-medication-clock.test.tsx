// @vitest-environment jsdom
// Medication dose times on Today follow the user's 12/24-hour setting (#3326).
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import type { LocaleDateFormat, MedicationScheduleResponse } from "@moss/shared";
import type * as ApiClientModule from "../../apps/web/src/api/client.js";
import { getLocaleSettings, getMedicationSchedule } from "../../apps/web/src/api/client.js";
import { WellnessToday } from "../../apps/web/src/wellness/wellness-today.js";

vi.mock("../../apps/web/src/api/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClientModule>()),
  getLocaleSettings: vi.fn(),
  getMedicationSchedule: vi.fn()
}));

const schedule: MedicationScheduleResponse = {
  date: "2026-10-10",
  slots: [
    {
      medicationId: "med-1",
      name: "Evening tablet",
      scheduledFor: "2026-10-10T21:00:00.000Z",
      localTime: "21:00",
      asNeeded: false,
      status: "pending"
    }
  ]
};

function textOf(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textOf).join("");
  return textOf((node as { children?: unknown }).children);
}

function doseTimes(tree: ReactTestRenderer): string[] {
  return tree.root
    .findAll((n) => n.type === "span" && n.props.className === "wl-medrow__time")
    .map((n) => textOf(n.props.children));
}

async function renderToday(dateFormat: LocaleDateFormat) {
  vi.mocked(getLocaleSettings).mockResolvedValue({
    locale: { timezone: "UTC", region: "en-US", dateFormat }
  });
  vi.mocked(getMedicationSchedule).mockResolvedValue(schedule);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      createElement(
        QueryClientProvider,
        { client },
        createElement(WellnessToday, {
          checkins: [],
          streak: 0,
          theme: "light",
          onManage: () => {},
          onModalOpen: () => {},
          onModalEdit: () => {}
        })
      )
    );
  });
  return tree;
}

describe("Today medication dose times", () => {
  it.each([
    ["12", "9:00 PM"],
    ["24", "21:00"]
  ] as const)("shows a 9 PM dose as %s-hour time", async (dateFormat, expected) => {
    const tree = await renderToday(dateFormat);
    await vi.waitFor(() => expect(doseTimes(tree)).toEqual([expected]), { timeout: 3000 });
  });
});
