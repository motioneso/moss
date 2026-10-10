import { randomUUID } from "node:crypto";

import { assertDataContextDb } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import type { ToolExecute, ToolResult } from "@moss/module-sdk";
import { PreferenceRevisionConflictError, PreferencesRepository } from "@moss/structured-state";

import {
  applyQuietHoursEdit,
  normalizeQuietHours,
  QUIET_HOURS_PREFERENCE_KEY
} from "./quiet-hours-application.js";
import { settingsUndoStack } from "./undo-stack.js";

const MAX_WRITE_ATTEMPTS = 3;

const preferences = new PreferencesRepository();

export const quietHoursSetInputSchema = {
  type: "object",
  properties: {
    enabled: { type: "boolean" },
    start: { type: "string" },
    end: { type: "string" },
    timezone: {
      type: ["string", "null"],
      description: "Leave out to keep the saved time zone. Send null to clear it."
    }
  },
  required: ["enabled", "start", "end"],
  additionalProperties: false
} as const;

export const quietHoursOutputSchema = {
  type: "object",
  properties: {
    enabled: { type: "boolean" },
    start: { type: "string" },
    end: { type: "string" },
    timezone: { type: ["string", "null"] }
  },
  required: ["enabled", "start", "end", "timezone"],
  additionalProperties: false
} as const;

export const quietHoursSetExecute: ToolExecute = async (
  scopedDb,
  input,
  ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const {
    enabled,
    start,
    end,
    timezone: rawTimezone
  } = input as {
    enabled: boolean;
    start: string;
    end: string;
    timezone?: string | null;
  };

  // The row lock serialises this write against REST saves; the retry only covers a concurrent
  // first insert of an absent row.
  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
    const current = await preferences.getVersioned(scopedDb, QUIET_HOURS_PREFERENCE_KEY, {
      forUpdate: true
    });
    const edit = applyQuietHoursEdit(
      current?.value,
      {
        enabled,
        start,
        end,
        // An omitted timezone keeps the saved one; an explicit null clears it.
        timezone:
          rawTimezone === undefined ? normalizeQuietHours(current?.value).timezone : rawTimezone
      },
      current !== null
    );
    if (!edit.changed) return { data: { ...edit.effective } };

    let written: { revision: number };
    try {
      written = await preferences.upsertWithRevision(
        scopedDb,
        QUIET_HOURS_PREFERENCE_KEY,
        edit.next,
        current?.revision ?? null
      );
    } catch (error) {
      if (error instanceof PreferenceRevisionConflictError && attempt < MAX_WRITE_ATTEMPTS)
        continue;
      if (error instanceof PreferenceRevisionConflictError) {
        throw new HttpError(409, "Quiet hours changed while saving. Ask again to retry.");
      }
      throw error;
    }
    settingsUndoStack.push(ctx.actorUserId, ctx.chatSessionId, {
      mutationId: randomUUID(),
      key: QUIET_HOURS_PREFERENCE_KEY,
      previousValue: current?.value ?? null,
      previousRevision: current?.revision ?? null,
      resultingRevision: written.revision,
      appliedAt: Date.now()
    });
    return { data: { ...edit.effective } };
  }
  throw new HttpError(409, "Quiet hours changed while saving. Ask again to retry.");
};
