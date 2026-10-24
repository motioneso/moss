import type { ModuleAssistantToolManifest, ToolExecute } from "@moss/module-sdk";

import { PRESENTATION_UNAVAILABLE, VisualPresentationService } from "./presentation-service.js";

export const chatPresentExecute: ToolExecute = async (_db, input, ctx, services) => {
  const service = services?.visualPresentation;
  if (!(service instanceof VisualPresentationService)) {
    return { data: { status: "text_fallback", fallbackText: PRESENTATION_UNAVAILABLE } };
  }
  const result = service.present(ctx, input.proposal);
  // A proposal is not a saved reply. Only the host completion path publishes its program.
  return {
    data: {
      status: result.ok ? "accepted" : "text_fallback",
      fallbackText: result.ok ? result.reply.fallbackText : result.fallbackText
    }
  };
};

export const chatPresentTool = {
  name: "chat.present",
  description:
    "Propose a visual arrangement using only snapshot references supplied by the host for this turn. " +
    "The host validates and displays the composition after saving the reply. It fetches nothing. Keep a useful text answer. " +
    "If unavailable or invalid, answer in ordinary text without retrying or showing program text.",
  permissionId: "chat.view",
  risk: "read",
  // Fallbacks can carry supplied text; preserve the gateway's outside-content tracking.
  content: "outside",
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
      status: { type: "string", enum: ["accepted", "text_fallback"] },
      fallbackText: { type: "string" }
    }
  },
  execute: chatPresentExecute
} satisfies ModuleAssistantToolManifest;
