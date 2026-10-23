import type { ReactNode } from "react";
import { SectionHead } from "@moss/ui";
import { fallbackText } from "./facts.js";
import "../../apps/web/src/styles/tokens.css";
import "@moss/ui/styles.css";
import "./styles.css";

export function Frame({ children }: { children: ReactNode }) {
  return (
    <main>
      <SectionHead title="Visual reply runtime evaluation" />
      <p>
        This standalone experiment uses fixed programs and example data. It is separate from Moss
        chat.
      </p>
      <p data-testid="answer">You have six hours to allocate across five projects.</p>
      {children}
      <details>
        <summary>Readable facts</summary>
        <p data-testid="fallback">{fallbackText}</p>
      </details>
    </main>
  );
}
