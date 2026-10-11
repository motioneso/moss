import type { ChatSurface } from "@moss/shared";

import { getChatPrivacyState } from "../api/client";

// #3195: after a chat change settles, name Main only if the drawer now shows it, so the stream
// keeps accepting reminders there. Any doubt answers no, which drops them until the next reload.
export async function shownMainThread(
  surface: ChatSurface,
  mainThreadId: string | undefined
): Promise<string | undefined> {
  if (!mainThreadId) return undefined;
  const shown = await getChatPrivacyState(surface).catch(() => undefined);
  return shown && !shown.incognito && shown.threadId === mainThreadId ? mainThreadId : undefined;
}
