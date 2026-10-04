import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

import { getPersonaSettings } from "./client.js";
import { queryKeys } from "./query-keys.js";

// Single source for the name users see for their assistant (Settings → AI persona).
// Every user-visible "Moss" routes through here: the hook in components, `assistantName()`
// and `personalize()` in plain code.
//
// The last name the persona query returned is kept in localStorage, so screens that render
// before anyone is signed in (loading, sign-in) show it rather than flashing "Moss". Once a
// user is signed in, only that user's own name may show: the saved name carries over only when
// it was saved for the same user, and otherwise the default shows until their persona loads.

export const DEFAULT_ASSISTANT_NAME = "Moss";
export const ASSISTANT_NAME_STORAGE_KEY = "moss.assistantName";
export const ASSISTANT_NAME_OWNER_STORAGE_KEY = "moss.assistantNameOwner";

function readStored(key: string): string {
  try {
    return globalThis.localStorage?.getItem(key)?.trim() || "";
  } catch {
    return "";
  }
}

function readSaved(): string {
  return readStored(ASSISTANT_NAME_STORAGE_KEY);
}

let current: string = readSaved() || DEFAULT_ASSISTANT_NAME;
// Signed-in user the name belongs to, null before sign-in. `epoch` changes with every identity
// change so a persona request started for an earlier identity cannot write its name back.
let activeUserId: string | null = null;
let epoch = 0;
const listeners = new Set<() => void>();

const MANIFEST_URL = "/manifest.webmanifest";
let manifestBase: Promise<Record<string, unknown> | null> | null = null;
let manifestBlobUrl: string | null = null;

// Installing the app reads the manifest link, so it points at a copy carrying the current name.
// The static file keeps the default name and is restored when the name is the default.
function syncManifest(): void {
  if (typeof document === "undefined" || typeof fetch !== "function") return;
  const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (!link) return;
  if (current === DEFAULT_ASSISTANT_NAME) {
    link.setAttribute("href", MANIFEST_URL);
    return;
  }
  const forName = current;
  manifestBase ??= fetch(MANIFEST_URL)
    .then((response) =>
      response.ok ? (response.json() as Promise<Record<string, unknown>>) : null
    )
    .catch(() => null);
  void manifestBase.then((base) => {
    if (!base || forName !== current) return;
    const origin = globalThis.location.origin;
    const icons = Array.isArray(base.icons)
      ? base.icons.map((icon: { src: string }) => ({ ...icon, src: origin + icon.src }))
      : base.icons;
    const next = {
      ...base,
      name: forName,
      short_name: forName,
      description: personalize(String(base.description ?? ""), forName),
      start_url: origin + String(base.start_url ?? "/"),
      scope: origin + String(base.scope ?? "/"),
      icons
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(next)], { type: "application/json" }));
    if (manifestBlobUrl) URL.revokeObjectURL(manifestBlobUrl);
    manifestBlobUrl = url;
    link.setAttribute("href", url);
  });
}

function syncDocumentTitle(): void {
  if (typeof document === "undefined") return;
  document.title = current;
  syncManifest();
}
syncDocumentTitle();

function applyName(next: string, deferNotify = false): void {
  if (next === current) return;
  current = next;
  syncDocumentTitle();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  // Binding runs during a render, where notifying mounted components would be a React error.
  if (deferNotify) queueMicrotask(notify);
  else notify();
}

/** Records the name loaded from the persona. An empty name resets to the default. */
export function rememberAssistantName(name: string | null | undefined): void {
  const next = name?.trim() || DEFAULT_ASSISTANT_NAME;
  try {
    if (next === DEFAULT_ASSISTANT_NAME) {
      globalThis.localStorage?.removeItem(ASSISTANT_NAME_STORAGE_KEY);
      globalThis.localStorage?.removeItem(ASSISTANT_NAME_OWNER_STORAGE_KEY);
    } else {
      globalThis.localStorage?.setItem(ASSISTANT_NAME_STORAGE_KEY, next);
      if (activeUserId) {
        globalThis.localStorage?.setItem(ASSISTANT_NAME_OWNER_STORAGE_KEY, activeUserId);
      } else {
        globalThis.localStorage?.removeItem(ASSISTANT_NAME_OWNER_STORAGE_KEY);
      }
    }
  } catch {
    // Storage can be blocked; the in-memory name still applies for this page.
  }
  applyName(next);
}

/**
 * Ties the active name to the signed-in user (null when signed out). Before sign-in the last
 * saved name shows. After sign-in the saved name shows only when it was saved for this same
 * user, so another person's name never carries over, even if their persona fails to load.
 */
export function bindAssistantUser(userId: string | null): void {
  if (userId === activeUserId) return;
  activeUserId = userId;
  epoch += 1;
  if (userId === null) {
    applyName(readSaved() || DEFAULT_ASSISTANT_NAME, true);
    return;
  }
  const savedForThisUser = readStored(ASSISTANT_NAME_OWNER_STORAGE_KEY) === userId;
  applyName((savedForThisUser && readSaved()) || DEFAULT_ASSISTANT_NAME, true);
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
  // A callback keeps names such as "$&" literal instead of being read as replacement tokens.
  return name === DEFAULT_ASSISTANT_NAME ? text : text.replace(/\bMoss\b/g, () => name);
}

/**
 * Like personalize, for markdown. Code spans, code fences, link targets and bare URLs keep their
 * text, so paths, links and identifiers that contain the word "Moss" stay valid.
 */
export function personalizeMarkdown(markdown: string, name: string = current): string {
  if (name === DEFAULT_ASSISTANT_NAME) return markdown;
  const protectedText = /```[\s\S]*?```|`[^`\n]*`|\]\([^)\n]*\)|https?:\/\/\S+/g;
  let out = "";
  let last = 0;
  for (const match of markdown.matchAll(protectedText)) {
    out += personalize(markdown.slice(last, match.index), name) + match[0];
    last = match.index + match[0].length;
  }
  return out + personalize(markdown.slice(last), name);
}

export async function loadPersonaSettings(): Promise<
  Awaited<ReturnType<typeof getPersonaSettings>>
> {
  const startedFor = epoch;
  const result = await getPersonaSettings();
  if (startedFor === epoch) rememberAssistantName(result.persona.assistantName);
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
