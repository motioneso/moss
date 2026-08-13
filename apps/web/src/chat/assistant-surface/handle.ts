import { seedChat, sendChatTurn, uploadChatAttachment } from "../../api/client";
import { moduleChatSurface } from "../../shell/chat-surface-key";
import { useSyncExternalStore } from "react";
import type { ChatSurface } from "@moss/shared";

import type { AssistantSurfaceHandleV1, AssistantSurfaceViewProps } from "./contracts";
import { AssistantSurface } from "./surface";

/**
 * #1284 — module-level singleton: "which module surface (if any) currently owns the shell's one
 * chat stream." app-shell.tsx (#1196/#1232: "one external route mounts at a time") is the sole
 * subscriber, and turns that into an actual `useChatStream` surface switch plus the
 * `recordsForSurface` drawer-isolation check. A plain subscribable module value — not a new field
 * threaded through the AssistantSurfaceHostValue React context — is enough given that invariant,
 * and it keeps this wiring inside the two files this task owns (contracts.ts, handle.ts) instead of
 * reshaping the host context contract.
 */
let activeModuleSurface: string | null = null;
const activeModuleSurfaceListeners = new Set<(surface: string | null) => void>();

/**
 * #1495 — module-bound handles must claim a surface via `setSurfaceKey` before seed/turn/
 * subscribe; unclaimed use previously fell through to the user's drawer thread (write) or its
 * records (read). One shared no-op unsubscribe for the read-side no-op below — a stable reference
 * rather than a new closure per call.
 */
function unclaimedSurfaceMessage(moduleId: string, operation: string): string {
  return (
    `${moduleId} called ${operation} on its assistant surface before claiming one via ` +
    "setSurfaceKey (see assistant-surface/contracts.ts claim-before-use ordering)"
  );
}

function noopUnsubscribe(): void {}

function publishActiveModuleSurface(surface: string | null): void {
  if (surface === activeModuleSurface) return;
  activeModuleSurface = surface;
  for (const listener of activeModuleSurfaceListeners) listener(activeModuleSurface);
}

/** app-shell.tsx subscribes here to learn which surface (if any) should own the chat stream. */
export function subscribeActiveModuleSurface(
  listener: (surface: string | null) => void
): () => void {
  activeModuleSurfaceListeners.add(listener);
  return () => {
    activeModuleSurfaceListeners.delete(listener);
  };
}

/** Synchronous snapshot for `useSyncExternalStore` in app-shell.tsx. */
export function getActiveModuleSurface(): string | null {
  return activeModuleSurface;
}

/**
 * #1196/#1284 — build one AssistantSurface handle bound to the host-held `moduleId`. The module
 * itself never supplies a surface: `setSurfaceKey` takes an opaque key, and this handle combines it
 * with the host-bound `moduleId` via `moduleChatSurface` into the wire-safe surface every later
 * submitTurn/seedContext/subscribeRecords call is curried with, until the next setSurfaceKey call.
 */
export function createAssistantSurfaceHandle(
  subscribeRecords: AssistantSurfaceHandleV1["subscribeRecords"],
  moduleId?: string,
  seedComposer?: (draft: string) => void
): AssistantSurfaceHandleV1 {
  // Mutable across the handle's lifetime so setSurfaceKey can retarget every later call without
  // app.tsx needing to re-create the handle (its useMemo deps don't include the key).
  let currentSurface: ChatSurface | undefined;

  // With no host-bound moduleId, setSurfaceKey can never produce a surface (see below), so
  // currentSurface is permanently undefined — pass AssistantSurface straight through rather than
  // an always-identical wrapper, preserving reference identity for callers that compare it.
  const Surface = moduleId
    ? (props: AssistantSurfaceViewProps) => {
        const surface = useSyncExternalStore(
          subscribeActiveModuleSurface,
          getActiveModuleSurface,
          getActiveModuleSurface
        ) as ChatSurface | null;
        return AssistantSurface({ ...props, surface: surface ?? props.surface });
      }
    : AssistantSurface;

  return {
    Surface,
    seedComposer: (draft) => seedComposer?.(draft),
    setSurfaceKey(key) {
      // Fail closed on a missing host-bound moduleId (should never happen — app.tsx always
      // supplies one): a handle with no id cannot safely derive or claim a surface.
      const next =
        key !== null && moduleId ? (moduleChatSurface(moduleId, key) as ChatSurface) : undefined;
      currentSurface = next;
      publishActiveModuleSurface(next ?? null);
    },
    async seedContext(seed, idempotencyKey) {
      if (moduleId && currentSurface === undefined) {
        throw new Error(unclaimedSurfaceMessage(moduleId, "seedContext"));
      }
      await seedChat(seed, idempotencyKey, currentSurface);
    },
    async submitTurn(input) {
      if (moduleId && currentSurface === undefined) {
        throw new Error(unclaimedSurfaceMessage(moduleId, "submitTurn"));
      }
      await sendChatTurn(input.text, input.attachmentIds, input.controlContext, currentSurface);
    },
    async uploadAttachment(file) {
      const { attachment } = await uploadChatAttachment(file, file.name);
      return {
        id: attachment.id,
        fileName: attachment.fileName,
        sizeBytes: attachment.sizeBytes
      };
    },
    // Same rationale as Surface above: with no host-bound moduleId, currentSurface can never
    // become defined (setSurfaceKey fails closed), so pass subscribeRecords straight through
    // rather than an always-identical wrapper, preserving reference identity for callers that
    // compare it (this is also the ORIGINAL pre-#1284 pattern, just re-keyed on moduleId instead
    // of the old static `surface` param).
    subscribeRecords: moduleId
      ? (listener) => {
          if (currentSurface === undefined) {
            console.error(unclaimedSurfaceMessage(moduleId, "subscribeRecords"));
            return noopUnsubscribe;
          }
          return subscribeRecords(listener, currentSurface);
        }
      : subscribeRecords
  };
}
