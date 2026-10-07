import { randomUUID } from "node:crypto";
import {
  assertBoundedStructuredPrompt,
  abortErrorFor,
  StructuredTransportUnavailableError,
  assertBoundedStructuredSchema,
  modelActivityAction,
  modelActivityStructuredCode,
  recordModelActivity,
  withModelActivityRecording,
  type GenerateStructuredProviderInput,
  type ProviderKind,
  type StructuredProviderAdapter,
  type StructuredProviderResult
} from "@moss/ai";
import type { ChatEngineFactory } from "./runtime.js";
import type { CliChatEngine, EngineLaunchOpts } from "./types.js";
import { CliChatUnavailableError } from "./errors.js";

type StructuredEngine = CliChatEngine & {
  launchStructured(
    opts: EngineLaunchOpts & { schema: Record<string, unknown> }
  ): Promise<{ offset: number }>;
  submitStructured(text: string): Promise<void>;
  readStructured(offset: number): Promise<{ text?: string; offset: number; complete: boolean }>;
};
function structured(engine: CliChatEngine): engine is StructuredEngine {
  const candidate = engine as Partial<StructuredEngine>;
  return (
    typeof candidate.launchStructured === "function" &&
    typeof candidate.submitStructured === "function" &&
    typeof candidate.readStructured === "function"
  );
}
const unsupported = () =>
  new CliChatUnavailableError("Constrained subscription summaries are unavailable");

/** Only callers explicitly opting into the constrained runner receive this adapter. */
export function createConstrainedCliStructuredAdapterFactory(
  factory: ChatEngineFactory
): (kind: ProviderKind) => StructuredProviderAdapter {
  return (kind) => ({
    generateStructured: (input) =>
      withModelActivityRecording(
        recordModelActivity,
        {
          kind: "structured",
          action: modelActivityAction(input.service),
          actionCode: input.actionCode ?? modelActivityStructuredCode(input.service),
          modelName: input.model.provider_model_id,
          ...(input.actorUserId ? { ownerUserId: input.actorUserId } : {})
        },
        () => generate(kind, input, factory),
        {}
      )
  });
}

async function generate(
  kind: ProviderKind,
  input: GenerateStructuredProviderInput,
  factory: ChatEngineFactory
): Promise<StructuredProviderResult> {
  if (kind !== "anthropic") throw new StructuredTransportUnavailableError();
  if (
    input.model.provider_kind !== kind ||
    !input.actorUserId ||
    input.nativeSearch ||
    input.scope ||
    input.closeScope ||
    (input.acpAgentId != null && input.acpAgentId !== "claude-acp") ||
    input.messages.length !== 1 ||
    input.messages[0]?.role !== "user"
  )
    throw unsupported();
  const prompt = input.messages[0].content;
  assertBoundedStructuredPrompt(prompt);
  assertBoundedStructuredSchema(input.schema);
  const engine = await factory(kind, `constrained-${randomUUID()}`, {
    executionMode: "non_interactive",
    needsStructuredOutput: true,
    constrainedStructured: true,
    userId: input.actorUserId,
    acpAgentId: input.acpAgentId
  });
  const signal = AbortSignal.any([
    ...(input.signal ? [input.signal] : []),
    AbortSignal.timeout(105_000)
  ]);
  const aborted = () => {
    void engine.kill().catch(() => undefined);
  };
  signal.addEventListener("abort", aborted, { once: true });
  try {
    if (signal.aborted) throw abortErrorFor(signal);
    if (!structured(engine)) throw unsupported();
    await engine.launchStructured({
      neutralDir: "",
      personaPath: "",
      personaText: "You produce structured JSON only.",
      model: input.model.provider_model_id,
      schema: input.schema
    });
    if (signal.aborted) throw abortErrorFor(signal);
    await engine.submitStructured(prompt);
    let offset = 0;
    let reply: string | undefined;
    while (!signal.aborted) {
      const result = await engine.readStructured(offset);
      offset = result.offset;
      if (result.text !== undefined) reply = result.text;
      if (result.complete) {
        if (reply === undefined) throw unsupported();
        return { rawText: reply, usage: { inputTokens: 0, outputTokens: 0 } };
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw abortErrorFor(signal);
  } catch (error) {
    if (signal.aborted) throw abortErrorFor(signal);
    // Fixed server-authored code survives RPC; never inspect or forward provider diagnostics.
    if (error instanceof Error && error.message === "Constrained Claude runtime is unsupported") {
      throw new StructuredTransportUnavailableError();
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", aborted);
    await engine.kill();
  }
}
