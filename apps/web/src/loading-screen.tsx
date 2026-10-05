import { BrandMark } from "@moss/ui";

import { assistantName } from "./api/use-assistant-name.js";

/** Full-screen loading state. The mark's animation lives in boot.css, shared with index.html. */
export function LoadingScreen() {
  return (
    <main className="center-screen">
      <span className="loading-mark">
        <BrandMark />
      </span>
      <p role="status">Loading {assistantName()}</p>
    </main>
  );
}
