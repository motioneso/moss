import { expect, it } from "vitest";

import { ConfirmationRegistry } from "../../packages/ai/src/gateway/confirmation-registry.js";
import type { GatewaySessionRecord } from "../../packages/ai/src/gateway/types.js";

it("restores owner-bound approval only when a live request regains its complete disclosure", async () => {
  const registry = new ConfirmationRegistry();
  const complete: Extract<GatewaySessionRecord, { kind: "action_request" }> = {
    kind: "action_request",
    actionRequestId: "live-request",
    toolName: "notes.write_note",
    summary: "Save note",
    outcomeTitle: "Save note",
    details: {
      presentation: "human",
      target: "New note",
      fields: [{ label: "Content", value: "Approve note creation" }]
    },
    outsideContentNotice: false
  };
  const waiting = registry.awaitResolution(complete.actionRequestId, 10_000);
  try {
    registry.storePresentation("owner", complete);
    expect(registry.getPresentation("owner", complete.actionRequestId)).toEqual(complete);

    registry.storePresentation("owner", {
      kind: complete.kind,
      actionRequestId: complete.actionRequestId,
      toolName: complete.toolName,
      summary: complete.summary,
      outsideContentNotice: false
    });
    expect(registry.isAwaiting(complete.actionRequestId)).toBe(true);
    expect(registry.getPresentation("owner", complete.actionRequestId)).toBeUndefined();

    registry.storePresentation("owner", complete);
    expect(registry.getPresentation("owner", complete.actionRequestId)).toEqual(complete);
    expect(registry.getPresentation("other-owner", complete.actionRequestId)).toBeUndefined();
    registry.storePresentation("owner", { ...complete, actionRequestId: "orphan-request" });
    expect(registry.getPresentation("owner", "orphan-request")).toBeUndefined();
  } finally {
    registry.resolve(complete.actionRequestId, "rejected");
    await expect(waiting).resolves.toBe("rejected");
  }
  expect(registry.getPresentation("owner", complete.actionRequestId)).toBeUndefined();
});
