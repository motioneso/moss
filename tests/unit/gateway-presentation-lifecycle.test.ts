import { ApprovalInputError } from "@moss/module-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  admissionFixture,
  admissionTool,
  rejectAdmissionCard,
  resolvedCall
} from "./helpers/gateway-admission-fixture.js";
import { CONTEXT_ADMISSION_UNAVAILABLE } from "../../packages/ai/src/gateway/content-admission.js";

const tool = () =>
  admissionTool("example.write", {
    risk: "destructive",
    actionLabel: "Change example",
    approvalContent: undefined,
    approvalPresentation: async () => ({ target: "Server target", fields: [] })
  });

describe("approval preparation lifecycle", () => {
  it("cleans the waiter and persisted pending row if delivery throws", async () => {
    const h = admissionFixture([tool()], {
      deps: {
        notifier: {
          emit: () => {
            throw new Error("PRIVATE_FAILURE");
          }
        }
      }
    });
    const result = await h.gateway.callTool(h.token, "example.write", {});
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_FAILURE");
    expect(h.confirmations.isAwaiting("action-1")).toBe(false);
    expect(h.deps.repository.resolveAssistantAction).toHaveBeenCalledWith(
      expect.anything(),
      "action-1",
      { status: "cancelled" }
    );
  });
  it("creates no waiter or row when server summary normalization throws", async () => {
    const h = admissionFixture([
      {
        ...tool(),
        summarize: () => {
          throw new Error("PRIVATE_FAILURE");
        }
      }
    ]);
    expect((await h.gateway.callTool(h.token, "example.write", {})).ok).toBe(false);
    expect(h.createPending).not.toHaveBeenCalled();
    expect(h.confirmations.isAwaiting("action-1")).toBe(false);
  });
  it("admits display content independently of a user-authored result declaration", async () => {
    const h = admissionFixture([tool()]);
    const pending = h.gateway.callTool(h.token, "example.write", {});
    await vi.waitFor(() => expect(h.records).toHaveLength(1));
    expect(h.recordAdmission).toHaveBeenCalledExactlyOnceWith(
      "actor-a",
      "thread-a",
      "tool_external_content"
    );
    expect(h.records[0]).toMatchObject({
      outsideContentNotice: true,
      details: { presentation: "human" }
    });
    await rejectAdmissionCard(h, pending);
  });
  it("withholds target display and card if disclosure admission fails", async () => {
    const presentation = vi.fn(async () => ({ target: "PRIVATE_TARGET", fields: [] }));
    const h = admissionFixture([{ ...tool(), approvalPresentation: presentation }]);
    h.recordAdmission.mockRejectedValue(new Error("PRIVATE_FAILURE"));
    expect(await h.gateway.callTool(h.token, "example.write", {})).toEqual({
      ok: false,
      error: CONTEXT_ADMISSION_UNAVAILABLE
    });
    expect(presentation).toHaveBeenCalledOnce();
    expect(h.records).toEqual([]);
    expect(h.createPending).not.toHaveBeenCalled();
  });
  it("keeps explicitly user-authored disclosures clean", async () => {
    const h = admissionFixture([{ ...tool(), approvalContent: "user_authored" }]);
    const pending = h.gateway.callTool(h.token, "example.write", {});
    await rejectAdmissionCard(h, pending);
    expect(h.recordAdmission).not.toHaveBeenCalled();
    expect(h.records[0]).toMatchObject({ outsideContentNotice: false });
  });
  it("admits generic target text while leaving result classification unchanged", async () => {
    const h = admissionFixture([admissionTool("app.callAction", { risk: "write" })], {
      deps: {
        perCallResolvers: {
          "app.callAction": async () =>
            resolvedCall({
              forceConfirm: true,
              externalContent: false,
              disclosureExternalContent: true
            })
        }
      }
    });
    const pending = h.gateway.callTool(h.token, "app.callAction", {});
    await rejectAdmissionCard(h, pending);
    expect(h.recordAdmission).toHaveBeenCalledExactlyOnceWith(
      "actor-a",
      "thread-a",
      "app_action_outside"
    );
  });
  it("does not use presentation lookups to taint clean automatic calls", async () => {
    const h = admissionFixture([admissionTool("app.callAction", { risk: "write" })], {
      deps: {
        perCallResolvers: {
          "app.callAction": async () =>
            resolvedCall({ externalContent: false, disclosureExternalContent: true })
        }
      }
    });
    expect((await h.gateway.callTool(h.token, "app.callAction", {})).ok).toBe(true);
    expect(h.recordAdmission).not.toHaveBeenCalled();
    expect(h.records.every((record) => record.kind !== "action_request")).toBe(true);
  });
  it("snapshots nested caller input before holding for external approval", async () => {
    const execute = vi.fn(async () => ({ data: { done: true } }));
    const h = admissionFixture([
      admissionTool("connected.write", {
        risk: "destructive",
        isExternal: true,
        actionLabel: undefined,
        approvalPresentation: undefined,
        execute
      })
    ]);
    const input = { nested: { value: "original" } };
    const pending = h.gateway.callTool(h.token, "connected.write", input);
    await vi.waitFor(() => expect(h.records).toHaveLength(1));
    expect(h.records[0]).toMatchObject({
      externalTool: true,
      exactArguments: JSON.stringify(input, null, 2)
    });
    input.nested.value = "replaced";
    h.confirmations.resolve("action-1", "confirmed");
    expect((await pending).ok).toBe(true);
    expect(execute).toHaveBeenCalledWith(
      expect.anything(),
      { nested: { value: "original" } },
      expect.anything(),
      expect.anything()
    );
  });
});

it("freezes a server-authored dynamic title and refuses a changed title before dispatch", async () => {
  let title = "Overwrite note";
  const execute = vi.fn(async () => ({ data: { changed: true } }));
  const h = admissionFixture([
    admissionTool("example.write", {
      risk: "destructive",
      actionLabel: "Create note",
      approvalContent: "user_authored",
      approvalPresentation: async () => ({ title, target: "today.md", fields: [] }),
      execute
    })
  ]);
  const pending = h.gateway.callTool(h.token, "example.write", {});
  await vi.waitFor(() => expect(h.records).toHaveLength(1));
  expect(h.records[0]).toMatchObject({ outcomeTitle: "Overwrite note" });
  title = "Create note";
  h.confirmations.resolve("action-1", "confirmed");
  expect(await pending).toMatchObject({ ok: false });
  expect(execute).not.toHaveBeenCalled();
  expect(h.records[1]).toMatchObject({ outcome: "error", summary: "Overwrite note" });
});

it("returns dedicated typed state validation before any pending row or execution", async () => {
  const execute = vi.fn(async () => ({ data: {} }));
  const h = admissionFixture([
    admissionTool("example.write", {
      risk: "destructive",
      actionLabel: "Save plan",
      approvalPresentation: async () => {
        throw new ApprovalInputError("Keep placed calendar blocks in the draft before saving.");
      },
      execute
    })
  ]);
  expect(await h.gateway.callTool(h.token, "example.write", {})).toMatchObject({
    ok: true,
    structuredData: {
      ok: false,
      status: 400,
      body: { error: "Keep placed calendar blocks in the draft before saving." }
    }
  });
  expect(h.createPending).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
  expect(h.records).toMatchObject([
    { kind: "action_result", outcome: "error", summary: "Save plan", reason: "invalid_input" }
  ]);
});
