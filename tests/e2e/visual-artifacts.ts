import { join } from "node:path";
import type { Page } from "@playwright/test";

// Opt-in review output, not an assertion or replacement for Playwright failure traces.
// Normal smoke runs retain every interaction check without writing unused PNGs.
export async function captureVisualArtifact(
  page: Pick<Page, "screenshot">,
  filename: string
): Promise<void> {
  const directory = process.env.MOSS_VISUAL_ARTIFACT_DIR;
  if (!directory) return;
  await page.screenshot({ path: join(directory, filename), fullPage: true });
}
