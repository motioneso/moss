import { describe, expect, it, vi } from "vitest";
import {
  approvalBoolean,
  approvalChoice,
  approvalText,
  presentApprovalFields
} from "@moss/module-sdk";
import {
  completeActionPresentation,
  preparePendingPresentation,
  runPresentedAction
} from "../../packages/ai/src/gateway/pending-presentation.js";
import type { ExecutableTool } from "../../packages/ai/src/gateway/run-tool-handler.js";
import type { GatewaySessionRecord } from "../../packages/ai/src/gateway/types.js";
import { ConfirmationRegistry } from "../../packages/ai/src/gateway/confirmation-registry.js";

type Card = Extract<GatewaySessionRecord, { kind: "action_request" }>;
const details = {
  presentation: "human" as const,
  target: "Long\nexact target",
  fields: [{ label: "Text", value: "" }]
};
const card: Card = {
  kind: "action_request",
  actionRequestId: "request",
  toolName: "test.write",
  summary: "Change settings",
  outcomeTitle: "Change settings",
  outsideContentNotice: false,
  details
};

describe("exhaustive authored approval fields", () => {
  const declarations = {
    text: { label: "Message", present: approvalText },
    enabled: { label: "Enabled", present: approvalBoolean }
  };
  it("preserves complete submitted strings and intentional empty values", () => {
    const text = "  First\n" + "<script>literal</script> ".repeat(1000);
    expect(presentApprovalFields({ text, enabled: false }, declarations)).toEqual([
      { label: "Message", value: text },
      { label: "Enabled", value: "No" }
    ]);
    expect(presentApprovalFields({ text: "" }, declarations)).toEqual([
      { label: "Message", value: "" }
    ]);
  });
  it.each([{ hiddenId: "private" }, { text: { hidden: "private" } }, null, [], "body"])(
    "rejects undisclosed input %j",
    (value) => {
      expect(presentApprovalFields(value, declarations)).toBeNull();
    }
  );
  it("requires every declared mandatory key and validates enums without inherited keys", () => {
    expect(presentApprovalFields({}, declarations, ["text"])).toBeNull();
    expect(approvalChoice({ metric: "Metric" })("toString")).toBeNull();
    expect(presentApprovalFields(JSON.parse('{"__proto__":"value"}'), {})).toBeNull();
    expect(
      presentApprovalFields({ value: true }, { value: { label: "Value", present: () => [] } })
    ).toBeNull();
  });
  it("allows bodyless actions only for an actually empty input", () => {
    expect(presentApprovalFields(undefined, {})).toEqual([]);
    expect(presentApprovalFields({}, {})).toEqual([]);
    expect(presentApprovalFields({ confirm: true }, {})).toBeNull();
  });
});

describe("server approval completeness", () => {
  it("accepts exact human disclosure including empty values", () =>
    expect(completeActionPresentation(card)).toBe(true));
  it.each([
    { details: undefined },
    { nativePermission: true, externalTool: true, exactArguments: "{}" },
    { outcomeTitle: undefined },
    { details: { ...details, presentation: undefined } },
    { details: { ...details, target: " " } },
    { details: { ...details, fields: [null] } },
    { details: { ...details, fields: [{ label: "", value: "secret" }] } },
    { details: { ...details, fields: [{ label: "Field", value: { secret: true } }] } },
    { details: { ...details, fields: null } },
    { outcomeTitle: 3 }
  ])("fails closed without throwing for malformed/legacy presentation %j", (patch) => {
    expect(completeActionPresentation({ ...card, ...patch } as unknown as Card)).toBe(false);
  });
  it("native permission uses a positive discriminator, never a path/title heuristic", () => {
    expect(completeActionPresentation({ summary: "Run /bin/echo hello" })).toBe(false);
    expect(
      completeActionPresentation({ summary: "Run /bin/echo hello", nativePermission: true })
    ).toBe(true);
  });
  it("keeps decline available while incomplete owner-bound records cannot approve", async () => {
    const registry = new ConfirmationRegistry();
    const waiting = registry.awaitResolution("request", 10000);
    registry.storePresentation("owner", { ...card, details: undefined });
    expect(registry.getPresentation("owner", "request")).toBeUndefined();
    expect(registry.getPresentation("other", "request")).toBeUndefined();
    registry.resolve("request", "rejected");
    await expect(waiting).resolves.toBe("rejected");
  });
  it("stores a clone and becomes approvable only with complete live details", async () => {
    const registry = new ConfirmationRegistry();
    const waiting = registry.awaitResolution("request", 10000);
    registry.storePresentation("owner", card);
    const read = registry.getPresentation("owner", "request")!;
    Object.assign(read.details!, { target: "forged" });
    expect(registry.getPresentation("owner", "request")?.details?.target).toBe(details.target);
    registry.resolve("request", "rejected");
    await waiting;
    expect(registry.getPresentation("owner", "request")).toBeUndefined();
  });
});

describe("approved hook recheck", () => {
  const approved = { details, version: "version-1" };
  const run = () =>
    vi.fn(async () => ({
      response: { ok: true as const, data: {} },
      audit: { outcome: "success" as const, durationMs: 0, errorClass: null }
    }));
  it("does not accept a blind confirmation even if a registry is signalled internally", async () => {
    const execute = run();
    expect((await runPresentedAction({}, "Change", async () => ({}), execute)).response.ok).toBe(
      false
    );
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { ...approved, version: "version-2" },
    { ...approved, details: { ...details, target: "different" } }
  ])("refuses missing or changed exact targets before execution", async (current) => {
    const execute = run();
    expect(
      (await runPresentedAction(approved, "Change", async () => current, execute)).response.ok
    ).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
  it("does not expose recheck exception text", async () => {
    const execute = run();
    const result = await runPresentedAction(
      approved,
      "Change",
      async () => {
        throw new Error("PRIVATE_ERROR");
      },
      execute
    );
    expect(JSON.stringify(result)).not.toContain("PRIVATE_ERROR");
    expect(execute).not.toHaveBeenCalled();
  });
  it("executes the unchanged complete disclosure once", async () => {
    const execute = run();
    expect(
      (await runPresentedAction(approved, "Change", async () => structuredClone(approved), execute))
        .response.ok
    ).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });
  it("never streams a hook's server-only version or unexpected fields", async () => {
    const found = {
      tool: {
        approvalPresentation: async () => ({
          target: "Target",
          fields: [],
          version: "hidden-id",
          hidden: "extra"
        })
      }
    } as unknown as ExecutableTool;
    const presentation = await preparePendingPresentation(
      { withDataContext: async (_access, work) => work({} as never) },
      { actorUserId: "owner" },
      found,
      {},
      { actorUserId: "owner", requestId: "request", chatSessionId: "session" },
      {}
    );
    expect(presentation).toEqual({
      details: { presentation: "human", target: "Target", fields: [] },
      version: "hidden-id",
      disclosureExternalContent: true
    });
    expect(presentation.details).not.toHaveProperty("version");
  });
});

describe("connected-tool exact argument fallback", () => {
  const ctx = { actorUserId: "owner", requestId: "request", chatSessionId: "session" };
  const runner = {
    withDataContext: async <T>(_access: unknown, work: (db: never) => Promise<T>) =>
      work({} as never)
  };
  it("preserves every nested argument and long string without truncation", async () => {
    const found = { tool: { isExternal: true } } as unknown as ExecutableTool;
    const input = {
      id: "opaque-reference",
      nested: { values: [1, null, false], content: "  <script>literal</script>\n".repeat(3000) }
    };
    const result = await preparePendingPresentation(
      runner,
      { actorUserId: "owner" },
      found,
      input,
      ctx,
      {}
    );
    expect(result.externalTool).toBe(true);
    expect(result.exactArguments).toBe(JSON.stringify(input, null, 2));
    expect(JSON.parse(result.exactArguments!)).toEqual(input);
    expect(
      completeActionPresentation({
        summary: "",
        externalTool: true,
        exactArguments: result.exactArguments
      })
    ).toBe(true);
  });
  it.each([{ omitted: undefined }, { nonFinite: Number.NaN }])(
    "refuses lossy serialization",
    async (input) => {
      const found = { tool: { isExternal: true } } as unknown as ExecutableTool;
      expect(
        await preparePendingPresentation(runner, { actorUserId: "owner" }, found, input, ctx, {})
      ).toEqual({});
    }
  );
  it("does not grant the fallback from tool name, summary or caller input", async () => {
    const found = { tool: { name: "external.write" } } as unknown as ExecutableTool;
    expect(
      await preparePendingPresentation(
        runner,
        { actorUserId: "owner" },
        found,
        { externalTool: true },
        ctx,
        {}
      )
    ).toEqual({});
    expect(completeActionPresentation({ summary: "Tool", exactArguments: "{}" })).toBe(false);
  });
});
