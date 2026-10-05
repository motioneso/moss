import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

// The real Checklist, mounted through the dev server's own stylesheet pipeline. No API data.
const CHECKLIST_MODULE = `/@fs${fileURLToPath(new URL("../../packages/ui/src/checklist.tsx", import.meta.url))}`;
const LONG = "nomic-ai/nomic-embed-text-v1.5";

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 }
]) {
  test(`checklist rows stay on one line at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");

    await page.evaluate(
      async ({ modulePath, long, specifiers }) => {
        const reactMod = await import(/* @vite-ignore */ specifiers.react);
        const clientMod = await import(/* @vite-ignore */ specifiers.client);
        const react = reactMod.default ?? reactMod;
        const client = clientMod.default ?? clientMod;
        const { Checklist } = await import(/* @vite-ignore */ modulePath);
        document.body.innerHTML = '<div id="proof" style="position:relative;height:400px"></div>';
        const noop = () => undefined;
        client.createRoot(document.getElementById("proof")!).render(
          react.createElement(Checklist, {
            ariaLabel: "Models to show",
            items: [
              { id: "a", label: "gpt-5.5", count: 12, checked: true },
              { id: "b", label: long, count: 61, checked: true },
              { id: "c", label: "claude-sonnet-5-5", count: 3, checked: false },
              { id: "d", label: "No model (tool only)", count: 7, checked: true }
            ],
            onToggle: noop,
            onTickAll: noop,
            onDone: noop,
            onClose: noop
          })
        );
      },
      {
        modulePath: CHECKLIST_MODULE,
        long: LONG,
        specifiers: { react: "/@id/react", client: "/@id/react-dom/client" }
      }
    );

    const rows = page.locator(".jds-checklist__item");
    await expect(rows).toHaveCount(4);

    const boxes = await rows.evaluateAll((els) =>
      els.map((el) => {
        const row = el.getBoundingClientRect();
        const box = el.querySelector("input")!.getBoundingClientRect();
        const label = el.querySelector(".jds-checklist__label")!.getBoundingClientRect();
        const count = el.querySelector(".jds-checklist__count")!.getBoundingClientRect();
        return {
          rowH: row.height,
          boxLeft: box.left,
          boxW: box.width,
          labelLeft: label.left,
          labelH: label.height,
          countRight: count.right
        };
      })
    );

    for (const b of boxes) {
      expect(b.boxW).toBeLessThanOrEqual(20);
      expect(b.rowH).toBeLessThan(50);
      expect(b.labelH).toBeLessThan(24);
    }
    expect(new Set(boxes.map((b) => b.boxLeft)).size).toBe(1);
    expect(new Set(boxes.map((b) => b.labelLeft)).size).toBe(1);
    expect(new Set(boxes.map((b) => b.countRight)).size).toBe(1);
    await expect(page.locator(".jds-checklist__label", { hasText: LONG })).toHaveAttribute(
      "title",
      LONG
    );

    await page
      .locator(".jds-checklist")
      .screenshot({ path: `/tmp/build-3047/checklist-${viewport.width}.png` });
  });
}
