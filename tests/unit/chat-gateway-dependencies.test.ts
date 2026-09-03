import { describe, it, expect, vi } from "vitest";
import { buildChatGatewayDependencies } from "../../packages/chat/src/routes.js";
import type { PreferencesPort, DataContextRunner } from "@moss/db";
import { DEFAULT_LOCALE_SETTINGS } from "@moss/shared";
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

describe("buildChatGatewayDependencies → resolveLocalTimezone (#2157)", () => {
  const runner = {
    withDataContext: async (_ctx: unknown, fn: (db: unknown) => unknown) => fn({})
  } as unknown as DataContextRunner;

  function build(localeRow: unknown) {
    const localePreferences = {
      get: vi.fn(async (_db: unknown, key: string) => (key === "locale" ? localeRow : undefined))
    } as unknown as PreferencesPort;
    return buildChatGatewayDependencies({
      resolveActiveModules: async () => [],
      repository: {} as AiRepository,
      runner,
      tokens: {} as SessionTokenRegistry,
      confirmations: {} as ConfirmationRegistry,
      notifier: {} as SessionNotifier,
      localePreferences,
      collaborators: {}
    });
  }

  it("returns the actor's stored timezone", async () => {
    const deps = build({ timezone: "Europe/Berlin", region: "de-DE", dateFormat: "24" });
    await expect(deps.resolveLocalTimezone!("user1")).resolves.toBe("Europe/Berlin");
  });

  it("falls back to the same default GET /api/me/locale shows when nothing is stored", async () => {
    // Live defect: Settings showed America/Los_Angeles (route default) while the clock tool got
    // a blank context and answered in UTC. Both must agree.
    const deps = build(undefined);
    await expect(deps.resolveLocalTimezone!("user1")).resolves.toBe(
      DEFAULT_LOCALE_SETTINGS.timezone
    );
  });

  it("ignores an invalid stored zone instead of leaking it into tool context", async () => {
    const deps = build({ timezone: "Not/AZone" });
    await expect(deps.resolveLocalTimezone!("user1")).resolves.toBe(
      DEFAULT_LOCALE_SETTINGS.timezone
    );
  });

  it("is left unwired when no locale port is provided", () => {
    const deps = buildChatGatewayDependencies({
      resolveActiveModules: async () => [],
      repository: {} as AiRepository,
      runner,
      tokens: {} as SessionTokenRegistry,
      confirmations: {} as ConfirmationRegistry,
      notifier: {} as SessionNotifier,
      collaborators: {}
    });
    expect(deps.resolveLocalTimezone).toBeUndefined();
  });
});
