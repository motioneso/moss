/** Boolean-only session metadata. Private editor content stays in its owning module. */
export interface SessionUnsavedChangesStore {
  setQueryDefaults(key: readonly unknown[], options: { gcTime: number }): void;
  setQueryData(key: readonly unknown[], value: boolean): unknown;
  getQueriesData<T>(filters: {
    queryKey: readonly unknown[];
  }): Array<[readonly unknown[], T | undefined]>;
}
const PREFIX = ["session-unsaved-changes"] as const;

/** Markers survive navigation and are cleared with the authenticated query cache. */
export function setSessionUnsavedChanges(
  client: SessionUnsavedChangesStore,
  key: string,
  dirty: boolean
): void {
  client.setQueryDefaults(PREFIX, { gcTime: Infinity });
  client.setQueryData([...PREFIX, key], dirty);
}

export function hasSessionUnsavedChanges(client: SessionUnsavedChangesStore): boolean {
  return client.getQueriesData<boolean>({ queryKey: PREFIX }).some(([, dirty]) => dirty === true);
}

export function clearSessionUnsavedChanges(
  client: SessionUnsavedChangesStore,
  keyPrefix: string
): void {
  for (const [key] of client.getQueriesData<boolean>({ queryKey: PREFIX })) {
    if (typeof key[1] === "string" && key[1].startsWith(keyPrefix)) client.setQueryData(key, false);
  }
}
