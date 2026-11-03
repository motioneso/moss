import type { DataContextDb, PreferencesPort } from "@moss/db";
import {
  CHAT_SETTINGS_PREFERENCE_KEY,
  mergeChatSettings,
  type ChatSettingsDto,
  type ChatSettingsUpdateDto
} from "@moss/shared";

/** Merges a save into the caller's stored chat settings and writes the result. */
export async function saveChatSettings(
  db: DataContextDb,
  preferences: Pick<PreferencesPort, "get" | "upsert">,
  update: ChatSettingsUpdateDto
): Promise<ChatSettingsDto> {
  const stored = await preferences.get(db, CHAT_SETTINGS_PREFERENCE_KEY);
  const next = mergeChatSettings(stored, update);
  await preferences.upsert(db, CHAT_SETTINGS_PREFERENCE_KEY, next);
  return next;
}
