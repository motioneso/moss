import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

import { getPersonaSettings } from "./client.js";
import { queryKeys } from "./query-keys.js";

// Single source for the name users see for their assistant (Settings → AI persona).
// Every user-visible "Moss" routes through here: the hook in components, `assistantName()`
// and `personalize()` in plain code.
//
// The last name the persona query returned is kept in localStorage, so screens that render
// before the query resolves (loading, sign-in, the first paint of the shell) show it rather
// than flashing "Moss". "Moss" is the fallback only when no name was ever saved.

export const DEFAULT_ASSISTANT_NAME = "Moss";
export const ASSISTANT_NAME_STORAGE_KEY = "moss.assistantName";

function readSaved(): string {
  try {
    return globalThis.localStorage?.getItem(ASSISTANT_NAME_STORAGE_KEY)?.trim() || "";
  } catch {
    return "";
  }
}

let current: string = readSaved() || DEFAULT_ASSISTANT_NAME;
const listeners = new Set<() => void>();

function syncDocumentTitle(): void {
  if (typeof document !== "undefined") document.title = current;
}
syncDocumentTitle();

/** Records the name loaded from the persona. An empty name resets to the default. */
export function rememberAssistantName(name: string | null | undefined): void {
  const next = name?.trim() || DEFAULT_ASSISTANT_NAME;
  try {
    if (next === DEFAULT_ASSISTANT_NAME) {
      globalThis.localStorage?.removeItem(ASSISTANT_NAME_STORAGE_KEY);
    } else {
      globalThis.localStorage?.setItem(ASSISTANT_NAME_STORAGE_KEY, next);
    }
  } catch {
    // Storage can be blocked; the in-memory name still applies for this page.
  }
  if (next === current) return;
  current = next;
  syncDocumentTitle();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Current assistant name for code outside React (constants, toasts, document title). */
export function assistantName(): string {
  return current;
}

/** Swaps the word "Moss" in fixed copy for the current assistant name. */
export function personalize(text: string, name: string = current): string {
  return name === DEFAULT_ASSISTANT_NAME ? text : text.replace(/\bMoss\b/g, name);
}

export async function loadPersonaSettings(): Promise<
  Awaited<ReturnType<typeof getPersonaSettings>>
> {
  const result = await getPersonaSettings();
  rememberAssistantName(result.persona.assistantName);
  return result;
}

/**
 * `pendingFallback` is kept for existing callers. While the persona loads, the last saved
 * name is used, so it only matters when no name was ever saved.
 */
export function useAssistantName(pendingFallback?: string): string {
  const saved = useSyncExternalStore(subscribe, assistantName, () => DEFAULT_ASSISTANT_NAME);
  const query = useQuery({
    queryKey: queryKeys.settings.persona,
    queryFn: loadPersonaSettings,
    retry: false
  });
  const loaded = query.data?.persona.assistantName?.trim();
  if (loaded) return loaded;
  if (query.isLoading && saved === DEFAULT_ASSISTANT_NAME && pendingFallback !== undefined)
    return pendingFallback;
  return saved;
}
