export const queryKeys = {
  auth: {
    bootstrap: ["auth", "bootstrap"] as const,
    me: ["auth", "me"] as const
  },
  onboarding: {
    status: ["onboarding", "status"] as const
  },
  modules: ["modules"] as const,
  myModules: ["me", "modules"] as const,
  modulePreferences: (moduleId: string) => ["modules", moduleId, "preferences"] as const,
  settings: {
    providers: ["settings", "providers"] as const,
    adminConnectorAccounts: ["settings", "admin", "connector-accounts"] as const,
    adminAuditEvents: ["settings", "admin", "audit-events"] as const,
    adminUsers: ["settings", "admin", "users"] as const,
    adminModules: ["settings", "admin", "modules"] as const,
    // #917: admin external-module list. Sibling of adminModules (flat convention).
    adminExternalModules: ["settings", "admin", "external-modules"] as const,
    // #964: registry-backed distribution rows (superset of adminExternalModules info).
    adminModuleRegistry: ["settings", "admin", "module-registry"] as const,
    locale: ["settings", "locale"] as const,
    sessions: ["settings", "sessions"] as const,
    persona: ["settings", "persona"] as const,
    themes: ["settings", "themes"] as const,
    sourceBehaviors: ["settings", "source-behaviors"] as const,
    registrationSettings: ["settings", "admin", "registration"] as const,
    chatMultiplexer: ["settings", "chat-multiplexer"] as const,
    yolo: ["settings", "yolo"] as const,
    chatArchive: ["settings", "chat-archive"] as const,
    adminYolo: ["settings", "admin", "yolo"] as const,
    hostDiagnostics: ["settings", "host-diagnostics"] as const,
    hostRestart: ["settings", "host-restart"] as const,
    notesSource: ["settings", "notes-source"] as const,
    quietHours: ["settings", "quiet-hours"] as const,
    notificationPreferences: ["settings", "notification-preferences"] as const,
    notificationDigest: ["settings", "notification-digest"] as const,
    notesSourceDirectories: (path: string | null) =>
      ["settings", "notes-source", "directories", path] as const,
    notesLastSync: ["settings", "notes-last-sync"] as const
  },
  connectors: {
    providers: ["connectors", "providers"] as const,
    accounts: ["connectors", "accounts"] as const,
    featureGrants: (id: string) => ["connectors", "feature-grants", id] as const
  },
  integrations: {
    list: ["integrations"] as const,
    detail: (id: string) => ["integrations", id] as const
  },
  ai: {
    summary: ["ai", "summary"] as const,
    providers: ["ai", "providers"] as const,
    models: ["ai", "models"] as const,
    chatModelOverride: ["ai", "chat-model-override"] as const,
    adminUserAiPin: (userId: string) => ["ai", "admin", "users", userId, "pin"] as const,
    // #870 Slice 1: per-service bindings replace the old capability routes / tier prefs. #874: Chat
    // is the only bindable service now; Voice (STT) is its own dedicated endpoint (voiceEndpoint).
    serviceBindings: ["ai", "service-bindings"] as const,
    // #874: the single instance-wide Voice (STT) endpoint config.
    voiceEndpoint: ["ai", "voice-endpoint"] as const,
    capabilities: ["ai", "capability"] as const,
    capability: (capability: string) => ["ai", "capability", capability] as const,
    // #1059 — owner-gated CLI-provider terminal. Routed through useQuery (not a bare
    // useEffect+useState) so TerminalModal's initial no-password/locked branch resolves
    // synchronously in tests via queryClient.setQueryData, same trick as every other
    // primed-cache renderToString suite in this file family.
    terminalStatus: (providerId: string) => ["ai", "terminal-status", providerId] as const,
    assistantTools: ["ai", "assistant-tools"] as const,
    webSearchKey: ["ai", "web-search-key"] as const,
    // #1313: the `runtimeConfig` query key + its only caller, `runtime-config-client.ts`, were
    // dead — the settings-UI control that used them was already removed (PR #1205 → batch PR
    // #1224). Deleted rather than left orphaned.
    actionAuditLog: (params?: { since?: string; family?: string; limit?: number }) =>
      ["ai", "action-audit-log", params] as const
  },
  briefings: {
    definitions: ["briefings", "definitions"] as const,
    runs: (definitionId: string | null) => ["briefings", "runs", definitionId] as const
  },
  usefulnessFeedback: {
    list: ["usefulness-feedback"] as const
  },
  calendar: {
    list: ["calendar", "list"] as const,
    detail: (id: string) => ["calendar", "detail", id] as const
  },
  chat: {
    settings: ["chat", "settings"] as const,
    threads: (surface?: string) => ["chat", "threads", surface ?? "drawer"] as const,
    privacy: (surface?: string) => ["chat", "privacy", surface ?? "drawer"] as const,
    messages: (threadId: string, surface?: string) =>
      ["chat", "threads", threadId, "messages", surface ?? "drawer"] as const,
    memorySettings: ["chat", "memory-settings"] as const,
    memoryFacts: ["chat", "memory-facts"] as const,
    memoryCorrections: ["chat", "memory-corrections"] as const,
    skills: ["chat", "skills"] as const
  },
  email: {
    list: ["email", "list"] as const,
    detail: (id: string) => ["email", "detail", id] as const,
    taskMode: ["email", "task-mode"] as const
  },
  notifications: {
    list: ["notifications", "list"] as const
  },
  tasks: {
    list: ["tasks", "list"] as const,
    detail: (id: string) => ["tasks", "detail", id] as const,
    activity: (id: string) => ["tasks", "activity", id] as const,
    subtasks: (id: string) => ["tasks", "subtasks", id] as const,
    lists: ["tasks", "lists"] as const,
    tags: (listId: string) => ["tasks", "tags", listId] as const,
    preferences: ["tasks", "preferences"] as const
  },
  proactiveMonitoring: {
    cards: ["proactive-monitoring", "cards"] as const,
    settings: ["proactive-monitoring", "settings"] as const
  },
  weather: {
    today: ["weather", "today"] as const,
    location: ["weather", "location"] as const,
    unit: ["weather", "unit"] as const
  },
  wellness: {
    checkins: ["wellness", "checkins"] as const,
    medications: ["wellness", "medications"] as const,
    schedule: (date: string) => ["wellness", "schedule", date] as const,
    insights: ["wellness", "insights"] as const,
    therapyNotes: ["wellness", "therapy-notes"] as const,
    adherenceSummary: (sinceDays: number) => ["wellness", "adherence-summary", sinceDays] as const
  },
  memory: {
    dashboard: (query?: object) => ["memory", "dashboard", query] as const,
    dashboardItem: (id: string) => ["memory", "dashboard", "item", id] as const
  },
  goals: {
    list: ["goals", "list"] as const
  },
  people: {
    list: ["people", "list"] as const,
    notesSettings: ["people", "notes-settings"] as const,
    notesDirectories: (path: string | null) => ["people", "notes-directories", path] as const,
    matchCandidates: ["people", "match-candidates"] as const
  }
};

const FORBIDDEN_QUERY_KEY_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainQueryKeyContainer(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolves a server-declared dot-path token (e.g. "settings.themes") against the
 * client `queryKeys` object. Fail-closed by construction: an unknown token, a
 * dunder/prototype segment, a factory-function leaf, or any non-plain-object
 * intermediate all resolve to `undefined` rather than throwing or falling back to a
 * broad invalidation. Only an actual `as const` array leaf resolves.
 */
export function resolveQueryKeyToken(token: string): readonly unknown[] | undefined {
  const segments = token.split(".");
  let current: unknown = queryKeys;

  for (const segment of segments) {
    if (FORBIDDEN_QUERY_KEY_SEGMENTS.has(segment)) {
      return undefined;
    }
    if (
      !isPlainQueryKeyContainer(current) ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      return undefined;
    }
    current = current[segment];
  }

  return Array.isArray(current) ? current : undefined;
}
