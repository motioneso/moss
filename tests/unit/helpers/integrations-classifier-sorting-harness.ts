import { generateStructured } from "@moss/ai";
import type { DataContextDb, DataContextRunner, JsonSecretCipher } from "@moss/db";
import {
  runClassifierSortJob,
  sortEntry,
  withToolSortResults,
  type ClassifierPreparationPort,
  type ClassifierSortJobOp,
  type ClassifierSortResult,
  type ConnectionRow,
  type DiscoveredTool,
  type IntegrationsRepository,
  type PreparationStructuredOutcome
} from "@moss/integrations";

/*
 * The sorting job run against one in-memory connection row, with a scripted model. Saves use the
 * same guarded merge as the repository.
 */

export const ACTOR = { actorUserId: "00000000-0000-4000-8000-00000000000a", requestId: "test" };
export const CONNECTION_ID = "00000000-0000-4000-8000-0000000000c1";

// Chosen so its plain, base64 and URL-encoded forms all differ.
export const CREDENTIAL = "tok/en+val=ue&x";

export function tool(name: string, overrides: Partial<DiscoveredTool> = {}): DiscoveredTool {
  return {
    name,
    description: `Does ${name}`,
    group: "Home",
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
    ...overrides
  };
}

export function webTool(name: string, method: string, overrides: Partial<DiscoveredTool> = {}) {
  return tool(name, {
    invoke: { method, path: `/api/${name}`, params: [], hasBody: false },
    ...overrides
  });
}

export function connection(
  tools: DiscoveredTool[],
  overrides: Partial<ConnectionRow> = {}
): ConnectionRow {
  return {
    id: CONNECTION_ID,
    ownerUserId: ACTOR.actorUserId,
    name: "Home",
    kind: "mcp",
    transport: "http",
    url: "https://owner:hunter2@home.internal.example/mcp?token=query-secret",
    credentialPlacement: { kind: "header", name: "X-Home-Key" },
    hasCredential: true,
    enabled: true,
    baseUrl: "https://home.internal.example",
    specPasted: false,
    enabledGroups: [],
    enabledTools: [],
    mutedTools: [],
    unsuppressedTools: [],
    classifierEnabled: false,
    classifierPreparation: { version: 1, entries: {} },
    classifierSort: { version: 1, entries: {} },
    classifierKeptOutTools: [],
    discoveredTools: tools,
    lastDiscoveryAt: null,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  };
}

export type RunInput = Parameters<ClassifierPreparationPort["runStructuredDraft"]>[1];

/** The ids in one call's prompt. */
export function promptIds(prompt: string): string[] {
  const data = prompt.slice(prompt.indexOf("UNTRUSTED DATA:\n") + 16);
  return (JSON.parse(data) as { id: string }[]).map((entry) => entry.id);
}

/** Answers every tool in the call with `group`, unless `answer` overrides the reply. */
export function harness(
  row: ConnectionRow,
  config: {
    group?: string;
    answer?: (
      ids: string[],
      input: RunInput
    ) => PreparationStructuredOutcome | Promise<PreparationStructuredOutcome>;
    structured?: boolean | null;
    credential?: string | null;
    displayNames?: { model: string; provider: string };
    /** Saving a call's results throws, as a lost database connection would. */
    resultSaveFails?: () => boolean;
    /** Decides each model selection: false means no model is set up. */
    select?: () => Promise<boolean>;
  } = {}
) {
  const state = { row };
  const runs: RunInput[] = [];
  const port: ClassifierPreparationPort = {
    selectDefaultChatModel: async () =>
      config.structured === null || (config.select && !(await config.select()))
        ? null
        : {
            model: {
              id: "m1",
              providerConfigId: "p1",
              providerKind: "opaque-kind",
              providerModelId: "opaque-model"
            },
            structured: config.structured ?? true,
            ...(config.displayNames ? { displayNames: config.displayNames } : {})
          },
    runStructuredDraft: async (_db, input) => {
      runs.push(input);
      const ids = promptIds(input.prompt);
      if (config.answer) return config.answer(ids, input);
      return {
        ok: true,
        object: {
          tools: ids.map((id) => ({
            id,
            group: config.group ?? "changes_things",
            name: `Name ${id}`
          }))
        },
        usage: { inputTokens: 1, outputTokens: 1 }
      };
    }
  };
  const repository = {
    getConnection: async () => state.row,
    getConnectionForUpdate: async () => state.row,
    loadCredentialEnvelope: async () =>
      config.credential === null ? null : { secret: config.credential ?? CREDENTIAL },
    saveClassifierToolSorts: async (
      _db: DataContextDb,
      _id: string,
      results: readonly { toolName: string; result: ClassifierSortResult }[]
    ) => {
      const marking = results.every(
        ({ result }) => result.status === "failed" && result.failure === "interrupted"
      );
      if (!marking && config.resultSaveFails?.()) throw new Error("connection lost");
      const sort = withToolSortResults(
        state.row.classifierSort,
        state.row.discoveredTools,
        results
      );
      state.row = { ...state.row, classifierSort: sort };
      return state.row;
    }
  } as unknown as IntegrationsRepository;
  const cipher = {
    parseEnvelope: (envelope: unknown) => envelope,
    decryptJson: (envelope: { secret: string }) => ({ secret: envelope.secret })
  } as unknown as JsonSecretCipher;
  const dataContext = {
    withDataContext: (_ctx: unknown, fn: (db: DataContextDb) => Promise<unknown>) =>
      fn({} as DataContextDb)
  } as unknown as DataContextRunner;

  const run = (op: ClassifierSortJobOp = "sort", at?: Date) =>
    runClassifierSortJob(
      {
        dataContext,
        port,
        repository,
        cipherSources: { cipher },
        ...(at ? { now: () => at } : {})
      },
      ACTOR,
      CONNECTION_ID,
      op
    );
  return { state, runs, run };
}

export function entry(state: { row: ConnectionRow }, name: string) {
  return sortEntry(state.row.classifierSort, name);
}

/** Every schema the scripted provider was sent. */
export const sentSchemas: Record<string, unknown>[] = [];

/**
 * Runs the call through the real structured router, as the production port does: its prompt size
 * check and its answer check both apply. Only the provider's reply is scripted.
 */
export async function throughRouter(
  input: RunInput,
  reply: (ids: string[]) => unknown
): Promise<PreparationStructuredOutcome> {
  const result = await generateStructured(
    {} as DataContextDb,
    {
      service: input.service ?? "module.integrations",
      schema: input.schema,
      prompt: input.prompt,
      explicitModel: {
        id: "m1",
        provider_config_id: "p1",
        provider_kind: "anthropic",
        provider_model_id: "opaque-model"
      },
      maxOutputTokens: input.maxOutputTokens,
      singleAttempt: true,
      servedByLabel: "main",
      ...(input.replySchema ? { replySchema: input.replySchema } : {})
    },
    {
      repository: {
        selectProviderWithCredential: async () => ({
          id: "p1",
          auth_method: "api_key",
          base_url: null,
          encrypted_credential: {}
        })
      } as never,
      cipher: { decryptJson: () => ({ apiKey: "sk-test" }) },
      createAdapter: () => ({
        generateStructured: async (request: { schema: Record<string, unknown> }) => {
          sentSchemas.push(request.schema);
          return {
            rawObject: reply(promptIds(input.prompt)),
            usage: { inputTokens: 1, outputTokens: 1 }
          };
        }
      })
    }
  );
  return result.ok
    ? { ok: true, object: result.object, usage: result.usage }
    : { ok: false, error: result.error };
}
