import type { createAiSecretCipher } from "@moss/ai";
import {
  askSortingProbabilities,
  generateStructured,
  type AiRepository,
  type GenerateStructuredDeps,
  type StructuredRunScope,
  type StructuredRunPriority,
  type StructuredTelemetry
} from "@moss/ai";
import type { DataContextDb } from "@moss/db";
import { EmailExtractNeedsConfigurationError, type EmailExtractDeps } from "./email-extract.js";
import { EMAIL_SORTING_SERVICE } from "./email-sorting.js";
import type { EmailSortingService } from "./email-sorting-live.js";

type AiSecretCipher = ReturnType<typeof createAiSecretCipher>;

export type BuildEmailExtractDepsOptions = Pick<
  GenerateStructuredDeps,
  "createAdapter" | "createCliStructuredAdapter"
> & {
  readonly logger?: {
    info(data: Record<string, unknown>, message: string): void;
    warn(data: Record<string, unknown>, message: string): void;
  };
};

const EMAIL_SIGNALS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["gate", "category", "confidence"],
  properties: {
    gate: { type: "string", enum: ["nothing", "worth_knowing", "maybe_owed"] },
    category: {
      enum: [
        "needs_reply",
        "needs_action",
        "time_sensitive_info",
        "waiting_on_someone",
        "fyi",
        "noise",
        "unknown"
      ]
    },
    reason: { type: "string" },
    action: { type: "string" },
    dueDate: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    // Only read for messages the deterministic sign-in-code rule could not settle; never stored.
    deliversSignInCode: { type: "boolean" }
  }
} as const;

const EMAIL_EXTRACT_SERVICE = "module.connectors.email-extract";

/**
 * #2805: the sorting model for email sorting. The router picks it from the admin's settings through
 * the email sorting job key; nothing here names a model or provider.
 */
function buildEmailSortingService(
  scopedDb: DataContextDb,
  aiRepo: AiRepository,
  aiCipher: AiSecretCipher,
  options: BuildEmailExtractDepsOptions
): EmailSortingService {
  return {
    available: async () =>
      (await aiRepo.resolveSortingModel(scopedDb, EMAIL_SORTING_SERVICE, {
        acceptSystemOne: true
      })) !== null,
    ask: (state, questions, signal) =>
      askSortingProbabilities(
        scopedDb,
        { service: EMAIL_SORTING_SERVICE, state, questions, ...(signal ? { signal } : {}) },
        {
          repository: aiRepo,
          cipher: aiCipher,
          // askSortingProbabilities uses only the two-argument structured logger form.
          ...(options.logger
            ? { logger: options.logger as Parameters<typeof askSortingProbabilities>[2]["logger"] }
            : {}),
          ...(options.createAdapter ? { createAdapter: options.createAdapter } : {}),
          ...(options.createCliStructuredAdapter
            ? { createCliStructuredAdapter: options.createCliStructuredAdapter }
            : {})
        }
      )
  };
}

/** Shared production composition for Google/IMAP sync and live source-context triage. */
export function buildEmailExtractDeps(
  scopedDb: DataContextDb,
  aiRepo: AiRepository,
  aiCipher: AiSecretCipher,
  options: BuildEmailExtractDepsOptions = {}
): EmailExtractDeps {
  return {
    sorting: buildEmailSortingService(scopedDb, aiRepo, aiCipher, options),
    runChat: async (
      prompt,
      signal,
      batchSize = 1,
      telemetry?: StructuredTelemetry,
      priority?: StructuredRunPriority,
      scope?: StructuredRunScope,
      closeScope?: boolean
    ) => {
      const schema =
        batchSize === 1
          ? EMAIL_SIGNALS_SCHEMA
          : {
              type: "object",
              additionalProperties: false,
              required: ["results"],
              properties: {
                results: {
                  type: "array",
                  minItems: batchSize,
                  maxItems: batchSize,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["index", "value"],
                    properties: {
                      index: { type: "integer", minimum: 0, maximum: batchSize - 1 },
                      value: EMAIL_SIGNALS_SCHEMA
                    }
                  }
                }
              }
            };
      const result = await generateStructured(
        scopedDb,
        {
          service: EMAIL_EXTRACT_SERVICE,
          schema,
          prompt,
          requireExplicitBinding: true,
          signal,
          telemetry,
          priority,
          scope,
          closeScope
        },
        {
          repository: aiRepo,
          cipher: aiCipher,
          createAdapter: options.createAdapter,
          createCliStructuredAdapter: options.createCliStructuredAdapter,
          // generateStructured uses only the two-argument structured logger form above.
          logger: options.logger as GenerateStructuredDeps["logger"]
        }
      );
      if (!result.ok) {
        if (result.error === "needs_config") throw new EmailExtractNeedsConfigurationError();
        throw new Error(`email-extract-structured-${result.error}`);
      }
      return { text: JSON.stringify(result.object) };
    }
  };
}
