import { expect, test } from "@playwright/test";

import { renderWellnessExportHtml } from "../../packages/wellness/src/export-render.js";

// Long medication notes must not starve the Schedule and State columns of the printed export.

const longNote = Array.from(
  { length: 40 },
  (_, index) => `Observation ${index + 1}: take with food and record any side effects.`
).join(" ");

test("long medication notes keep schedule and state columns readable", async ({ page }) => {
  const html = renderWellnessExportHtml({
    ownerName: "Example",
    from: "2026-01-01",
    to: "2026-03-31",
    generatedAt: "2026-04-01",
    categories: {
      medications: {
        medications: [
          {
            name: "Example medication",
            dosage: "10 mg",
            frequencyType: "daily",
            scheduleTimes: ["08:00", "20:00"],
            active: true,
            notes: longNote
          }
        ],
        logs: [
          {
            medicationName: "Example medication",
            status: "taken",
            dose: "10 mg",
            prnReason: longNote,
            scheduledFor: "2026-03-01T08:00:00.000Z",
            loggedAt: null
          }
        ]
      }
    }
  });

  await page.setViewportSize({ width: 794, height: 1123 });
  await page.setContent(html);
  await page.emulateMedia({ media: "print" });

  const columns = await page.locator("table").evaluateAll((tables) =>
    tables.map((table) => {
      const tableWidth = table.getBoundingClientRect().width;
      return Array.from(table.querySelectorAll("tbody tr:first-child td")).map(
        (cell) => cell.getBoundingClientRect().width / tableWidth
      );
    })
  );

  expect(columns).toHaveLength(2);
  for (const shares of columns) {
    expect(shares).toHaveLength(3);
    for (const share of shares) expect(share).toBeGreaterThan(0.15);
  }

  const schedule = page.locator("table").first().locator("tbody td").nth(1);
  const state = page.locator("table").first().locator("tbody td").nth(2);
  await expect(schedule).toHaveText("daily — 08:00, 20:00");
  await expect(state).toHaveText("active");
  for (const cell of [schedule, state]) {
    const lines = await cell.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return new Set(Array.from(range.getClientRects(), (rect) => Math.round(rect.top))).size;
    });
    expect(lines).toBe(1);
  }
});
