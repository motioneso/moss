// Real host component and shared dialog; explicit synthetic HTTP responses in the inspection script.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ExternalModuleToolsHandleV1 } from "@moss/module-web-sdk";
import { Button, Masthead } from "@moss/ui";
import { ModuleToolsHost } from "../../apps/web/src/external-modules/tools-host";

function Controls({ tools }: { tools: ExternalModuleToolsHandleV1 }) {
  const [status, setStatus] = useState("Ready");
  const run = async (name: string) => {
    setStatus("Working");
    const outcome = await tools.invoke(`demo.${name}`, { id: "synthetic-entry" });
    setStatus(outcome.status);
  };
  return (
    <>
      <div
        style={{
          display: "flex",
          gap: "var(--space-2)",
          flexWrap: "wrap",
          marginBlock: "var(--space-5)"
        }}
      >
        <Button onClick={() => void run("save")}>Save entry</Button>
        <Button variant="secondary" onClick={() => void run("delete")}>
          Delete entry
        </Button>
        <Button variant="secondary" onClick={() => void run("fail")}>
          Uncertain save
        </Button>
      </div>
      <p role="status">{status}</p>
    </>
  );
}
function Fixture() {
  const [actor, setActor] = useState("synthetic-owner-a");
  useEffect(() => {
    const change = () => setActor("synthetic-owner-b");
    window.addEventListener("fixture-owner-change", change);
    return () => window.removeEventListener("fixture-owner-change", change);
  }, []);
  return (
    <main style={{ padding: "var(--space-4)", maxWidth: "var(--container)", margin: "auto" }}>
      <Masthead
        tone="field"
        eyebrow="Synthetic host inspection"
        title="Review a change"
        lede="No bank or private financial data is connected."
      />
      <ModuleToolsHost moduleId="demo" actorScopeKey={actor}>
        {(tools) => <Controls tools={tools} />}
      </ModuleToolsHost>
    </main>
  );
}
createRoot(document.getElementById("app")!).render(<Fixture />);
