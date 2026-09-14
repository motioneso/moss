/** Shared fake-deps harness for the briefings-compose unit suites. */
import type { AiRepository, AiSecretCipher } from "@moss/ai";
import type { BriefingDefinition, DataContextDb } from "@moss/db";
import type { MemoryRetriever } from "@moss/memory";
import type { MossModuleManifest, ToolExecute, ToolResult } from "@moss/module-sdk";
import type { FocusSignalInput, PriorityModelPreferenceV1 } from "@moss/priority";
import type { DayPlanDto } from "@moss/shared";

import {
  type ComposeDeps,
  type ComposeRunInput,
  type GenerateChatFn
} from "../../packages/briefings/src/compose.js";

export const fakeScopedDb = {} as DataContextDb;

export const FIXED_NOW = new Date("2026-06-13T12:00:00.000Z");

export function definition(overrides: Partial<BriefingDefinition> = {}): BriefingDefinition {
  return {
    id: "def-1",
    owner_user_id: "owner-1",
    title: "Morning",
    briefing_type: "morning",
    cadence: "daily",
    // UTC so the fixed-now local-day filter is trivially satisfied by the canned dates.
    schedule_metadata: { targetTime: "06:00", timezone: "UTC" },
    enabled: true,
    selected_tool_names: [
      "commitments.listVisible",
      "tasks.list",
      "calendar.listVisibleEvents",
      "email.listVisibleMessages",
      "vault",
      "chat.listTodaysTurns"
    ],
    last_run_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides
  } as BriefingDefinition;
}

export const runInput: ComposeRunInput = {
  runKind: "manual",
  runId: "run-1",
  now: FIXED_NOW
};

// Canned per-tool data keyed by the tool name compose calls. Day-bounded sources
// (calendar/chats) use FIXED_NOW's UTC date so withinLocalDay keeps them.
export const TODAY_ISO = "2026-06-13T09:00:00.000Z";

export function cannedToolData(toolName: string): Record<string, unknown> {
  switch (toolName) {
    case "commitments.listVisible":
      return { commitments: [{ title: "Pay invoice", status: "open", dueAt: null }] };
    case "tasks.list":
      return { items: [{ title: "Write report", status: "todo" }] };
    case "calendar.listVisibleEvents":
      return {
        events: [
          {
            id: "evt-1",
            startsAt: TODAY_ISO,
            endsAt: "2026-06-13T10:00:00.000Z",
            title: "Client review"
          }
        ],
        accounts: [
          {
            account: {
              connectorAccountId: "conn-cal-1",
              providerId: "google",
              providerLabel: "Google Calendar"
            },
            source: "live",
            degradedReason: null
          }
        ],
        gaps: []
      };
    case "email.listVisibleMessages":
      return {
        messages: [
          {
            id: "msg-1",
            connectorAccountId: "conn-email-1",
            sender: "boss@x.com",
            subject: "Re: budget",
            snippet: "Can you reply today?",
            actionability: "needs_reply",
            importance: "normal",
            confidence: 0.9,
            source: "live"
          }
        ],
        accounts: [
          {
            account: {
              connectorAccountId: "conn-email-1",
              providerId: "google",
              providerLabel: "Gmail"
            },
            source: "live",
            degradedReason: null
          }
        ],
        gaps: []
      };
    case "chat.listTodaysTurns":
      return {
        turns: [{ role: "user", excerpt: "what's up", threadTitle: "T", createdAt: TODAY_ISO }]
      };
    case "sports.followedFactsToday":
      return {
        facts: [{ competitionKey: "nfl", text: "Cowboys play tonight 7:20pm" }],
        evidence: {
          version: 1,
          capturedAt: FIXED_NOW.toISOString(),
          degraded: false,
          state: "tonight",
          ambiguousFollowCount: 0,
          games: [
            {
              id: "g1",
              competitionKey: "nfl",
              startsAt: "2026-06-13T23:20:00.000Z",
              phase: "tonight",
              statusDetail: "7:20 PM",
              headline: "Cowboys play tonight",
              homeShort: "DAL",
              awayShort: "MIN",
              homeScore: null,
              awayScore: null
            }
          ],
          stories: []
        }
      };
    case "news.topHeadlinesToday":
      return {
        facts: [{ competitionKey: "news", text: "Markets rally — Wire" }],
        evidence: {
          version: 1,
          capturedAt: FIXED_NOW.toISOString(),
          degraded: false,
          stories: [
            {
              id: "s1",
              title: "Markets rally",
              sourceLabel: "Wire",
              sourceKey: "wire",
              url: "https://example.com/markets",
              publishedAt: "2026-06-13T10:00:00.000Z",
              summary: "Markets rose on calm trading.",
              imageUrl: null
            }
          ]
        }
      };
    default:
      return {};
  }
}

export interface FakeOptions {
  readonly generateChat?: GenerateChatFn;
  readonly credentialPayload?: Record<string, unknown>;
  /** Tool name whose execute throws, to exercise the gaps path. */
  readonly failTool?: string;
  /** Omit a model so compose takes the degraded "no_model" fallback. */
  readonly noModel?: boolean;
  readonly personaPreference?: unknown;
  readonly priorityModel?: PriorityModelPreferenceV1;
  readonly focusReadiness?: readonly FocusSignalInput[];
  readonly userName?: string;
  readonly disabledBehaviors?: ReadonlySet<string>;
  readonly preferences?: Readonly<Record<string, unknown>>;
  /**
   * Saved day plan for the run's local day. Present (even with plan undefined)
   * injects the `dayPlanRead` port; absent leaves it out entirely. `throws`
   * makes the port reject to exercise the gap path.
   */
  readonly dayPlan?: {
    readonly plan?: DayPlanDto;
    readonly throws?: boolean;
  };
}

export function makeFakeManifests(failTool?: string): MossModuleManifest[] {
  const toolNames = [
    "commitments.listVisible",
    "tasks.list",
    "calendar.listVisibleEvents",
    "email.listVisibleMessages",
    "chat.listTodaysTurns",
    "sports.followedFactsToday",
    "news.topHeadlinesToday"
  ];
  const assistantTools = toolNames.map((name) => {
    const execute: ToolExecute = async (): Promise<ToolResult> => {
      if (name === failTool) {
        throw new Error("boom");
      }
      return { data: cannedToolData(name) };
    };
    return {
      name,
      description: name,
      permissionId: "x.view",
      risk: "read" as const,
      inputSchema: { type: "object", properties: {} },
      execute
    };
  });
  return [
    {
      id: "fake",
      name: "Fake",
      version: "0.0.0",
      publisher: "test",
      lifecycle: "required",
      compatibility: { jarv1s: ">=0.0.0" },
      assistantTools,
      sourceBehaviors: [
        {
          id: "calendar",
          name: "Calendar",
          description: "Calendar source",
          behaviors: [
            {
              id: "calendar.briefings",
              name: "Include in briefings",
              description: "Calendar in briefings",
              default: "default-on"
            }
          ]
        },
        {
          id: "email",
          name: "Email",
          description: "Email source",
          behaviors: [
            {
              id: "email.briefings",
              name: "Include in briefings",
              description: "Email in briefings",
              default: "default-on"
            }
          ]
        }
      ]
    }
  ];
}

export function makeFakeDeps(options: FakeOptions = {}): ComposeDeps {
  const aiRepository = {
    async selectModelForCapability() {
      if (options.noModel) {
        return undefined;
      }
      return {
        id: "model-1",
        provider_config_id: "pc-1",
        provider_kind: "anthropic",
        provider_model_id: "claude-3-5-haiku",
        display_name: "Haiku",
        tier: "economy"
      };
    },
    async selectProviderWithCredential() {
      return {
        id: "pc-1",
        base_url: null,
        encrypted_credential: { v: 1 }
      };
    }
  } as unknown as AiRepository;

  const cipher = {
    decryptJson() {
      return options.credentialPayload ?? { apiKey: "fake-key" };
    }
  } as unknown as AiSecretCipher;

  const memoryRetriever = {
    async retrieve() {
      return [
        {
          id: "chunk-1",
          sourcePath: "notes/today.md",
          lineStart: 1,
          lineEnd: 3,
          text: "vault recall content",
          similarity: 0.9
        }
      ];
    },
    async retrieveRecent() {
      return [];
    }
  } as unknown as MemoryRetriever;

  return {
    moduleManifests: makeFakeManifests(options.failTool),
    aiRepository,
    cipher,
    memoryRetriever,
    personaRepository: {
      get: async () => options.personaPreference ?? null
    },
    priorityPreferencesRepository: {
      get: async (_scopedDb, key) =>
        key === "priority.model.v1" ? (options.priorityModel ?? null) : null
    },
    focusReadiness: async () => options.focusReadiness ?? [],
    resolveUserName: async () => options.userName ?? "Ben",
    sourceBehaviorPolicy: {
      manifests: makeFakeManifests(options.failTool),
      preferencesRepository: {
        get: async (_scopedDb, key) => {
          if (key === "sourceBehaviors" && options.disabledBehaviors) {
            return Object.fromEntries(
              [...options.disabledBehaviors].map((behaviorId) => [behaviorId, false])
            );
          }
          return options.preferences?.[key] ?? null;
        },
        getWithMetadata: async () => null,
        upsert: async () => undefined
      }
    },
    createAdapter: () => ({
      generateChat:
        options.generateChat ?? (async () => ({ text: "synth narrative" }) as { text: string })
    }),
    ...(options.dayPlan !== undefined
      ? {
          dayPlanRead: {
            getForDay: async () => {
              if (options.dayPlan?.throws) throw new Error("day plan down");
              return options.dayPlan?.plan;
            }
          }
        }
      : {})
  };
}

export function makeStructuredTaskDeps(deps: ComposeDeps): ComposeDeps {
  const rowTask = {
    id: "task-row",
    title: "Reply row title",
    description: "Reply row explanation",
    status: "suggested",
    source: "email",
    sourceRef: "acct-1:mail-row",
    dueAt: null,
    updatedAt: "2026-06-13T11:00:00.000Z",
    suggestionMetadata: {
      version: 1 as const,
      category: "needs_reply" as const,
      sourceLabel: "Gmail",
      sourceHref: "https://mail.example.test/thread",
      cacheMessageId: "cache-row",
      subjectSignature: "sig-row",
      computedAt: "2026-06-13T10:00:00.000Z",
      resurfaceReason: null
    }
  };
  const proseTask = { id: "task-prose", title: "Prose task", status: "todo" };
  return {
    ...deps,
    moduleManifests: deps.moduleManifests.map((manifest) => ({
      ...manifest,
      assistantTools: (manifest.assistantTools ?? []).map((tool) =>
        tool.name === "tasks.list"
          ? {
              ...tool,
              execute: async (_db, input) => ({
                data: { items: input.status === "suggested" ? [rowTask] : [rowTask, proseTask] }
              })
            }
          : tool.name === "email.listVisibleMessages"
            ? {
                ...tool,
                execute: async () => ({
                  data: {
                    messages: [
                      {
                        id: "mail-row",
                        connectorAccountId: "acct-1",
                        sender: "sender@example.test",
                        subject: "Row email",
                        actionability: "needs_reply",
                        summary: "row summary"
                      },
                      {
                        id: "mail-catchup",
                        connectorAccountId: "acct-1",
                        sender: "sender@example.test",
                        subject: "Catch-up email",
                        actionability: "fyi",
                        summary: "guarded catch-up summary"
                      }
                    ]
                  }
                })
              }
            : tool
      )
    }))
  };
}
