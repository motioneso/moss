import type { ModuleServiceKey } from "@moss/shared";

import type { ProviderKind } from "./transcript-reader.js";

// #915 D6: provider mechanics only. Routing policy and credentials stay outside feature code.
export const STRUCTURED_TOOL_NAME = "emit_structured_output";

export type StructuredRunPriority = "foreground" | "background";

export type StructuredChatTurn = {
  readonly role: "user" | "assistant";
  readonly content: string;
};

export type StructuredUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
};

export type StructuredTelemetryEvent = {
  readonly kind:
    | "invoked"
    | "busy"
    | "elapsed"
    | "exit"
    | "first-readable"
    | "late-read"
    | "timeout"
    | "parse"
    | "repair"
    | "fallback";
  readonly elapsedMs?: number;
  readonly exit?: "complete" | "busy" | "timeout" | "no-reply" | "error";
  readonly count?: number;
  readonly priority?: StructuredRunPriority;
};

export type StructuredTelemetry = {
  readonly emit: (event: StructuredTelemetryEvent) => void;
};

/** Metadata-only identity for a transient structured CLI conversation. */
export type StructuredRunScope = {
  readonly actorUserId: string;
  readonly connectorAccountId: string;
  readonly lineageId: string;
};

export type StructuredSource = {
  readonly title: string;
  readonly url: string;
};

export type GenerateStructuredProviderInput = {
  /** Which module/service is calling — lets a CLI-backed adapter key a stable one-shot cwd. */
  readonly service?: ModuleServiceKey;
  readonly model: { readonly provider_kind: ProviderKind; readonly provider_model_id: string };
  readonly messages: readonly StructuredChatTurn[];
  readonly schema: Record<string, unknown>;
  readonly maxOutputTokens: number;
  /** #2228: let the model use its own built-in web search tool while producing this result. */
  readonly nativeSearch?: boolean;
  readonly signal?: AbortSignal;
  readonly telemetry?: StructuredTelemetry;
  readonly priority?: StructuredRunPriority;
  readonly scope?: StructuredRunScope;
  readonly closeScope?: boolean;
};

export type StructuredProviderResult =
  | {
      readonly rawObject: unknown;
      readonly usage: StructuredUsage;
      readonly sources?: readonly StructuredSource[];
    }
  | {
      readonly rawText: string;
      readonly usage: StructuredUsage;
      /** #2228: sources a CLI's own web search tool reported while producing `rawText`. */
      readonly sources?: readonly StructuredSource[];
    };

export class StructuredOutputParseError extends Error {
  readonly rawText: string;
  readonly usage: StructuredUsage;

  constructor(message: string, rawText: string, usage: StructuredUsage) {
    super(message);
    this.name = "StructuredOutputParseError";
    this.rawText = rawText.slice(0, 2000);
    this.usage = usage;
  }
}

export type StructuredHttpRequest = {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
};

export function buildStructuredRequest(
  providerKind: ProviderKind,
  apiKey: string,
  baseUrl: string | null,
  input: GenerateStructuredProviderInput
): StructuredHttpRequest {
  switch (providerKind) {
    case "anthropic": {
      const base = baseUrl ?? "https://api.anthropic.com";
      return {
        url: `${base}/v1/messages`,
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: {
          model: input.model.provider_model_id,
          max_tokens: input.maxOutputTokens,
          messages: input.messages.map((turn) => ({ role: turn.role, content: turn.content })),
          tools: [
            {
              name: STRUCTURED_TOOL_NAME,
              description: "Emit the structured output that answers the request.",
              input_schema: input.schema
            },
            ...(input.nativeSearch
              ? [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]
              : [])
          ],
          // A server-executed search tool cannot run in the same turn as a forced tool
          // choice, so native search relaxes this to "auto" — the model may search first
          // and then call the structured tool, or skip straight to it.
          tool_choice: input.nativeSearch
            ? { type: "auto" }
            : { type: "tool", name: STRUCTURED_TOOL_NAME }
        }
      };
    }
    case "openai-compatible": {
      const base = baseUrl ?? "https://api.openai.com";
      if (input.nativeSearch) {
        // #2228: OpenAI's built-in web search tool only exists on the Responses API, so this
        // request (and only this one) switches endpoint. The Responses API carries the same
        // strict JSON schema under text.format, and url citations come back as annotations.
        return {
          url: `${base}/v1/responses`,
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: {
            model: input.model.provider_model_id,
            max_output_tokens: input.maxOutputTokens,
            input: input.messages.map((turn) => ({ role: turn.role, content: turn.content })),
            tools: [{ type: "web_search" }],
            text: {
              format: {
                type: "json_schema",
                name: "structured_output",
                strict: true,
                schema: input.schema
              }
            }
          }
        };
      }
      return {
        url: `${base}/v1/chat/completions`,
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: {
          model: input.model.provider_model_id,
          max_tokens: input.maxOutputTokens,
          messages: input.messages.map((turn) => ({ role: turn.role, content: turn.content })),
          response_format: {
            type: "json_schema",
            json_schema: { name: "structured_output", strict: true, schema: input.schema }
          }
        }
      };
    }
    case "google": {
      const base = baseUrl ?? "https://generativelanguage.googleapis.com";
      return {
        url: `${base}/v1beta/models/${input.model.provider_model_id}:generateContent`,
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: {
          contents: input.messages.map((turn) => ({
            role: turn.role === "assistant" ? "model" : "user",
            parts: [{ text: turn.content }]
          })),
          generationConfig: {
            maxOutputTokens: input.maxOutputTokens,
            responseMimeType: "application/json",
            responseSchema: input.schema
          },
          ...(input.nativeSearch ? { tools: [{ google_search: {} }] } : {})
        }
      };
    }
    default: {
      const exhaustive: never = providerKind;
      throw new Error(`unsupported provider kind: ${String(exhaustive)}`);
    }
  }
}

type AnthropicPayload = {
  content?: Array<{
    type?: string;
    name?: string;
    input?: unknown;
    text?: string;
    citations?: Array<{ url?: string; title?: string }>;
    /** web_search_tool_result blocks: the search hits the model was shown (#2228). */
    content?: Array<{ type?: string; url?: string; title?: string }>;
  }>;
  usage?: { input_tokens?: number; output_tokens?: number };
};
type OpenAiPayload = {
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};
/** Responses API shape, used when the request carried the web_search tool (#2228). */
type OpenAiResponsesPayload = {
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: unknown;
      annotations?: Array<{ type?: string; url?: string; title?: string }>;
    }>;
  }>;
  usage?: { input_tokens?: number; output_tokens?: number };
};
type GooglePayload = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: unknown }> };
    groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string; title?: string } }> };
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
};

function normalizeStructuredSource(candidate: {
  url?: string;
  title?: string;
}): StructuredSource | null {
  if (!candidate.url) return null;
  return { url: candidate.url, title: candidate.title ?? candidate.url };
}

export function dedupeStructuredSources(
  candidates: readonly (StructuredSource | null)[]
): StructuredSource[] {
  const seen = new Set<string>();
  const sources: StructuredSource[] = [];
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    sources.push(candidate);
  }
  return sources;
}

export function extractStructuredResult(
  providerKind: ProviderKind,
  payload: unknown
): StructuredProviderResult {
  switch (providerKind) {
    case "anthropic": {
      const record = (payload ?? {}) as AnthropicPayload;
      const usage = {
        inputTokens: numberOrZero(record.usage?.input_tokens),
        outputTokens: numberOrZero(record.usage?.output_tokens)
      };
      const toolUse = record.content?.find(
        (block) => block?.type === "tool_use" && block?.name === STRUCTURED_TOOL_NAME
      );
      if (!toolUse || typeof toolUse.input !== "object" || toolUse.input === null) {
        const text = (record.content ?? [])
          .map((block) => (typeof block?.text === "string" ? block.text : ""))
          .join("");
        throw new StructuredOutputParseError(
          "anthropic response has no structured tool call",
          text,
          usage
        );
      }
      // Search hits arrive as web_search_tool_result blocks; text-block citations only exist
      // when the model wrote prose, which a forced structured tool call rarely does.
      const sources = dedupeStructuredSources(
        (record.content ?? [])
          .flatMap((block) =>
            block?.type === "web_search_tool_result"
              ? (block.content ?? []).filter((hit) => hit?.type === "web_search_result")
              : (block?.citations ?? [])
          )
          .map((c) => normalizeStructuredSource(c))
      );
      return { rawObject: toolUse.input, usage, ...(sources.length > 0 ? { sources } : {}) };
    }
    case "openai-compatible": {
      if (Array.isArray((payload as OpenAiResponsesPayload | null)?.output)) {
        return extractOpenAiResponsesResult(payload as OpenAiResponsesPayload);
      }
      const record = (payload ?? {}) as OpenAiPayload;
      const usage = {
        inputTokens: numberOrZero(record.usage?.prompt_tokens),
        outputTokens: numberOrZero(record.usage?.completion_tokens)
      };
      const content = record.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new StructuredOutputParseError(
          "openai-compatible response has no message content",
          "",
          usage
        );
      }
      return { rawObject: parseJsonOrThrow(content, usage), usage };
    }
    case "google": {
      const record = (payload ?? {}) as GooglePayload;
      const usage = {
        inputTokens: numberOrZero(record.usageMetadata?.promptTokenCount),
        outputTokens: numberOrZero(record.usageMetadata?.candidatesTokenCount)
      };
      const parts = record.candidates?.[0]?.content?.parts;
      const text = Array.isArray(parts)
        ? parts.map((part) => (typeof part?.text === "string" ? part.text : "")).join("")
        : "";
      if (text.length === 0) {
        throw new StructuredOutputParseError("google response has no text parts", "", usage);
      }
      const sources = dedupeStructuredSources(
        (record.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [])
          .map((chunk) => chunk.web)
          .filter((web): web is { uri?: string; title?: string } => Boolean(web))
          .map((web) => normalizeStructuredSource({ url: web.uri, title: web.title }))
      );
      return {
        rawObject: parseJsonOrThrow(text, usage),
        usage,
        ...(sources.length > 0 ? { sources } : {})
      };
    }
    default: {
      const exhaustive: never = providerKind;
      throw new Error(`unsupported provider kind: ${String(exhaustive)}`);
    }
  }
}

function extractOpenAiResponsesResult(record: OpenAiResponsesPayload): StructuredProviderResult {
  const usage = {
    inputTokens: numberOrZero(record.usage?.input_tokens),
    outputTokens: numberOrZero(record.usage?.output_tokens)
  };
  const textParts = (record.output ?? [])
    .filter((item) => item?.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((part) => part?.type === "output_text");
  const text = textParts.map((part) => (typeof part.text === "string" ? part.text : "")).join("");
  if (text.length === 0) {
    throw new StructuredOutputParseError("openai responses payload has no output text", "", usage);
  }
  const sources = dedupeStructuredSources(
    textParts
      .flatMap((part) => part.annotations ?? [])
      .filter((annotation) => annotation?.type === "url_citation")
      .map((annotation) => normalizeStructuredSource(annotation))
  );
  return {
    rawObject: parseJsonOrThrow(text, usage),
    usage,
    ...(sources.length > 0 ? { sources } : {})
  };
}

function parseJsonOrThrow(text: string, usage: StructuredUsage): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new StructuredOutputParseError("model output is not valid JSON", text, usage);
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
