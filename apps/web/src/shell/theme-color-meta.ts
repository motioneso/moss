/** Points the browser address-bar colour at the current page background (`--bg`). */
export function syncThemeColorMeta(root: HTMLElement = document.documentElement): void {
  const bg = getComputedStyle(root).getPropertyValue("--bg").trim();
  const meta = root.ownerDocument.querySelector('meta[name="theme-color"]');
  if (bg && meta) meta.setAttribute("content", bg);
}
