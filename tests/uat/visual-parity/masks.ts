// tests/uat/visual-parity/masks.ts
//
// VP-P0 honest masks: generated-text selectors only, each verified in
// apps/web/src/today. Nothing structural is masked. Scores, times, photos,
// controls and layout are always compared.
import type { Page } from "@playwright/test";
export const GENERATED_TEXT_SELECTORS: readonly string[] = [
  ".today-hero__title",
  ".today-hero__summary",
  ".brief-reader__headline",
  ".jds-brief__body",
  ".evening-plan__lede",
  ".evening-plan__prose"
];

/** Viewport-space rects of the visible generated text, not its container. */
export async function maskRects(
  page: Page
): Promise<Array<{ x: number; y: number; width: number; height: number }>> {
  return page.evaluate((selectors) => {
    const out: Array<{ x: number; y: number; width: number; height: number }> = [];
    const seen = new Set<string>();
    for (const selector of selectors) {
      for (const el of document.querySelectorAll<HTMLElement>(selector)) {
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          if (!node.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const r of range.getClientRects()) {
            if (r.width < 2 || r.height < 2) continue;
            const fontSize = Number.parseFloat(getComputedStyle(node.parentElement!).fontSize);
            const height = Math.min(r.height, fontSize * 0.65 + 2);
            const y = r.y + (r.height - height) / 2;
            const key = [r.x, y, r.width, height].map((value) => value.toFixed(2)).join(":");
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ x: r.x, y, width: r.width, height });
          }
          range.detach();
        }
      }
    }
    return out;
  }, GENERATED_TEXT_SELECTORS);
}
