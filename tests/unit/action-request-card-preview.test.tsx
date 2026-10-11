// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { ActionRequestCard } from "../../apps/web/src/chat/action-request-card.js";
import { parseRecord } from "../../apps/web/src/chat/use-chat-stream.js";
import { RecordRow } from "../../apps/web/src/chat/message-row.js";
import { aiActionPresentationSchema } from "../../packages/shared/src/ai-action-presentation-schema.js";

const NOTICE = "Moss read something from outside your account before asking this.";
const UNAVAILABLE = "Details for this request aren’t available. Reject it and ask Moss again.";
const details = {
  presentation: "human" as const,
  target: "Weekend theme <script>no()</script>",
  fields: [
    { label: "Name", value: "**Evening**" },
    { label: "Enabled", value: "false" }
  ]
};
const baseProps = {
  actionRequestId: "app-1",
  toolName: "app.callAction",
  summary: "MODEL SUMMARY: app.callAction DELETE /api/themes/raw-id {secret: true}",
  outcomeTitle: "Change theme",
  details
};

function renderCard(props: Parameters<typeof ActionRequestCard>[0]): HTMLElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div");
  host.innerHTML = renderToString(
    createElement(QueryClientProvider, { client }, createElement(ActionRequestCard, props))
  );
  client.clear();
  return host;
}
function buttons(host: HTMLElement): string[] {
  return [...host.querySelectorAll("button")].map((button) => button.textContent ?? "");
}

describe("approved pending card", () => {
  it("uses the shared small Card, plain primary Approve and secondary Reject", () => {
    const host = renderCard(baseProps);
    expect(host.querySelector(".jds-card.jds-card--pad-sm")).not.toBeNull();
    expect(host.querySelector("h2")?.textContent).toBe("Change theme");
    expect(buttons(host)).toEqual(["Approve", "Reject"]);
    expect(host.querySelectorAll("button")[0]?.classList.contains("jds-btn--primary")).toBe(true);
    expect(host.querySelectorAll("button")[1]?.classList.contains("jds-btn--secondary")).toBe(true);
    expect(host.querySelector("svg")).toBeNull();
    expect(host.textContent).not.toMatch(
      /Needs your approval|MODEL SUMMARY|app\.callAction|DELETE|\/api\/|raw-id|secret|always approve/i
    );
    expect(host.querySelector("[style]")).toBeNull();
  });

  it("renders the exact server title, full target and all label/value rows as text", () => {
    const host = renderCard(baseProps);
    expect(host.querySelector(".action-request-target")?.textContent).toBe(details.target);
    expect([...host.querySelectorAll("dt")].map((node) => node.textContent)).toEqual([
      "Name",
      "Enabled"
    ]);
    expect([...host.querySelectorAll("dd")].map((node) => node.textContent)).toEqual([
      "**Evening**",
      "false"
    ]);
    expect(host.querySelector("q, script, strong")).toBeNull();
    expect(host.textContent).not.toContain(NOTICE);
  });

  it("keeps long multiline strings intact without inserted quotes, truncation or HTML", () => {
    const target = "First line\n  indented <b>memory</b> & full text\n" + "unbroken".repeat(160);
    const title = "Exact  title\nnext line";
    const fields = [
      { label: "Exact  label\nnext line", value: "  before\n" + "value ".repeat(300) }
    ];
    const host = renderCard({
      ...baseProps,
      outcomeTitle: title,
      details: { ...details, target, fields }
    });
    expect(host.querySelector("h2")?.textContent).toBe(title);
    expect(host.querySelector(".action-request-target")?.textContent).toBe(target);
    expect(host.querySelector("dt")?.textContent).toBe(fields[0]!.label);
    expect(host.querySelector("dd")?.textContent).toBe(fields[0]!.value);
    expect(host.querySelector("b")).toBeNull();
  });

  it("renders the one exact outside-content notice only for an explicit true flag", () => {
    const host = renderCard({ ...baseProps, outsideContentNotice: true });
    expect(host.querySelector(".action-request-notice")?.textContent).toBe(NOTICE);
    expect(renderCard({ ...baseProps, outsideContentNotice: false }).textContent).not.toContain(
      NOTICE
    );
  });

  it("does not invent a field row for a body-free delete", () => {
    const host = renderCard({ ...baseProps, details: { ...details, fields: [] } });
    expect(host.querySelector("dl")).toBeNull();
    expect(buttons(host)).toEqual(["Approve", "Reject"]);
  });

  it("preserves an explicitly submitted empty value without dropping its row", () => {
    const host = renderCard({
      ...baseProps,
      details: { ...details, fields: [{ label: "Description", value: "" }] }
    });
    expect(host.querySelector("dt")?.textContent).toBe("Description");
    expect(host.querySelector("dd")?.textContent).toBe("");
    expect(buttons(host)).toEqual(["Approve", "Reject"]);
  });

  it.each(["Delete memory", "Delete note", "Delete custom theme", "Forget saved memory"])(
    "does not infer destructive styling from the title %s",
    (outcomeTitle) => {
      const host = renderCard({ ...baseProps, outcomeTitle });
      expect(host.querySelector(".jds-btn--danger")).toBeNull();
      expect(host.querySelector(".jds-btn--primary")?.textContent).toBe("Approve");
    }
  );

  it.each(["memory.forget", "app.callAction"])(
    "uses red Approve for explicit server memory deletion through %s",
    (toolName) => {
      const host = renderCard({
        ...baseProps,
        toolName,
        details: { ...details, approvalKind: "memory_delete", fields: [] }
      });
      expect(host.querySelector(".jds-btn--danger")?.textContent).toBe("Approve");
      expect(host.querySelector(".jds-btn--secondary")?.textContent).toBe("Reject");
    }
  );

  it("preserves permanent note deletion through schema, SSE and the actual card", () => {
    expect(aiActionPresentationSchema.properties.details.properties.approvalKind.enum).toContain(
      "note_delete"
    );
    const noteDetails = {
      presentation: "human",
      approvalKind: "note_delete",
      target: "Full note title\nincluding detail",
      fields: [
        { label: "Deletion", value: "Permanently delete this note. There is no trash or undo." }
      ]
    };
    const record = parseRecord(
      JSON.stringify({
        kind: "action_request",
        text: "Technical metadata",
        summary: "Model summary must not appear",
        actionRequestId: "note-delete",
        toolName: "notes.delete",
        outcomeTitle: "Delete note",
        details: noteDetails
      })
    );
    expect(record?.details).toEqual(noteDetails);
    if (!record) throw new Error("Expected note deletion record");
    const client = new QueryClient();
    const host = document.createElement("div");
    host.innerHTML = renderToString(
      createElement(QueryClientProvider, { client }, createElement(RecordRow, { record }))
    );
    expect(host.querySelector(".jds-btn--danger")?.textContent).toBe("Approve");
    expect(host.querySelector(".jds-btn--secondary")?.textContent).toBe("Reject");
    expect(host.querySelector(".action-request-target")?.textContent).toBe(noteDetails.target);
    expect(host.querySelector("dd")?.textContent).toBe(noteDetails.fields[0]!.value);
    expect(host.textContent).not.toContain("Model summary");
    client.clear();
  });

  it.each(["notes.delete", "app.callAction"])(
    "restores red Approve only from explicit note-delete identity for %s",
    (toolName) => {
      const host = renderCard({
        ...baseProps,
        toolName,
        outcomeTitle: "Delete note",
        approvalAvailable: true,
        details: { ...details, approvalKind: "note_delete" }
      });
      expect(host.querySelector(".jds-btn--danger")?.textContent).toBe("Approve");
      const unmarked = renderCard({ ...baseProps, toolName, outcomeTitle: "Delete note" });
      expect(unmarked.querySelector(".jds-btn--danger")).toBeNull();
    }
  );

  it("retains the stable requested-focus target", () => {
    const host = renderCard({ ...baseProps, focusRequested: true });
    expect(host.querySelector('[data-action-request-id="app-1"]')?.getAttribute("tabindex")).toBe(
      "-1"
    );
  });

  it("uses the approved wrapping layout at desktop and phone widths without fixed card dimensions", () => {
    // Static layout contract only: actual 1440/390/320px visual fit requires browser proof.
    const styles = readFileSync(resolve("apps/web/src/styles/kit-chat.css"), "utf8");
    const block = (name: string) => styles.match(new RegExp(`\\.${name}\\s*\\{([^}]+)\\}`))?.[1];
    expect(block("action-request-card")).toContain("min-width: 0");
    expect(block("action-request-stack")).toContain("gap: var(--space-3)");
    expect(block("action-request-field")).toContain(
      "grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr)"
    );
    expect(block("action-request-actions")).toContain("flex-wrap: wrap");
    expect(block("action-request-actions")).toContain("gap: var(--space-2)");
    for (const name of [
      "action-request-title",
      "action-request-target",
      "action-request-arguments"
    ]) {
      expect(block(name)).toContain("overflow-wrap: anywhere");
      expect(block(name)).toContain("white-space: pre-wrap");
      expect(block(name)).not.toMatch(/max-height|text-overflow|line-clamp/);
    }
    expect(styles).toMatch(
      /\.action-request-field dt,\s*\.action-request-field dd\s*\{[^}]*overflow-wrap: anywhere;[^}]*white-space: pre-wrap;/
    );
  });
});

describe("incomplete disclosure", () => {
  it.each([
    undefined,
    {
      target: "Legacy target",
      fields: [
        { label: "Method", value: "DELETE" },
        { label: "Path", value: "/api/private/raw-id" },
        { label: "Body", value: "secret" }
      ]
    },
    { presentation: "human" as const, target: null, fields: [] },
    { presentation: "human" as const, target: "   ", fields: [] }
  ])("keeps Reject without rendering incomplete or legacy details: %j", (details) => {
    const host = renderCard({ ...baseProps, details, outsideContentNotice: true });
    expect(buttons(host)).toEqual(["Reject"]);
    expect(host.querySelector('[role="status"]')?.textContent).toBe(UNAVAILABLE);
    expect(host.querySelector("dl")).toBeNull();
    expect(host.textContent).not.toMatch(
      /Legacy target|Method|DELETE|Path|Body|raw-id|secret|MODEL SUMMARY/
    );
    expect(host.textContent).not.toContain(NOTICE);
  });

  it.each([undefined, "", " \n "])(
    "requires a nonblank frozen server title rather than a model summary (%j)",
    (outcomeTitle) => {
      const host = renderCard({ ...baseProps, outcomeTitle });
      expect(buttons(host)).toEqual(["Reject"]);
      expect(host.querySelector("h2")?.textContent).toBe("Action request");
      expect(host.textContent).not.toContain(baseProps.summary);
    }
  );

  it("keeps metadata-only reloads decline-only even with stale details", () => {
    const host = renderCard({ ...baseProps, approvalAvailable: false });
    expect(buttons(host)).toEqual(["Reject"]);
    expect(host.textContent).not.toContain(details.target);
  });

  it("restores full disclosure with normal approval", () => {
    const host = renderCard({ ...baseProps, approvalAvailable: true });
    expect(buttons(host)).toEqual(["Approve", "Reject"]);
    expect(host.querySelector(".action-request-target")?.textContent).toBe(details.target);
  });
});

describe("email-shaped preview", () => {
  it("preserves the full server recipient, subject and body", () => {
    const host = renderCard({
      ...baseProps,
      toolName: "email.draftReply",
      outcomeTitle: "Draft a reply",
      details: undefined,
      preview: {
        to: "alice@example.test",
        subject: "Re: lunch plans",
        body: "Sounds great — see you at noon.\n  Thanks!"
      }
    });
    expect(host.querySelector(".action-request-preview__body")?.textContent).toBe(
      "Sounds great — see you at noon.\n  Thanks!"
    );
    expect([...host.querySelectorAll("dd")].map((node) => node.textContent)).toEqual([
      "alice@example.test",
      "Re: lunch plans"
    ]);
    expect(buttons(host)).toEqual(["Approve", "Reject"]);
  });

  it("never replaces a missing preview with model prose", () => {
    const host = renderCard({ ...baseProps, toolName: "email.draftReply", details: undefined });
    expect(buttons(host)).toEqual(["Reject"]);
    expect(host.textContent).not.toContain(baseProps.summary);
  });
});

describe("native file and shell permission cards", () => {
  it.each([
    "Bash: cat -- /vault/notes/exact  file.md",
    "Read: /vault/notes/" + "long-file-name".repeat(90) + ".md\n  exact continuation"
  ])("preserves the full exact native line with the approved look: %s", (summary) => {
    const host = renderCard({
      ...baseProps,
      nativePermission: true,
      outcomeTitle: undefined,
      details: undefined,
      summary
    });
    expect(host.querySelector(".jds-card--pad-sm")).not.toBeNull();
    expect(host.querySelector("h2")?.textContent).toBe("Permission request");
    expect(host.querySelector(".action-request-summary")?.textContent).toBe(summary);
    expect(buttons(host)).toEqual(["Approve", "Reject"]);
    expect(host.querySelector(".jds-btn--primary")?.textContent).toBe("Approve");
    expect(host.querySelector("svg")).toBeNull();
  });

  it("does not treat a native-looking tool name or summary as a native permission", () => {
    const host = renderCard({
      ...baseProps,
      toolName: "Bash",
      outcomeTitle: undefined,
      details: undefined,
      summary: "Bash: /private/raw-path"
    });
    expect(buttons(host)).toEqual(["Reject"]);
    expect(host.textContent).not.toContain("/private/raw-path");
  });

  it("does not make metadata-only native requests approvable after reload", () => {
    const host = renderCard({
      ...baseProps,
      nativePermission: true,
      approvalAvailable: false,
      summary: "Read: /private/raw-path"
    });
    expect(buttons(host)).toEqual(["Reject"]);
    expect(host.textContent).not.toContain("/private/raw-path");
  });

  it("does not replace a missing exact native line with generic transcript text", () => {
    const record = parseRecord(
      JSON.stringify({
        kind: "action_request",
        text: "Approve this permission",
        actionRequestId: "native-missing-line",
        nativePermission: true
      })
    );
    if (!record) throw new Error("Expected record");
    const client = new QueryClient();
    const host = document.createElement("div");
    host.innerHTML = renderToString(
      createElement(QueryClientProvider, { client }, createElement(RecordRow, { record }))
    );
    expect(buttons(host)).toEqual(["Reject"]);
    expect(host.querySelector(".action-request-summary")).toBeNull();
    client.clear();
  });

  it("only parses an explicit true native discriminator", () => {
    const base = { kind: "action_request", text: "Permission", summary: "Read: exact path" };
    expect(parseRecord(JSON.stringify({ ...base, nativePermission: true }))?.nativePermission).toBe(
      true
    );
    for (const nativePermission of [undefined, false, "true", 1])
      expect(
        parseRecord(JSON.stringify({ ...base, nativePermission }))?.nativePermission
      ).toBeUndefined();
  });
});

describe("connected-tool exact argument disclosure", () => {
  const argumentsObject = {
    name: "Kitchen light",
    nested: { items: [false, 0, null, ["exact", { note: "<script>no()</script>\n  preserved" }]] },
    large: "long unbroken value".repeat(800)
  };
  const exactArguments = JSON.stringify(argumentsObject, null, 2);
  const external = {
    ...baseProps,
    externalTool: true as const,
    outcomeTitle: "Connected tool request",
    toolName: "connected-example.update",
    details: undefined,
    exactArguments
  };

  it("renders the entire frozen nested JSON and large strings as escaped, wrapping text", () => {
    const host = renderCard(external);
    expect(host.querySelector("h2")?.textContent).toBe("Connected tool request");
    expect(host.querySelector(".action-request-target")?.textContent).toBe(external.toolName);
    expect(host.querySelector(".action-request-arguments")?.textContent).toBe(exactArguments);
    expect(JSON.parse(host.querySelector(".action-request-arguments")!.textContent!)).toEqual(
      argumentsObject
    );
    expect(host.querySelector("script, svg, .jds-btn--danger")).toBeNull();
    expect(host.textContent).not.toContain(baseProps.summary);
    expect(buttons(host)).toEqual(["Approve", "Reject"]);
    expect(host.querySelector(".jds-btn--primary")?.textContent).toBe("Approve");
  });

  it.each([undefined, "", "   ", "null", "[]", "5", "{broken", '"opaque"'])(
    "keeps Reject when a restored request has lost usable argument details (%j)",
    (exactArguments) => {
      const host = renderCard({ ...external, exactArguments });
      expect(buttons(host)).toEqual(["Reject"]);
      expect(host.querySelector(".action-request-arguments")).toBeNull();
      expect(host.textContent).toContain(UNAVAILABLE);
    }
  );

  it("never infers connected-tool provenance from a name or arguments alone", () => {
    const host = renderCard({ ...external, externalTool: undefined });
    expect(buttons(host)).toEqual(["Reject"]);
    expect(host.textContent).not.toContain(exactArguments);
  });

  it("does not let mixed provenance or stale human details bypass missing exact arguments", () => {
    for (const props of [
      { ...external, nativePermission: true as const },
      { ...external, details, exactArguments: undefined }
    ])
      expect(buttons(renderCard(props))).toEqual(["Reject"]);
  });

  it("keeps a complete recovered request approvable and withholds unavailable disclosure", () => {
    expect(buttons(renderCard({ ...external, approvalAvailable: true }))).toEqual([
      "Approve",
      "Reject"
    ]);
    const host = renderCard({ ...external, approvalAvailable: false });
    expect(buttons(host)).toEqual(["Reject"]);
    expect(host.textContent).not.toContain(exactArguments);
  });

  it("does not invent a missing connected-tool identity from the transcript record kind", () => {
    const record = parseRecord(
      JSON.stringify({
        kind: "action_request",
        text: "Request",
        actionRequestId: "external-missing-name",
        externalTool: true,
        exactArguments
      })
    );
    if (!record) throw new Error("Expected record");
    const client = new QueryClient();
    const host = document.createElement("div");
    host.innerHTML = renderToString(
      createElement(QueryClientProvider, { client }, createElement(RecordRow, { record }))
    );
    expect(buttons(host)).toEqual(["Reject"]);
    expect(host.textContent).not.toContain(exactArguments);
    client.clear();
  });

  it("wires only an explicit server discriminator and its full string through the real row", () => {
    const record = parseRecord(
      JSON.stringify({ kind: "action_request", text: "Technical summary", ...external })
    );
    expect(record?.externalTool).toBe(true);
    expect(record?.exactArguments).toBe(exactArguments);
    if (!record) throw new Error("Expected connected tool record");
    const client = new QueryClient();
    const host = document.createElement("div");
    host.innerHTML = renderToString(
      createElement(QueryClientProvider, { client }, createElement(RecordRow, { record }))
    );
    expect(host.querySelector(".action-request-arguments")?.textContent).toBe(exactArguments);
    expect(buttons(host)).toEqual(["Approve", "Reject"]);
    client.clear();
    for (const externalTool of [undefined, false, "true", 1])
      expect(
        parseRecord(JSON.stringify({ kind: "action_request", text: "Request", externalTool }))
          ?.externalTool
      ).toBeUndefined();
    expect(
      parseRecord(
        JSON.stringify({ kind: "action_request", text: "Request", exactArguments: argumentsObject })
      )?.exactArguments
    ).toBeUndefined();
  });
});

describe("record parsing and wiring", () => {
  it("wires the server title, human details, memory identity and outside-content flag through SSE", () => {
    const record = parseRecord(
      JSON.stringify({
        kind: "action_request",
        text: "Technical text",
        ...baseProps,
        details: { ...details, approvalKind: "memory_delete" },
        outsideContentNotice: true
      })
    );
    expect(record?.details).toEqual({ ...details, approvalKind: "memory_delete" });
    expect(record?.outcomeTitle).toBe(baseProps.outcomeTitle);
    if (!record) throw new Error("Expected a parsed action request");
    const client = new QueryClient();
    const html = renderToString(
      createElement(QueryClientProvider, { client }, createElement(RecordRow, { record }))
    );
    expect(html).toContain("Weekend theme &lt;script&gt;no()&lt;/script&gt;");
    expect(html).toContain("jds-btn--danger");
    expect(html).toContain(NOTICE);
    expect(html).not.toContain(baseProps.summary);
    client.clear();
  });

  it.each([
    [],
    { fields: [] },
    { target: 1, fields: [] },
    { target: null, fields: [{ label: "Name", value: 42 }] },
    { target: null, fields: [null] },
    { ...details, fields: [{ label: "   ", value: "exact value" }] },
    { ...details, presentation: "model" },
    { ...details, approvalKind: "delete" }
  ])("drops malformed details without partial disclosure: %j", (details) => {
    expect(
      parseRecord(JSON.stringify({ kind: "action_request", text: "Change", details }))?.details
    ).toBeUndefined();
  });

  it("retains unmarked legacy records for correlation without declaring them human", () => {
    const legacy = { target: null, fields: [] };
    const record = parseRecord(
      JSON.stringify({
        kind: "action_request",
        text: "Create",
        details: legacy,
        outsideContentNotice: "false"
      })
    );
    expect(record?.details).toEqual(legacy);
    expect(record?.outsideContentNotice).toBeUndefined();
  });

  it("parses a full preview and drops malformed preview fields", () => {
    const base = { kind: "action_request", text: "Draft a reply" };
    const preview = { to: "alice@example.test", subject: "Re: hi", body: "hello there" };
    expect(parseRecord(JSON.stringify({ ...base, preview }))?.preview).toEqual(preview);
    expect(
      parseRecord(JSON.stringify({ ...base, preview: { to: 5, subject: "Re: hi" } }))?.preview
    ).toBeUndefined();
  });

  it("retains allowed outcomes and workflow approvals", () => {
    expect(
      parseRecord(JSON.stringify({ kind: "action_result", text: "Allowed", outcome: "allowed" }))
        ?.outcome
    ).toBe("allowed");
    expect(
      parseRecord(
        JSON.stringify({
          kind: "workflow_approval",
          text: "Approve workflow",
          workflowApprovalId: "approval-1",
          status: "pending"
        })
      )
    ).toMatchObject({ workflowApprovalId: "approval-1", status: "pending" });
  });

  it("preserves valid module refresh identifiers and discards malformed lists", () => {
    const result = { kind: "action_result", text: "Changed", outcome: "executed" };
    expect(
      parseRecord(JSON.stringify({ ...result, affectsModules: ["settings", "jarvis.goals"] }))
        ?.affectsModules
    ).toEqual(["settings", "jarvis.goals"]);
    expect(
      parseRecord(JSON.stringify({ ...result, affectsModules: ["settings", 42] }))?.affectsModules
    ).toBeUndefined();
  });
});
