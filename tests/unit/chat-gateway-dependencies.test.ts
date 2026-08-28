import { describe, it, expect, vi } from "vitest";
import { buildChatGatewayDependencies } from "../../packages/chat/src/routes.js";
import type { PreferencesPort, DataContextRunner } from "@moss/db";
import type { AiRepository } from "../../packages/ai/src/repository.js";
import type {
  SessionTokenRegistry,
  ConfirmationRegistry,
  SessionNotifier,
  PlatformDiagnosticsService
} from "@moss/ai";

describe("buildChatGatewayDependencies", () => {
  it("wires preferences to actionPolicy (regression for production legacy-only pref)", async () => {
    const preferences: PreferencesPort = {
      get: vi.fn(async (key) => {
        if (key === "tasks.agency_auto_execute") return true;
        return undefined;
      }),
      getWithMetadata: vi
        .fn()
        .mockImplementation(
          async (
            _db: unknown,
            key: string
          ): Promise<{ value: unknown; updatedAt: Date } | null> => {
            if (key === "tasks.agency_auto_execute") return { value: true, updatedAt: new Date() };
            return null;
          }
        )
    } as unknown as PreferencesPort;

    const deps = buildChatGatewayDependencies({
      resolveActiveModules: async () => [],
      repository: {} as AiRepository,
      runner: {} as DataContextRunner,
      tokens: {} as SessionTokenRegistry,
      confirmations: {} as ConfirmationRegistry,
      notifier: {} as SessionNotifier,
      agencyPreferences: preferences,
      collaborators: {}
    });

    expect(deps.actionPolicy).toBeDefined();
    expect(deps.readToolTrustBoundary).toBeDefined();

    const mockRepo = {
      getActionPolicyTier: vi.fn().mockResolvedValue(undefined)
    } as unknown as AiRepository;

    const depsWithRepo = buildChatGatewayDependencies({
      resolveActiveModules: async () => [],
      repository: mockRepo,
      runner: {
        withDataContext: async (_ctx: unknown, fn: (db: unknown) => unknown) => fn({})
      } as unknown as DataContextRunner,
      tokens: {} as SessionTokenRegistry,
      confirmations: {} as ConfirmationRegistry,
      notifier: {} as SessionNotifier,
      agencyPreferences: preferences,
      collaborators: {}
    });

    const actionPolicyFactory = depsWithRepo.actionPolicy as (ctx: unknown) => {
      getFamilyTier: (moduleId: string, familyId: string) => Promise<string | null>;
    };
    const policy = actionPolicyFactory({ actorUserId: "user1", requestId: "req1" });
    const tier = await policy.getFamilyTier("tasks", "task_changes");
    expect(tier).toBe("trusted_auto");
    expect(preferences.getWithMetadata).toHaveBeenCalledWith(
      expect.anything(),
      "tasks.agency_auto_execute"
    );
  });

  it("keeps platform diagnostics in the read service bag", () => {
    const platformDiagnostics = {} as PlatformDiagnosticsService;
    const deps = buildChatGatewayDependencies({
      resolveActiveModules: async () => [],
      repository: {} as AiRepository,
      runner: {} as DataContextRunner,
      tokens: {} as SessionTokenRegistry,
      confirmations: {} as ConfirmationRegistry,
      notifier: {} as SessionNotifier,
      platformDiagnostics,
      collaborators: {}
    });

    expect(deps.readToolServices).toMatchObject({ platformDiagnostics });
    expect(deps.toolServices).not.toHaveProperty("platformDiagnostics");
  });
});
