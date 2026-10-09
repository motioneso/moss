const CHAT_DRAFTS_STORAGE_KEY = "moss.chatDrafts";
const MAIN_DRAFT_KEY = "__main__";

export type ChatDrafts = Record<string, string>;

export function unselectedDraftKey(surface: string): string {
  return surface === "drawer" ? MAIN_DRAFT_KEY : `__surface__:${surface}`;
}

export function boundDraftKey(surface: string, threadId: string): string {
  return `${unselectedDraftKey(surface)}:bound:${threadId}`;
}

export function moveUnselectedDraft(
  drafts: ChatDrafts,
  fallbackKey: string,
  threadId: string
): ChatDrafts {
  const text = drafts[fallbackKey];
  if (text === undefined || drafts[threadId] !== undefined) return drafts;
  const { [fallbackKey]: _initial, ...rest } = drafts;
  return { ...rest, [threadId]: text };
}

/** Moves a genuine unresolved module edit without overwriting a canonical thread draft. */
export function bindUnselectedDraft(
  drafts: ChatDrafts,
  surface: string,
  threadId: string
): ChatDrafts {
  const fallbackKey = unselectedDraftKey(surface);
  const text = drafts[fallbackKey];
  if (!text) return drafts;
  const destination = drafts[threadId] === undefined ? threadId : boundDraftKey(surface, threadId);
  if (drafts[destination] !== undefined) return drafts;
  const { [fallbackKey]: _fallback, ...rest } = drafts;
  return { ...rest, [destination]: text };
}

type StoredChatDrafts = {
  readonly ownerId: string;
  readonly drafts: unknown;
};

export function loadChatDrafts(ownerId: string | undefined): ChatDrafts {
  if (!ownerId) return {};
  try {
    const stored = JSON.parse(
      globalThis.localStorage.getItem(CHAT_DRAFTS_STORAGE_KEY) ?? "{}"
    ) as StoredChatDrafts;
    if (!stored || typeof stored !== "object" || stored.ownerId !== ownerId) return {};
    if (!stored.drafts || typeof stored.drafts !== "object" || Array.isArray(stored.drafts)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(stored.drafts).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string"
      )
    );
  } catch {
    return {};
  }
}

/** Keeps durable drafts bound to the signed-in owner; private drafts never reach browser storage. */
export function saveChatDrafts(ownerId: string | undefined, drafts: ChatDrafts): void {
  if (!ownerId) return;
  try {
    const persisted = Object.fromEntries(
      Object.entries(drafts).filter(([threadId, draft]) => threadId !== "__private__" && draft)
    );
    if (Object.keys(persisted).length === 0) {
      globalThis.localStorage?.removeItem(CHAT_DRAFTS_STORAGE_KEY);
      return;
    }
    globalThis.localStorage?.setItem(
      CHAT_DRAFTS_STORAGE_KEY,
      JSON.stringify({ ownerId, drafts: persisted })
    );
  } catch {
    // Browser storage can be blocked; drafts remain usable for the current page.
  }
}
