import { Component, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Renderer } from "@openuidev/react-lang";
import { Note } from "@moss/ui";
import { library } from "./catalog.js";
import { selectedFixture } from "./fixtures.js";
import { Frame } from "./frame.js";
import { validateProgram } from "./guard.js";
import { fallbackText } from "./facts.js";

function Fallback() {
  return (
    <Note variant="practical">
      <p role="status">Visual unavailable</p>
      <p>{fallbackText}</p>
    </Note>
  );
}

class VisualBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <Fallback /> : this.props.children;
  }
}

function Visual() {
  const fixture = selectedFixture(window.location.search);
  const [failed, setFailed] = useState(false);
  if (failed || !validateProgram(fixture.program)) return <Fallback />;
  return (
    <Renderer
      library={library}
      response={fixture.program}
      isStreaming={false}
      publishObservability={false}
      toolProvider={null}
      onError={(errors) => {
        if (errors.length) setFailed(true);
      }}
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <Frame>
    <VisualBoundary>
      <Visual />
    </VisualBoundary>
  </Frame>
);
