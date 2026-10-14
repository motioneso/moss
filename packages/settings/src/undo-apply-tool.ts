import { assertDataContextDb } from "@moss/db";
import type { ToolExecute, ToolResult } from "@moss/module-sdk";
import { PreferenceRevisionConflictError, PreferencesRepository } from "@moss/structured-state";

import { QUIET_HOURS_PREFERENCE_KEY } from "./quiet-hours-application.js";
import { undoQuietHoursValue } from "./quiet-hours-authority.js";
import { freezeQuietHoursBeforeLocaleWrite, readQuietHoursForWrite } from "./quiet-hours-writer.js";
import { settingsUndoStack } from "./undo-stack.js";

const LOCALE_PREFERENCE_KEY = "locale";
const preferences = new PreferencesRepository();

export const settingsUndoLastInputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false
} as const;

export const settingsUndoLastOutputSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["undone", "cancelled", "nothing_to_undo"] },
    key: { type: ["string", "null"] },
    message: { type: "string" }
  },
  required: ["status", "key", "message"],
  additionalProperties: false
} as const;

// Undo pops the top entry for this (actor, chat) — popping itself consumes the entry, so a second
// "change that back" on the same mutation finds the stack already empty and cannot re-apply it.
export const settingsUndoLastExecute: ToolExecute = async (
  scopedDb,
  _input,
  ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const entry = settingsUndoStack.pop(ctx.actorUserId, ctx.chatSessionId);
  if (!entry) {
    return {
      data: { status: "nothing_to_undo", key: null, message: "There's nothing to undo." }
    };
  }
  try {
    let restoredValue = entry.previousValue;
    if (entry.key === QUIET_HOURS_PREFERENCE_KEY) {
      const current = await readQuietHoursForWrite(scopedDb);
      restoredValue = undoQuietHoursValue(current.input, entry.previousValue);
    } else if (entry.key === LOCALE_PREFERENCE_KEY) {
      await freezeQuietHoursBeforeLocaleWrite(scopedDb, preferences);
    }
    if (entry.previousValue === null && entry.previousRevision === null) {
      // The tracked write created this row from nothing — undo removes it rather than pinning
      // the old default back in (spec: undo over an absent row deletes the override).
      await preferences.deleteWithRevision(scopedDb, entry.key, entry.resultingRevision);
    } else {
      // CAS expectation is resultingRevision (the tracked write's OWN return value), not
      // previousRevision — the row is already at resultingRevision immediately after that write.
      await preferences.upsertWithRevision(
        scopedDb,
        entry.key,
        restoredValue,
        entry.resultingRevision
      );
    }
    return { data: { status: "undone", key: entry.key, message: "Changed that back." } };
  } catch (error) {
    if (error instanceof PreferenceRevisionConflictError) {
      return {
        data: {
          status: "cancelled",
          key: entry.key,
          message: "That setting changed again since, so I didn't undo it."
        }
      };
    }
    throw error;
  }
};
