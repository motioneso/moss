import { describe, expect, it, vi } from "vitest";
import type { ModuleAssistantToolManifest } from "@moss/module-sdk";

import { approvalOutcomeTitle } from "../../packages/ai/src/gateway/approval-outcome-title.js";
import {
  summarizeDeleteEvent,
  summarizeRescheduleEvent
} from "../../packages/calendar/src/tools.js";
import {
  admissionFixture,
  admissionTool,
  rejectAdmissionCard
} from "./helpers/gateway-admission-fixture.js";

describe("ordinary module approval titles", () => {
  it.each([
    {
      name: "calendar.deleteEvent",
      summarize: summarizeDeleteEvent,
      input: Object.freeze({ displayTitle: "Design review", displayWhen: "tomorrow at 3pm" }),
      title: 'Delete "Design review" (tomorrow at 3pm) from your calendar?'
    },
    {
      name: "calendar.rescheduleEvent",
      summarize: summarizeRescheduleEvent,
      input: Object.freeze({ displayTitle: "Project kickoff", displayWhen: "Friday at 10am" }),
      title: 'Move "Project kickoff" to Friday at 10am?'
    }
  ])("projects the actual $name card into a frozen plain title", async (example) => {
    const summarize = vi.fn(example.summarize);
    const tool = admissionTool(example.name, {
      risk: "destructive",
      summarize,
      inputSchema: {
        type: "object",
        properties: { displayTitle: { type: "string" }, displayWhen: { type: "string" } }
      }
    });
    const h = admissionFixture([tool]);
    const pending = h.gateway.callTool(h.token, tool.name, example.input);
    await vi.waitFor(() => expect(h.records).toHaveLength(1));
    const request = h.records[0];
    expect(request?.kind).toBe("action_request");
    if (request?.kind !== "action_request") throw new Error("Expected an approval card");
    expect(request.summary).toContain(`**"${example.input.displayTitle}"**`);
    expect(request.outcomeTitle).toContain(example.title);
    expect(request.outcomeTitle).not.toContain("**");
    summarize.mockReturnValue("A later summary must not replace the approved title");
    h.confirmations.resolve("action-1", "confirmed");
    expect(await pending).toMatchObject({ ok: true });
    expect(h.records[1]).toMatchObject({
      kind: "action_result",
      actionRequestId: "action-1",
      summary: request.outcomeTitle,
      outcome: "executed"
    });
    expect(summarize).toHaveBeenCalledOnce();
    expect(Object.isFrozen(example.input)).toBe(true);
  });

  it("freezes distinct server summaries for two approvals and keeps the exact decline", async () => {
    const summarize = vi
      .fn()
      .mockReturnValueOnce("Rename your morning meeting")
      .mockReturnValueOnce("Rename your afternoon meeting")
      .mockReturnValue("A later title must not replace either card");
    const execute = vi.fn(async () => ({ data: { changed: true } }));
    const tool = admissionTool("calendar.renameMeeting", {
      risk: "destructive",
      summarize,
      execute
    });
    const h = admissionFixture([tool]);
    let nextAction = 0;
    h.createPending.mockImplementation(async () => ({ id: `action-${++nextAction}` }));

    const first = h.gateway.callTool(h.token, tool.name, {});
    await vi.waitFor(() => expect(h.records).toHaveLength(1));
    const second = h.gateway.callTool(h.token, tool.name, {});
    await vi.waitFor(() => expect(h.records).toHaveLength(2));
    expect(h.records).toMatchObject([
      {
        kind: "action_request",
        actionRequestId: "action-1",
        summary: "Rename your morning meeting",
        outcomeTitle: "Rename your morning meeting"
      },
      {
        kind: "action_request",
        actionRequestId: "action-2",
        summary: "Rename your afternoon meeting",
        outcomeTitle: "Rename your afternoon meeting"
      }
    ]);

    h.confirmations.resolve("action-1", "confirmed");
    expect(await first).toMatchObject({ ok: true });
    h.confirmations.resolve("action-2", "rejected");
    expect(await second).toMatchObject({
      ok: false,
      denied: true,
      reason: expect.stringContaining("Do not try it again")
    });
    expect(h.records.slice(2)).toMatchObject([
      {
        kind: "action_result",
        actionRequestId: "action-1",
        summary: "Rename your morning meeting",
        outcome: "executed",
        decidedBy: "person"
      },
      {
        kind: "action_result",
        actionRequestId: "action-2",
        summary: "Rename your afternoon meeting",
        outcome: "denied",
        decidedBy: "person",
        reason: "You declined this action."
      }
    ]);
    expect(summarize).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("uses an explicit human action label without requiring a summarize hook", async () => {
    const tool = admissionTool("calendar.renameMeeting", {
      risk: "destructive",
      actionLabel: "Rename your meeting"
    });
    const h = admissionFixture([tool]);
    const pending = h.gateway.callTool(h.token, tool.name, {});
    await rejectAdmissionCard(h, pending);
    expect(h.records[0]).toMatchObject({ outcomeTitle: "Rename your meeting" });
    expect(h.records[1]).toMatchObject({ summary: "Rename your meeting", outcome: "denied" });
  });

  it.each([
    undefined,
    "calendar.renameMeeting",
    "Rename meeting 44444444-4444-4444-8444-444444444444",
    "Rename meeting event-123",
    "Delete note projects/plans.md",
    "Update https://example.test/calendar",
    "Run rm -rf",
    "Move **your meeting"
  ])("omits unsuitable outcome title %s without changing pending disclosure", async (summary) => {
    const tool = admissionTool("calendar.renameMeeting", {
      risk: "destructive",
      ...(summary === undefined ? {} : { summarize: () => summary })
    });
    const h = admissionFixture([tool]);
    const pending = h.gateway.callTool(h.token, tool.name, {});
    await rejectAdmissionCard(h, pending);
    expect(h.records[0]).toMatchObject({
      kind: "action_request",
      summary: summary ?? tool.name
    });
    expect(h.records[0]).not.toHaveProperty("outcomeTitle");
    expect(h.records[1]).not.toHaveProperty("summary");
    expect(h.records[1]).toMatchObject({ outcome: "denied", decidedBy: "person" });
    expect(tool.execute).not.toHaveBeenCalled();
  });
});

describe("plain approval title projection", () => {
  const tool: Pick<ModuleAssistantToolManifest, "name" | "summarize" | "actionLabel"> = {
    name: "example.change",
    summarize: () => "unused"
  };

  it("normalizes and bounds only explicitly authored titles", () => {
    expect(approvalOutcomeTitle(tool, "  Rename\n your meeting  ")).toBe("Rename your meeting");
    expect(approvalOutcomeTitle(tool, `Rename ${"your meeting ".repeat(30)}`)).toHaveLength(200);
    expect(approvalOutcomeTitle({ name: "example.change" }, "Rename your meeting")).toBeUndefined();
  });

  it("removes only balanced bold delimiters before applying the technical-text gate", () => {
    expect(approvalOutcomeTitle(tool, 'Move **"your meeting"** to **Friday**')).toBe(
      'Move "your meeting" to Friday'
    );
    for (const summary of [
      "Move ***your meeting***",
      "Open **[settings](https://example.test)**",
      "Edit **projects/plans.md**",
      "Delete **44444444-4444-4444-8444-444444444444**",
      "Run **`command`**"
    ]) {
      expect(approvalOutcomeTitle(tool, summary)).toBeUndefined();
    }
  });

  it.each([
    "",
    "example.change",
    "Change example.change",
    "Rename event_123",
    "Change 01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "Edit C:\\notes\\plan.md",
    "Read mailto:person@example.test",
    "Run command --force",
    "Write key=value",
    "Run `command`",
    "Open <b>settings</b>"
  ])("drops technical or non-plain text %s", (summary) => {
    expect(approvalOutcomeTitle(tool, summary)).toBeUndefined();
  });
});
