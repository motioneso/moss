import type { ToolExecute } from "@moss/module-sdk";
import type { AppMapReadService, AppMapQuery } from "./app-map.js";

/** The lookup keys, at least one of which every call must supply. */
export const APP_MAP_SLICE_LOOKUP_KEYS = ["screenId", "settingId", "errorCode", "query"] as const;

// #1363: this MUST NOT regain a top-level `anyOf`/`oneOf`/`allOf`. The natural way to say "at least
// one of these four" is `anyOf: [{required: [...]}, ...]`, and it is valid JSON Schema that passes
// our own validation and CI — but the Anthropic API rejects a top-level combinator on a tool input
// schema, and the CLI responds by dropping the ENTIRE tool rather than the constraint. This tool
// was absent from every chat for exactly that reason, while the chat persona was still instructing
// the model to call it, so app questions were answered from the model's priors instead of our
// declared app map. Nothing anywhere reported it: valid schema, green CI, `/api/mcp` 200. The
// requirement now lives in the description (so the model knows) and in the execute handler (so a
// bad call is rejected at runtime, recoverably) — never in the schema.
export const appGetMapSliceInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    screenId: { type: "string", maxLength: 120 },
    settingId: { type: "string", maxLength: 120 },
    errorCode: { type: "string", maxLength: 160 },
    query: {
      type: "string",
      maxLength: 240,
      description: "Exact reference or text. If no phrase matches, results rank by shared words."
    },
    limit: { type: "integer", minimum: 1, maximum: 8 }
  }
} as const;

const mapItemSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    moduleId: { type: "string" },
    id: { type: "string" },
    featureId: { type: "string" },
    code: { type: "string" },
    class: { type: "string" },
    remediationRef: { type: "string" },
    label: { type: "string" },
    description: { type: "string" },
    path: { type: "string" },
    scope: { type: "string" },
    requires: {
      type: "object",
      additionalProperties: false,
      properties: {
        service: { type: "string" },
        capability: { type: "string" },
        tier: { type: "string" }
      }
    }
  }
} as const;

export const appGetMapSliceOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "items", "build", "narrative"],
  properties: {
    kind: { type: "string" },
    items: { type: "array", items: mapItemSchema },
    build: {
      type: "object",
      additionalProperties: false,
      required: ["version", "buildId"],
      properties: { version: { type: "string" }, buildId: { type: "string" } }
    },
    narrative: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["authoritative", "markdown"],
          properties: { authoritative: { type: "boolean" }, markdown: { type: "string" } }
        }
      ]
    }
  }
} as const;

export const appGetMapSliceExecute: ToolExecute = async (scopedDb, input, ctx, services) => {
  const service = services?.appMap as AppMapReadService | undefined;
  if (!service) throw new Error("appMap read service is unavailable");
  // #1363: the "at least one lookup key" rule the schema can no longer express. Say which keys are
  // missing so the model can retry with one, rather than reading this as the tool being broken.
  const supplied = APP_MAP_SLICE_LOOKUP_KEYS.filter((key) => {
    const value = (input as Record<string, unknown>)?.[key];
    return typeof value === "string" && value.trim() !== "";
  });
  if (supplied.length === 0) {
    throw new Error(
      `app.getMapSlice needs at least one lookup key: ${APP_MAP_SLICE_LOOKUP_KEYS.join(", ")}.`
    );
  }
  return { data: await service.query(scopedDb as never, ctx.actorUserId, input as AppMapQuery) };
};
