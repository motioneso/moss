import { describe, it, expect, vi } from "vitest";
import {
  buildBackgroundReadGatewayDependencies,
  buildChatGatewayDependencies
} from "../../packages/chat/src/routes.js";
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

describe("buildChatGatewayDependencies → resolveLocale (#2157, #3394)", () => {
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

  it("returns the actor's stored locale", async () => {
    const deps = build({ timezone: "Europe/Berlin", region: "de-DE", dateFormat: "12" });
    await expect(deps.resolveLocale!("user1")).resolves.toEqual({
      timezone: "Europe/Berlin",
      region: "de-DE",
      dateFormat: "12"
    });
  });

  it("falls back to the same default GET /api/me/locale shows when nothing is stored", async () => {
    // Live defect: Settings showed America/Los_Angeles (route default) while the clock tool got
    // a blank context and answered in UTC. Both must agree.
    const deps = build(undefined);
    await expect(deps.resolveLocale!("user1")).resolves.toEqual(DEFAULT_LOCALE_SETTINGS);
  });

  it("ignores an invalid stored zone instead of leaking it into tool context", async () => {
    const deps = build({ timezone: "Not/AZone" });
    await expect(deps.resolveLocale!("user1")).resolves.toMatchObject({
      timezone: DEFAULT_LOCALE_SETTINGS.timezone
    });
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
    expect(deps.resolveLocale).toBeUndefined();
  });
});

describe("buildBackgroundReadGatewayDependencies → resolveLocale (#3819)", () => {
  const runner = {
    withDataContext: async (_ctx: unknown, fn: (db: unknown) => unknown) => fn({})
  } as unknown as DataContextRunner;

  function build(localeRow: unknown) {
    const localePreferences = {
      get: vi.fn(async (_db: unknown, key: string) => (key === "locale" ? localeRow : undefined))
    } as unknown as PreferencesPort;
    return buildBackgroundReadGatewayDependencies({
      resolveActiveModules: async () => [],
      repository: {} as AiRepository,
      runner,
      tokens: {} as SessionTokenRegistry,
      confirmations: {} as ConfirmationRegistry,
      notifier: {} as SessionNotifier,
      localePreferences
    });
  }

  it("gives a background read the owner's stored zone instead of falling back to UTC", async () => {
    const deps = build({ timezone: "Europe/Berlin", region: "de-DE", dateFormat: "12" });
    await expect(deps.resolveLocale!("user1")).resolves.toMatchObject({
      timezone: "Europe/Berlin"
    });
  });

  it("uses the same default zone Settings shows when nothing is stored", async () => {
    // A heartbeat source read called with no local timezone used to treat the day as UTC,
    // which can move an overdue item by a day.
    const deps = build(undefined);
    await expect(deps.resolveLocale!("user1")).resolves.toEqual(DEFAULT_LOCALE_SETTINGS);
  });
});

describe("buildChatGatewayDependencies → webSearchEngineForActor (#2228)", () => {
  const base = {
    resolveActiveModules: async () => [],
    repository: {} as AiRepository,
    runner: {} as DataContextRunner,
    tokens: {} as SessionTokenRegistry,
    confirmations: {} as ConfirmationRegistry,
    notifier: {} as SessionNotifier,
    collaborators: {}
  };

  it("passes the composition root's engine resolver through to the gateway", async () => {
    const webSearchEngineForActor = vi.fn(async () => "model-native" as const);
    const deps = buildChatGatewayDependencies({ ...base, webSearchEngineForActor });
    await expect(deps.webSearchEngineForActor!("user1")).resolves.toBe("model-native");
    expect(webSearchEngineForActor).toHaveBeenCalledWith("user1");
  });

  it("leaves the gateway dependency unset when the root injects nothing", () => {
    const deps = buildChatGatewayDependencies(base);
    expect(deps.webSearchEngineForActor).toBeUndefined();
  });
});
