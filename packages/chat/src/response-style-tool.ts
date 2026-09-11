import { assertDataContextDb } from "@moss/db";
import type { ToolExecute, ToolResult } from "@moss/module-sdk";
import { PreferencesRepository } from "@moss/structured-state";
import {
  CHAT_RESPONSE_STYLES,
  CHAT_SETTINGS_PREFERENCE_KEY,
  normalizeChatSettings,
  type ChatResponseStyle
} from "@moss/shared";

// Matches routes.ts's chat settings GET/PUT — both read/write the same preference row.
const preferences = new PreferencesRepository();

export const chatSetResponseStyleInputSchema = {
  type: "object",
  properties: { style: { type: "string", enum: [...CHAT_RESPONSE_STYLES] } },
  required: ["style"],
  additionalProperties: false
} as const;

export const chatSetResponseStyleOutputSchema = {
  type: "object",
  properties: { style: { type: "string", enum: [...CHAT_RESPONSE_STYLES] } },
  required: ["style"],
  additionalProperties: false
} as const;

export const chatSetResponseStyleExecute: ToolExecute = async (
  scopedDb,
  input
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const { style } = input as { style: ChatResponseStyle };
  const current = await preferences.getWithRevision(scopedDb, CHAT_SETTINGS_PREFERENCE_KEY);
  const next = normalizeChatSettings({
    ...normalizeChatSettings(current?.value),
    responseStyle: style
  });
  await preferences.upsertWithRevision(
    scopedDb,
    CHAT_SETTINGS_PREFERENCE_KEY,
    next,
    current?.revision ?? null
  );
  return { data: { style: next.responseStyle } };
};
