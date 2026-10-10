import type { AdmissionPath, ConversationProvenancePort } from "@moss/ai";

import { combineHiddenContextBlocks } from "./chat-context-blocks.js";
import type { CliChatEngine } from "./types.js";

const admitted = Symbol("admitted context");
const prepared = Symbol("prepared turn");

/** Only admitToContext can create outside text accepted by prompt assembly. */
export interface AdmittedContext {
  readonly text: string;
  readonly [admitted]: true;
}

/** A user turn assembled from trusted metadata and already-admitted outside blocks. */
export interface PreparedTurn {
  readonly text: string;
  readonly [prepared]: true;
}

export interface ContextAdmissionDeps {
  recordForThread(threadId: string, path: AdmissionPath): Promise<void>;
}

export function admissionForActor(
  provenance: Pick<ConversationProvenancePort, "recordAdmission"> | undefined,
  actorUserId: string
): ContextAdmissionDeps {
  return {
    recordForThread: async (threadId, path) => {
      if (!provenance) throw new Error("Conversation provenance is unavailable");
      await provenance.recordAdmission(actorUserId, threadId, path);
    }
  };
}

export async function admitToContext(
  deps: ContextAdmissionDeps,
  threadId: string | null,
  path: AdmissionPath,
  text: string
): Promise<AdmittedContext | null> {
  if (!text.trim()) return null;
  await recordAdmission(deps, threadId, path);
  return Object.freeze({ text, [admitted]: true as const });
}

/** ACP engines can admit read/web output without a permission ask; taint before they start. */
export async function admitOutsideAgentLaunch(
  deps: ContextAdmissionDeps,
  threadId: string | null
): Promise<void> {
  await recordAdmission(deps, threadId, "outside_agent_launch");
}

async function recordAdmission(
  deps: ContextAdmissionDeps,
  threadId: string | null,
  path: AdmissionPath
): Promise<void> {
  if (!threadId) throw new Error("Conversation binding is unavailable for content admission");
  // Never expose a block while its durable admission is still pending or failed.
  try {
    await deps.recordForThread(threadId, path);
  } catch {
    throw new Error("Conversation provenance could not be recorded");
  }
}

export function prepareTurnText(input: {
  readonly userText: string;
  readonly timeContext: string;
  readonly mainReminders?: AdmittedContext | null;
  readonly passive: AdmittedContext | null;
  readonly crossTool: AdmittedContext | null;
  readonly notes: AdmittedContext | null;
  readonly attachmentManifest?: string;
  readonly moduleControl?: AdmittedContext | null;
}): PreparedTurn {
  const hidden = combineHiddenContextBlocks(input.passive, input.crossTool, input.notes);
  return Object.freeze({
    text: [
      input.timeContext,
      input.mainReminders?.text,
      hidden,
      input.userText,
      input.attachmentManifest,
      input.moduleControl?.text
    ]
      .filter((part) => part != null && part.length > 0)
      .join("\n\n"),
    [prepared]: true as const
  });
}

export async function submitPreparedTurn(
  engine: Pick<CliChatEngine, "submit">,
  turn: PreparedTurn
): Promise<void> {
  await engine.submit(turn.text);
}

export async function submitAdmittedContext(
  engine: Pick<CliChatEngine, "submit">,
  context: AdmittedContext
): Promise<void> {
  await engine.submit(context.text);
}
