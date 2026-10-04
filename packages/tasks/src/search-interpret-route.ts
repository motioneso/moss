import type { FastifyRequest } from "fastify";

import {
  AiRepository,
  HttpApiAdapter,
  createAiSecretCipher,
  parseAiApiKeyCredential,
  type AiSecretCipher,
  type ChatProviderAdapter,
  type ProviderKind
} from "@moss/ai";
import type { AccessContext, DataContextRunner, PreferencesPort } from "@moss/db";
import { localDay } from "@moss/shared";

import { HttpError } from "./errors.js";
import { TaskListsRepository } from "./lists.js";
import {
  buildTaskSearchPrompt,
  parseTaskSearchIntent,
  type TaskSearchVocabulary
} from "./search-interpret.js";

export interface TaskSearchRouteDependencies {
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly dataContext: DataContextRunner;
  readonly listsRepository?: TaskListsRepository;
  readonly localePreferencesRepository?: PreferencesPort;
  readonly aiRepository?: AiRepository;
  readonly aiSecretCipher?: AiSecretCipher;
  readonly createChatAdapter?: (
    kind: ProviderKind,
    apiKey: string,
    baseUrl: string | null
  ) => ChatProviderAdapter;
}

export async function interpretTaskSearchForRequest(
  request: FastifyRequest,
  dependencies: TaskSearchRouteDependencies
) {
  const listsRepository = dependencies.listsRepository ?? new TaskListsRepository();
  const aiRepository = dependencies.aiRepository ?? new AiRepository();
  const aiSecretCipher = dependencies.aiSecretCipher ?? createAiSecretCipher();
  const createChatAdapter =
    dependencies.createChatAdapter ??
    ((kind, apiKey, baseUrl) => new HttpApiAdapter(kind, apiKey, baseUrl ? { baseUrl } : {}));
  const accessContext = await dependencies.resolveAccessContext(request);
  const query = parseQuery(request.body);

  return dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
    const lists = await listsRepository.list(scopedDb);
    const tagRows = (
      await Promise.all(lists.map((list) => listsRepository.listTags(scopedDb, list.id)))
    ).flat();
    const vocabulary: TaskSearchVocabulary = {
      lists: lists.map((list) => ({ id: list.id, name: list.name })),
      tagNames: [...new Set(tagRows.map((tag) => tag.name))].sort((left, right) =>
        left.localeCompare(right)
      )
    };
    const model = await aiRepository.selectChatModelForUser(scopedDb);
    if (!model) throw unavailable();

    const provider = await aiRepository.selectProviderWithCredential(
      scopedDb,
      model.provider_config_id
    );
    if (!provider?.encrypted_credential) throw unavailable();

    let apiKey: string;
    try {
      const credential = parseAiApiKeyCredential(
        aiSecretCipher.decryptJson(provider.encrypted_credential)
      );
      if (!credential) throw new Error("missing api key");
      apiKey = credential.apiKey;
    } catch {
      throw unavailable();
    }

    const timeZone = await getLocaleTimeZone(scopedDb, dependencies.localePreferencesRepository);
    try {
      const adapter = createChatAdapter(
        model.provider_kind as ProviderKind,
        apiKey,
        provider.base_url
      );
      const { text } = await adapter.generateChat({
        model: {
          provider_kind: model.provider_kind,
          provider_model_id: model.provider_model_id
        },
        messages: [
          {
            role: "user",
            content: buildTaskSearchPrompt({
              query,
              today: localDay(new Date(), timeZone),
              vocabulary
            })
          }
        ],
        maxOutputTokens: 500,
        actionCode: "task.task-search",
        ownerUserId: accessContext.actorUserId
      });
      return parseTaskSearchIntent(text, vocabulary);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw unavailable();
    }
  });
}

function parseQuery(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "request body must be an object");
  }
  const query = (body as Record<string, unknown>)["query"];
  if (typeof query !== "string") throw new HttpError(400, "query must be a string");
  const trimmed = query.trim();
  if (!trimmed || trimmed.length > 300) throw new HttpError(400, "query must be 1-300 characters");
  return trimmed;
}

async function getLocaleTimeZone(
  scopedDb: Parameters<PreferencesPort["get"]>[0],
  preferencesRepository: PreferencesPort | undefined
): Promise<string | undefined> {
  if (!preferencesRepository) return undefined;
  const locale = await preferencesRepository.get(scopedDb, "locale");
  if (!locale || typeof locale !== "object" || Array.isArray(locale)) return undefined;
  const timeZone = (locale as Record<string, unknown>)["timezone"];
  return typeof timeZone === "string" && timeZone.length > 0 ? timeZone : undefined;
}

function unavailable(): HttpError {
  return new HttpError(503, "Natural-language task search is unavailable");
}
