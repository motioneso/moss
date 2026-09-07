import { describe, expect, it, vi } from "vitest";

import { AssistantToolGateway, ConfirmationRegistry, SessionTokenRegistry } from "@moss/ai";
import { resolvePolicy } from "../../packages/ai/src/gateway/policy.js";
import { assertBuiltInSelfOperationManifests } from "../../packages/ai/src/gateway/self-operation.js";
import { workshopModuleManifest } from "../../packages/workshop/src/manifest.js";
import type { MossModuleManifest } from "@moss/module-sdk";

/**
 * Fable ruling on 2418, part 1: a build command always raises its card while
 * it is not boxed in. Both proofs run the real decision code, not a copy of
 * its logic: the highest tier a person can choose, and unattended mode on,
 * must each come back "ask", never "run".
 */
describe("workshop build card is mandatory", () => {
  const family = workshopModuleManifest.assistantActionFamilies.find(
    (entry) => entry.id === "workshop_builds"
  );
  const tool = workshopModuleManifest.assistantTools.find(
    (entry) => entry.name === "workshop.runCommand"
  );
  if (!family || !tool) throw new Error("workshop build family or tool missing from manifest");

  it("passes the boot manifest assertion that crashed the server once", () => {
    // Removing the run-automatically tier while declaring user_promotable
    // crashed boot (the grant promises promotability the family no longer
    // offers). confirm_always is the honest grant; this runs the same
    // assertion boot runs over the real manifest.
    expect(tool.selfOperationGrant).toBe("confirm_always");
    expect(() => assertBuiltInSelfOperationManifests([workshopModuleManifest])).not.toThrow();
  });

  it("resolvePolicy confirms even at the highest tier a person can choose", async () => {
    // The family offers no trusted_auto, so there is nothing to promote to.
    expect(family.allowedTiers).not.toContain("trusted_auto");
    const decision = await resolvePolicy(tool, "workshop", false, {
      // A stored trusted_auto from before the removal must not matter: the
      // family manifest gates it, not the stored value.
      getFamilyTier: async () => "trusted_auto",
      getFamilyManifest: async () => family
    });
    expect(decision).toBe("confirm");
  });

  it("unattended mode still raises the card instead of running", async () => {
    let executed = false;
    const module: MossModuleManifest = {
      id: "workshop",
      name: "Workshop",
      version: "0.1.0",
      publisher: "Moss",
      lifecycle: "required",
      compatibility: { jarv1s: "*" },
      assistantTools: [
        {
          ...tool,
          execute: async () => {
            executed = true;
            return { data: { ok: true } };
          }
        } as never
      ]
    };
    const capture = { emitted: [] as unknown[], created: [] as unknown[] };
    const tokens = new SessionTokenRegistry();
    const confirmations = new ConfirmationRegistry();
    const gateway = new AssistantToolGateway({
      resolveActiveModules: async () => [module],
      repository: {
        createPendingAssistantAction: async (_db: unknown, input: unknown) => {
          capture.created.push(input);
          return { id: "action-1" };
        }
      } as never,
      runner: {
        withDataContext: async (_access: unknown, work: (db: unknown) => Promise<unknown>) =>
          work({})
      } as never,
      tokens,
      confirmations,
      notifier: { emit: (_chatSessionId, record) => capture.emitted.push(record) },
      confirmTimeoutMs: 1000,
      toolServices: { workshopRunCommand: {} },
      yoloMode: async () => true,
      actionPolicy: () => ({
        getFamilyTier: async () => "trusted_auto",
        getFamilyManifest: async () => family
      })
    });
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });

    const pending = gateway.callTool(token, "workshop.runCommand", { command: "echo hi" });
    await vi.waitFor(() =>
      expect(capture.emitted.some((r) => (r as { kind: string }).kind === "action_request")).toBe(
        true
      )
    );
    // The card went out and the command did not run: unattended mode asked.
    expect(capture.created).toHaveLength(1);
    expect(executed).toBe(false);
    confirmations.resolve("action-1", "rejected");
    await pending;
  });
});
