import type { createAiSecretCipher } from "@moss/ai";
import {
  generateStructured,
  type AiRepository,
  type GenerateStructuredDeps,
  type StructuredRunScope,
  type StructuredRunPriority,
  type StructuredTelemetry
} from "@moss/ai";
import type { DataContextDb } from "@moss/db";
import { EmailExtractNeedsConfigurationError, type EmailExtractDeps } from "./email-extract.js";

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
  required: ["category", "confidence"],
  properties: {
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

/** Shared production composition for Google/IMAP sync and live source-context triage. */
export function buildEmailExtractDeps(
  scopedDb: DataContextDb,
  aiRepo: AiRepository,
  aiCipher: AiSecretCipher,
  options: BuildEmailExtractDepsOptions = {}
): EmailExtractDeps {
  return {
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
