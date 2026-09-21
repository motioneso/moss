import type { FastifyBaseLogger } from "fastify";

import type { generateStructured } from "@moss/ai";
import { createCliStructuredAdapterFactory, type ChatEngineFactory } from "@moss/chat";
import { createFocusJudgmentService, type FocusJudgmentService } from "@moss/module-registry";

/** TEST-ONLY. Replaces the structured model call behind the Trail Marker focus judgment. */
export type FocusGenerate = typeof generateStructured;

/**
 * Builds the focus judgment service the Mac-facing routes call (#2570). Kept out of server.ts,
 * which is at its size limit, and so the wiring reads in one place: the model call goes through
 * the same command-line adapter factory chat uses, and a test may swap the call itself.
 */
export function focusService(
  logger: FastifyBaseLogger,
  options: {
    readonly chatEngineFactory?: ChatEngineFactory;
    readonly focusGenerate?: FocusGenerate;
  }
): FocusJudgmentService {
  return createFocusJudgmentService({
    logger,
    createCliStructuredAdapter: createCliStructuredAdapterFactory(options.chatEngineFactory),
    generate: options.focusGenerate
  });
}
