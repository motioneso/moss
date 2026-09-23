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
export interface MaskClipRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
/** Intersect a rect with clip rects. Empty intersections return null. */
export function intersectMaskRect(
  rect: MaskClipRect,
  clips: ReadonlyArray<MaskClipRect>
): MaskClipRect | null {
  let x1 = rect.x;
  let y1 = rect.y;
  let x2 = rect.x + rect.width;
  let y2 = rect.y + rect.height;
  for (const clip of clips) {
    x1 = Math.max(x1, clip.x);
    y1 = Math.max(y1, clip.y);
    x2 = Math.min(x2, clip.x + clip.width);
    y2 = Math.min(y2, clip.y + clip.height);
    if (x2 <= x1 || y2 <= y1) return null;
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}
export async function maskRects(
  page: Page
): Promise<Array<{ x: number; y: number; width: number; height: number }>> {
  return page.evaluate((selectors) => {
    const clipRect = (
      rect: { x: number; y: number; width: number; height: number },
      clips: Array<{ x: number; y: number; width: number; height: number }>
    ): { x: number; y: number; width: number; height: number } | null => {
      let x1 = rect.x;
      let y1 = rect.y;
      let x2 = rect.x + rect.width;
      let y2 = rect.y + rect.height;
      for (const clip of clips) {
        x1 = Math.max(x1, clip.x);
        y1 = Math.max(y1, clip.y);
        x2 = Math.min(x2, clip.x + clip.width);
        y2 = Math.min(y2, clip.y + clip.height);
        if (x2 <= x1 || y2 <= y1) return null;
      }
      return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
    };
    const out: Array<{ x: number; y: number; width: number; height: number }> = [];
    const seen = new Set<string>();
    for (const selector of selectors) {
      for (const el of document.querySelectorAll<HTMLElement>(selector)) {
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const clips: Array<{ x: number; y: number; width: number; height: number }> = [];
        let transparent = false;
        let ancestor: HTMLElement | null = el;
        while (ancestor) {
          const ancestorStyle = getComputedStyle(ancestor);
          if (Number.parseFloat(ancestorStyle.opacity) === 0) {
            transparent = true;
            break;
          }
          if (ancestorStyle.overflowX !== "visible" || ancestorStyle.overflowY !== "visible") {
            const box = ancestor.getBoundingClientRect();
            clips.push({
              x: box.x + ancestor.clientLeft,
              y: box.y + ancestor.clientTop,
              width: ancestor.clientWidth,
              height: ancestor.clientHeight
            });
          }
          ancestor = ancestor.parentElement;
        }
        if (transparent) continue;
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
            const clipped = clipRect({ x: r.x, y, width: r.width, height }, clips);
            if (!clipped) continue;
            const hit = document.elementFromPoint(
              clipped.x + clipped.width / 2,
              clipped.y + clipped.height / 2
            );
            if (hit === null || (hit !== el && !el.contains(hit) && !hit.contains(el))) continue;
            const key = [clipped.x, clipped.y, clipped.width, clipped.height]
              .map((value) => value.toFixed(2))
              .join(":");
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(clipped);
          }
          range.detach();
        }
      }
    }
    return out;
  }, GENERATED_TEXT_SELECTORS);
}
