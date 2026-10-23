import { createRoot } from "react-dom/client";
import { Note } from "@moss/ui";
import { Frame } from "./frame.js";
import { fallbackText } from "./facts.js";

createRoot(document.getElementById("root")!).render(
  <Frame>
    <Note variant="plan">{fallbackText}</Note>
  </Frame>
);
