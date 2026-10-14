import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ApprovedActionScopes,
  ApprovedActionScopeDetail
} from "../../apps/web/src/settings/approved-action-scopes.js";
const agreement = {
  id: "approved",
  version: 1,
  state: "not_active" as const,
  approvedAt: "2026-10-13T09:00:00Z",
  scope: {
    operation: "tasks.updateStatus" as const,
    taskId: "target-id",
    taskTitle: "Proof <script>",
    status: "done" as const,
    dueAt: "2026-10-13T10:00:00Z",
    timeZone: "UTC",
    destinationThreadId: "main"
  }
};
describe("inert approved scope Settings", () => {
  it("shows exact stored scope and never offers runtime controls", () => {
    const html = renderToString(
      <ApprovedActionScopeDetail agreement={agreement} onBack={() => {}} />
    );
    for (const value of [
      "Not active",
      "no change will run",
      "tasks.updateStatus",
      "target-id",
      "done",
      agreement.scope.dueAt,
      "Main conversation (main)"
    ])
      expect(html.replace(/<!-- -->/g, "")).toContain(value);
    for (const label of [">Resume<", ">Pause<", ">Delete task<", ">Edit<"])
      expect(html).not.toContain(label);
    expect(html).toContain("Proof &lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
  it("uses a separate explicitly inactive section", () => {
    expect(
      renderToString(<ApprovedActionScopes scopes={[agreement]} onSelect={() => {}} />)
    ).toContain("Approved changes - not active");
    expect(renderToString(<ApprovedActionScopes scopes={[]} onSelect={() => {}} />)).toBe("");
  });
});
