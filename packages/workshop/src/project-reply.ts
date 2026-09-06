import {
  HttpApiAdapter,
  parseAiApiKeyCredential,
  type AiConfiguredModelSafeRow,
  type AiProviderWithSealedCredential,
  type AiRepository,
  type AiSecretCipher,
  type ProviderKind,
  type StructuredProviderAdapter
} from "@moss/ai";
import type { AccessContext, DataContextRunner } from "@moss/db";
import type { WorkshopFeedEntry, WorkshopProject } from "@moss/shared";
import { WorkshopProjectFeed } from "./project-feed.js";

/**
 * Fixed opening framing from the approved Workshop assistant persona (see
 * docs/reviews/2026-09-04-workshop-assessment.md), trimmed to what applies to a plain
 * conversational reply — this slice has no tools, no builds, no planning.
 */
const PROJECT_REPLY_PERSONA_TEXT =
  "You are the assistant for this Workshop project. You help the user design, build, test, and " +
  "refine its Moss module. Keep the conversation focused on that module and retain its agreed " +
  "requirements and current plan. Ask focused questions when an answer changes the result; " +
  "otherwise make reasonable choices and explain them briefly.";

const PROJECT_REPLY_MAX_OUTPUT_TOKENS = 800;
const PROJECT_REPLY_TIMEOUT_MS = 45_000;

export interface ProjectReplyDependencies {
  readonly dataContext: DataContextRunner;
  readonly aiRepository: Pick<
    AiRepository,
    "selectModelForCapability" | "selectProviderWithCredential"
  >;
  readonly cipher: Pick<AiSecretCipher, "decryptJson">;
  readonly createCliStructuredAdapter?: (kind: ProviderKind) => StructuredProviderAdapter;
}

export interface ProjectReplyResult {
  readonly delivered: boolean;
  readonly assistantEntry?: WorkshopFeedEntry;
}

function buildPrompt(project: WorkshopProject, userEntry: WorkshopFeedEntry): string {
  const lines = [
    PROJECT_REPLY_PERSONA_TEXT,
    `Project title: ${project.title}`,
    `Initial request: ${project.initialRequest}`
  ];
  if (project.context.trim()) lines.push(`Additional context: ${project.context}`);
  lines.push("", userEntry.text);
  return lines.join("\n");
}

function readStructuredReplyText(result: {
  readonly rawObject?: unknown;
  readonly rawText?: string;
}): string {
  const value =
    result.rawObject ??
    (() => {
      try {
        return JSON.parse(result.rawText ?? "");
      } catch {
        return null;
      }
    })();
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { text?: unknown }).text === "string"
  ) {
    return (value as { text: string }).text;
  }
  throw new Error("Model transport returned no text");
}

async function getReplyText(
  deps: ProjectReplyDependencies,
  model: AiConfiguredModelSafeRow,
  provider: AiProviderWithSealedCredential,
  project: WorkshopProject,
  userEntry: WorkshopFeedEntry
): Promise<string> {
  const modelInput = {
    provider_kind: model.provider_kind as ProviderKind,
    provider_model_id: model.provider_model_id
  };
  const messages = [{ role: "user" as const, content: buildPrompt(project, userEntry) }];

  if (provider.auth_method === "cli") {
    if (!deps.createCliStructuredAdapter) throw new Error("CLI transport unavailable");
    const schema = {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false
    };
    const result = await deps
      .createCliStructuredAdapter(modelInput.provider_kind)
      .generateStructured({
        model: modelInput,
        messages,
        schema,
        maxOutputTokens: PROJECT_REPLY_MAX_OUTPUT_TOKENS
      });
    return readStructuredReplyText(result);
  }

  if (!provider.encrypted_credential) throw new Error("Provider has no stored credential");
  const credential = parseAiApiKeyCredential(
    deps.cipher.decryptJson(provider.encrypted_credential)
  );
  if (!credential) throw new Error("Provider credential could not be read");
  const adapter = new HttpApiAdapter(modelInput.provider_kind, credential.apiKey, {
    baseUrl: provider.base_url ?? undefined
  });
  const result = await adapter.generateChat({
    model: modelInput,
    messages,
    maxOutputTokens: PROJECT_REPLY_MAX_OUTPUT_TOKENS
  });
  return result.text;
}

/**
 * Races a promise against a fixed timer. On timeout resolves null immediately without
 * cancelling the underlying call; a late result or error from it is only logged, never
 * allowed to affect the save that already returned.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onLateSettle: (error: unknown) => void
): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, ms);
    promise.then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) {
          onLateSettle(error);
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}

/**
 * Tries to answer a just-saved project message with a plain-text model reply. Never throws:
 * any failure at any step, including the timeout, leaves the user's message exactly as it was
 * (still pending, no assistant row) so a save can never hang or fail on a slow or broken model.
 */
export async function attemptProjectReply(
  deps: ProjectReplyDependencies,
  access: AccessContext,
  project: WorkshopProject,
  userEntry: WorkshopFeedEntry
): Promise<ProjectReplyResult> {
  try {
    const picked = await deps.dataContext.withDataContext(access, async (scopedDb) => {
      const model = await deps.aiRepository.selectModelForCapability(
        scopedDb,
        "chat",
        "interactive"
      );
      if (!model) return null;
      const provider = await deps.aiRepository.selectProviderWithCredential(
        scopedDb,
        model.provider_config_id
      );
      if (!provider) return null;
      return { model, provider };
    });
    if (!picked) return { delivered: false };

    const replyText = await withTimeout(
      getReplyText(deps, picked.model, picked.provider, project, userEntry),
      PROJECT_REPLY_TIMEOUT_MS,
      (error) =>
        console.warn(
          `[workshop] project reply for project ${project.id} settled after its time limit: ${(error as Error).message}`
        )
    );
    if (replyText === null || !replyText.trim()) return { delivered: false };

    const written = await deps.dataContext.withDataContext(access, (scopedDb) =>
      new WorkshopProjectFeed().appendAssistantReply(
        scopedDb,
        project.id,
        replyText,
        userEntry.messageId
      )
    );
    if (!written) return { delivered: false };
    return { delivered: true, assistantEntry: written.entry };
  } catch (error) {
    console.warn(
      `[workshop] project reply for project ${project.id} failed: ${(error as Error).message}`
    );
    return { delivered: false };
  }
}
