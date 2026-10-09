import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

// The real Button mounted through the dev server's stylesheet pipeline, beside the raw
// control classes the shared stylesheet targets. No API data.
const BUTTON_MODULE = `/@fs${fileURLToPath(new URL("../../packages/ui/src/button.tsx", import.meta.url))}`;
const IDS = ["p-btn", "p-input", "p-select", "p-icon", "p-seg"];

async function measure(page: Page) {
  await page.goto("/");
  await page.evaluate(
    async ({ modulePath, specifiers }) => {
      const reactMod = await import(/* @vite-ignore */ specifiers.react);
      const clientMod = await import(/* @vite-ignore */ specifiers.client);
      const react = reactMod.default ?? reactMod;
      const client = clientMod.default ?? clientMod;
      const { Button } = await import(/* @vite-ignore */ modulePath);
      document.body.innerHTML = '<div id="proof"></div>';
      const h = react.createElement;
      client
        .createRoot(document.getElementById("proof")!)
        .render(
          h(
            "div",
            null,
            h(Button, { id: "p-btn", size: "sm" }, "Save"),
            h("input", { id: "p-input", className: "jds-input" }),
            h("select", { id: "p-select", className: "jds-select" }, h("option", null, "a")),
            h("button", { id: "p-icon", className: "jds-iconbtn jds-iconbtn--sm" }, "x"),
            h("button", { id: "p-seg", className: "jds-segmented__opt" }, "Day")
          )
        );
    },
    {
      modulePath: BUTTON_MODULE,
      specifiers: { react: "/@id/react", client: "/@id/react-dom/client" }
    }
  );
  await page.waitForSelector("#p-btn");
  const out: Record<string, { w: number; h: number }> = {};
  for (const id of IDS) {
    const box = await page.locator(`#${id}`).boundingBox();
    out[id] = { w: box?.width ?? 0, h: box?.height ?? 0 };
  }
  return out;
}

test("controls are at least 44px tall at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const m = await measure(page);
  for (const id of IDS) expect(m[id]!.h, id).toBeGreaterThanOrEqual(44);
  expect(m["p-icon"]!.w).toBeGreaterThanOrEqual(44);
});

test("small buttons stay compact on desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const m = await measure(page);
  expect(m["p-btn"]!.h).toBeLessThan(44);
});
