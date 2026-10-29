import { randomUUID } from "node:crypto";
import { MossAcpClient, AcpCapabilityError, type AcpProviderKind, type AcpTunnel } from "@moss/acp";
import {
  CONSTRAINED_CLAUDE_TIMEOUT_MS,
  StructuredTransportUnavailableError,
  abortErrorFor,
  assertBoundedStructuredPrompt,
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
import type { RpcConnection } from "./chat-engine-rpc-client.js";
import { RpcAcpTunnel } from "./acp-chat-engine.js";
import { buildCliStructuredPrompt } from "./cli-structured-adapter.js";
import { CliChatUnavailableError } from "./errors.js";

const unsupported = () =>
  new CliChatUnavailableError("No-tools subscription summaries are unavailable");

export type AcpTunnelFactory = (sessionKey: string) => AcpTunnel | undefined;

export function createAcpNoToolsStructuredAdapterFactory(
  getTunnel: AcpTunnelFactory
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
        () => generate(kind, input, getTunnel),
        {}
      )
  });
}

export function createAcpNoToolsStructuredAdapterFactoryForConnection(
  getConnection: () => RpcConnection | undefined
): (kind: ProviderKind) => StructuredProviderAdapter {
  return createAcpNoToolsStructuredAdapterFactory((sessionKey) => {
    const connection = getConnection();
    return connection ? new RpcAcpTunnel(connection, sessionKey) : undefined;
  });
}

async function generate(
  kind: ProviderKind,
  input: GenerateStructuredProviderInput,
  getTunnel: AcpTunnelFactory
): Promise<StructuredProviderResult> {
  const agentId =
    kind === "anthropic" ? "claude-acp" : kind === "openai-compatible" ? "codex-acp" : undefined;
  const acpKind: AcpProviderKind | undefined =
    kind === "anthropic" ? "anthropic" : kind === "openai-compatible" ? "openai" : undefined;
  if (!agentId || !acpKind) throw new StructuredTransportUnavailableError();
  if (
    input.model.provider_kind !== kind ||
    !input.actorUserId ||
    input.nativeSearch ||
    input.scope ||
    input.closeScope ||
    (input.acpAgentId != null && input.acpAgentId !== agentId) ||
    input.messages.length === 0
  )
    throw unsupported();
  const prompt = buildCliStructuredPrompt(input);
  assertBoundedStructuredPrompt(prompt);
  assertBoundedStructuredSchema(input.schema);
  const sessionKey = `no-tools-${randomUUID()}`;
  const tunnel = getTunnel(sessionKey);
  if (!tunnel) throw unsupported();
  const client = new MossAcpClient(tunnel);
  let handle: Awaited<ReturnType<MossAcpClient["openSession"]>> | undefined;
  const onAbort = () => {
    if (handle) void client.close(handle).catch(() => undefined);
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (input.signal?.aborted) throw abortErrorFor(input.signal);
    handle = await client.openSession(
      sessionKey,
      "summary",
      acpKind,
      input.actorUserId,
      "no-tools",
      undefined,
      "You produce structured JSON only."
    );
    const modelId = input.model.provider_model_id;
    if (modelId) await client.setModelForChat(handle, modelId);
    if (input.signal?.aborted) throw abortErrorFor(input.signal);
    const result = await client.prompt(handle, prompt, {
      timeoutMs: CONSTRAINED_CLAUDE_TIMEOUT_MS
    });
    if (input.signal?.aborted) throw abortErrorFor(input.signal);
    if (!result.text.trim()) throw unsupported();
    return {
      rawText: result.text,
      usage: {
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0
      }
    };
  } catch (error) {
    if (input.signal?.aborted) throw abortErrorFor(input.signal);
    if (error instanceof AcpCapabilityError) throw new StructuredTransportUnavailableError();
    throw error;
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    if (handle) await client.close(handle).catch(() => undefined);
  }
}
