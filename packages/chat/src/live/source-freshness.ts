import type { DataContextDb } from "@moss/db";
import type { SourceFreshnessEntry, SourceFreshnessV1 } from "@moss/shared";

export function toolNameToSource(toolName: string): string | null {
  if (toolName.startsWith("email.")) return "email";
  if (toolName.startsWith("calendar.")) return "calendar";
  if (toolName.startsWith("vault.") || toolName.startsWith("notes.")) return "vault";
  if (toolName.startsWith("tasks.")) return "tasks";
  if (toolName.startsWith("commitments.")) return "commitments";
  if (toolName.startsWith("chat.")) return "chats";
  if (toolName.startsWith("goals.")) return "goals";
  return null;
}

const CONNECTOR_SOURCES_CHAT = new Set(["email", "calendar"]);
const REALTIME_SOURCES_CHAT = new Set(["tasks", "commitments", "chats", "goals"]);

export async function resolveChatFreshness(
  scopedDb: DataContextDb,
  invokedToolNames: ReadonlySet<string>,
  capturedAt: Date,
  opts: {
    connectorSyncAt?: (scopedDb: DataContextDb, kind: "email" | "calendar") => Promise<Date | null>;
  }
): Promise<SourceFreshnessV1 | null> {
  const sourceKeys = new Set<string>();
  for (const name of invokedToolNames) {
    const source = toolNameToSource(name);
    if (source) sourceKeys.add(source);
  }
  if (sourceKeys.size === 0) return null;

  const capturedAtIso = capturedAt.toISOString();
  const entries: SourceFreshnessEntry[] = [];
  for (const source of sourceKeys) {
    if (REALTIME_SOURCES_CHAT.has(source)) {
      entries.push({ source, freshnessKind: "realtime", asOf: capturedAtIso });
    } else if (CONNECTOR_SOURCES_CHAT.has(source)) {
      let asOf: string | null = null;
      try {
        const t = (await opts.connectorSyncAt?.(scopedDb, source as "email" | "calendar")) ?? null;
        asOf = t ? t.toISOString() : null;
      } catch {
        // keep asOf as null on error
      }
      entries.push({ source, freshnessKind: "connector_sync", asOf });
    } else {
      // vault — V1: asOf: null (no vaultLastWriteAt dep for chat)
      entries.push({ source, freshnessKind: "vault_write", asOf: null });
    }
  }

  return { version: 1, capturedAt: capturedAtIso, sources: entries };
}
