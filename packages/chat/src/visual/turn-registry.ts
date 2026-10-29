import { randomUUID } from "node:crypto";

import {
  VISUAL_REPLY_VERSION,
  tryCopyVisualSnapshot,
  validateVisualProposal,
  validateVisualReply,
  type Brand,
  type VisualFailureCode,
  type VisualInteractionV1,
  type VisualReplyV1,
  type VisualSnapshotV1
} from "@moss/shared";

/**
 * Per-turn store of normalizer-approved snapshots.
 *
 * It is a lifetime and reference boundary only. It trusts input that module read adapters have
 * already authorized for this actor and conversation, and it never replaces actor-scoped reads
 * or RLS.
 *
 * Lifecycle: the turn-finalization code creates one instance from captured host identity when a
 * turn starts, registers snapshots while the turn runs, calls `finalize` once before saving the
 * reply, then `close` after commit or `discard` on cancellation or failure. References are
 * random, valid only in the issuing instance, and unreachable once the instance is done.
 */

export const REGISTRY_LIMITS = { snapshots: 16, totalBytes: 128 * 1024 } as const;

export interface VisualTurnIdentity {
  actorUserId: string;
  threadId: string;
  turnId: string;
}

/** Explicit normalized fields only; `ref` is minted here and extra properties are rejected. */
export type VisualSnapshotInput = Omit<VisualSnapshotV1, "ref">;

export type TrustedVisualReply = Brand<VisualReplyV1, "TrustedVisualReply">;

export type RegistryFailureCode =
  | VisualFailureCode
  | "closed"
  | "foreign_context"
  | "unknown_reference"
  | "registry_full";

export type RegisterResult = { ok: true; ref: string } | { ok: false; code: RegistryFailureCode };

export type FinalizeResult =
  | { ok: true; reply: TrustedVisualReply }
  | { ok: false; code: RegistryFailureCode; fallbackText: string };

export type RegistryState = "open" | "closed" | "discarded";

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export class VisualTurnRegistry {
  private readonly identity: VisualTurnIdentity;
  private readonly snapshots = new Map<string, VisualSnapshotV1>();
  private bytes = 0;
  private current: RegistryState = "open";

  constructor(identity: VisualTurnIdentity) {
    this.identity = { ...identity };
  }

  get state(): RegistryState {
    return this.current;
  }

  register(identity: VisualTurnIdentity, input: VisualSnapshotInput): RegisterResult {
    const guard = this.guard(identity);
    if (guard) return { ok: false, code: guard };
    if (this.snapshots.size >= REGISTRY_LIMITS.snapshots) {
      return { ok: false, code: "registry_full" };
    }
    const copied = tryCopyVisualSnapshot({ ...input, ref: `vs_${randomUUID()}` });
    if (!copied.ok) return { ok: false, code: copied.code };
    const snapshot = copied.snapshot;
    const size = new TextEncoder().encode(JSON.stringify(snapshot)).length;
    if (this.bytes + size > REGISTRY_LIMITS.totalBytes) {
      return { ok: false, code: "registry_full" };
    }
    this.bytes += size;
    this.snapshots.set(snapshot.ref, deepFreeze(snapshot));
    return { ok: true, ref: snapshot.ref };
  }

  /**
   * Turns a model proposal into a trusted reply. Every reference must have been issued by this
   * instance; only referenced snapshots enter the reply; ids are minted here.
   */
  finalize(identity: VisualTurnIdentity, proposal: unknown, fallbackText: string): FinalizeResult {
    const fail = (code: RegistryFailureCode): FinalizeResult => ({ ok: false, code, fallbackText });
    const guard = this.guard(identity);
    if (guard) return fail(guard);
    const parsed = validateVisualProposal(proposal);
    if (!parsed.ok) return fail(parsed.code);
    const { blocks, interactions, catalogVersion } = parsed.proposal;
    const referenced = new Set<string>();
    for (const block of blocks) block.snapshotRefs.forEach((ref) => referenced.add(ref));
    for (const interaction of interactions) {
      if (interaction.snapshotRef) referenced.add(interaction.snapshotRef);
    }
    for (const ref of referenced) {
      if (!this.snapshots.has(ref)) return fail("unknown_reference");
    }
    const blockIds = blocks.map(() => `b_${randomUUID()}`);
    const reply: VisualReplyV1 = {
      version: VISUAL_REPLY_VERSION,
      catalogVersion,
      blocks: blocks.map((block, index) => ({ blockId: blockIds[index]!, ...block })),
      snapshots: [...referenced].map((ref) => this.snapshots.get(ref)!),
      interactions: interactions.map(
        ({ blockIndex, ...rest }): VisualInteractionV1 => ({
          interactionId: `i_${randomUUID()}`,
          blockId: blockIds[blockIndex]!,
          ...rest
        })
      ),
      fallbackText
    };
    // Re-validation copies the snapshots, so the reply never shares objects with the store.
    const checked = validateVisualReply(reply);
    if (!checked.ok) return fail(checked.code);
    return { ok: true, reply: deepFreeze(checked.reply) as TrustedVisualReply };
  }

  /** Ends the turn after the reply is committed. Nothing works afterwards. */
  close(identity: VisualTurnIdentity): void {
    if (this.guard(identity)) return;
    this.end("closed");
  }

  /** Ends the turn on cancellation or failure and drops pending snapshots. */
  discard(identity: VisualTurnIdentity): void {
    if (this.guard(identity)) return;
    this.end("discarded");
  }

  private end(state: RegistryState): void {
    this.current = state;
    this.snapshots.clear();
    this.bytes = 0;
  }

  private guard(identity: VisualTurnIdentity): RegistryFailureCode | null {
    if (
      identity.actorUserId !== this.identity.actorUserId ||
      identity.threadId !== this.identity.threadId ||
      identity.turnId !== this.identity.turnId
    ) {
      return "foreign_context";
    }
    return this.current === "open" ? null : "closed";
  }
}
