import type { ModuleDto, TranscriptRecord } from "@moss/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { resolveQueryKeyToken } from "../api/query-keys.js";

/** Resolve declared cache effects without ever falling back to a blanket invalidation. */
export function actionRefreshQueryKeys(
  record: TranscriptRecord,
  modules: readonly ModuleDto[]
): readonly (readonly unknown[])[] {
  if (record.kind !== "action_result" || record.outcome !== "executed") return [];
  const moduleIds = new Set((record.affectsModules ?? []).filter((id) => id.length > 0));
  const tokens = new Set([
    ...(record.affectsQueryKeys ?? []),
    ...modules.flatMap((module) =>
      moduleIds.has(module.id) ? (module.chatRefreshTokens ?? []) : []
    )
  ]);
  const keys: (readonly unknown[])[] = [...moduleIds].map((id) => [id]);
  for (const token of tokens) {
    const key = resolveQueryKeyToken(token);
    if (key) keys.push(key);
  }
  return [...new Map(keys.map((key) => [JSON.stringify(key), key])).values()];
}

/** The shell owns this effect even when its drawer is closed. */
export function useActionQueryRefresh(
  records: readonly TranscriptRecord[],
  modules: readonly ModuleDto[],
  modulesLoading: boolean
): void {
  const queryClient = useQueryClient();
  const refreshed = useRef(new Set<string>());
  useEffect(() => {
    // Wait for token declarations rather than marking an early SSE result handled without them.
    if (modulesLoading) return;
    for (const record of records) {
      const id = record.actionRequestId;
      if (!id || refreshed.current.has(id)) continue;
      const keys = actionRefreshQueryKeys(record, modules);
      if (keys.length === 0) continue;
      refreshed.current.add(id);
      for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey });
    }
  }, [records, modules, modulesLoading, queryClient]);
}
