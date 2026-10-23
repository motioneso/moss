import type { ModuleAssistantToolManifest, ToolExecute } from "@moss/module-sdk";

import { PRESENTATION_UNAVAILABLE, VisualPresentationService } from "./presentation-service.js";

export const chatPresentExecute: ToolExecute = async (_db, input, ctx, services) => {
  const service = services?.visualPresentation;
  if (!(service instanceof VisualPresentationService)) {
    return { data: { status: "text_fallback", fallbackText: PRESENTATION_UNAVAILABLE } };
  }
  const result = service.present(ctx, input.proposal);
  // Programs stay internal until semantic validation and the final reply path are implemented.
  return {
    data: {
      status: result.ok ? "validated_internally" : "text_fallback",
      fallbackText: result.ok ? result.reply.fallbackText : result.fallbackText
    }
  };
};

export const chatPresentTool = {
  name: "chat.present",
  description:
    "Propose a visual arrangement using only snapshot references supplied by the host for this turn. " +
    "This internal tool does not fetch data or render a visual. Use its readable fallback in your answer. " +
    "If unavailable or invalid, answer in ordinary text without retrying or showing program text.",
  permissionId: "chat.view",
  risk: "read",
  content: "user_authored",
  requiresServices: ["visualPresentation"],
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["proposal"],
    properties: {
      // The registry validates proposal shape and ownership. Keep invalid proposals on the
      // readable-fallback path instead of the gateway's input-error/model-correction path.
      proposal: {}
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["status", "fallbackText"],
    properties: {
      status: { type: "string", enum: ["validated_internally", "text_fallback"] },
      fallbackText: { type: "string" }
    }
  },
  execute: chatPresentExecute
} satisfies ModuleAssistantToolManifest;
