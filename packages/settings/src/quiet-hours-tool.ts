import { randomUUID } from "node:crypto";

import { assertDataContextDb } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import type { ToolExecute, ToolResult } from "@moss/module-sdk";
import { PreferenceRevisionConflictError, PreferencesRepository } from "@moss/structured-state";

import { QUIET_HOURS_PREFERENCE_KEY } from "./quiet-hours-application.js";
import { readQuietHoursAuthority } from "./quiet-hours-authority.js";
import {
  displayedQuietHours,
  quietHoursAuthorityDto,
  readQuietHoursForWrite,
  saveQuietHours
} from "./quiet-hours-writer.js";
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
    timezone: { type: ["string", "null"] },
    authority: {
      type: "object",
      description:
        "A conflict means alert cards still follow the older alerts schedule until the owner settles it.",
      properties: {
        status: {
          type: "string",
          enum: ["default", "carried", "canonical", "conflict", "malformed"]
        },
        alerts: {
          type: ["object", "null"],
          properties: {
            enabled: { type: "boolean" },
            start: { type: "string" },
            end: { type: "string" }
          },
          required: ["enabled", "start", "end"],
          additionalProperties: false
        }
      },
      required: ["status", "alerts"],
      additionalProperties: false
    }
  },
  required: ["enabled", "start", "end", "timezone", "authority"],
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

  // The advisory lock serialises this write against every other quiet-hours writer; the retry
  // only covers a writer that skipped the lock.
  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
    const before = await readQuietHoursForWrite(scopedDb);
    let saved;
    try {
      saved = await saveQuietHours(scopedDb, preferences, before, {
        enabled,
        start,
        end,
        // An omitted timezone keeps the current one; an explicit null clears it.
        timezone: rawTimezone === undefined ? displayedQuietHours(before).timezone : rawTimezone
      });
    } catch (error) {
      if (error instanceof PreferenceRevisionConflictError && attempt < MAX_WRITE_ATTEMPTS)
        continue;
      if (error instanceof PreferenceRevisionConflictError) {
        throw new HttpError(409, "Quiet hours changed while saving. Ask again to retry.");
      }
      throw error;
    }
    if (saved.changed && saved.revision !== null) {
      settingsUndoStack.push(ctx.actorUserId, ctx.chatSessionId, {
        mutationId: randomUUID(),
        key: QUIET_HOURS_PREFERENCE_KEY,

        // The whole prior row, migration marker included, so undo restores the prior authority.
        previousValue: before.profileRow?.value ?? null,
        previousRevision: before.profileRow?.revision ?? null,
        resultingRevision: saved.revision,
        appliedAt: Date.now()
      });
    }
    const after = await readQuietHoursAuthority(scopedDb);
    return { data: { ...saved.effective, authority: quietHoursAuthorityDto(after) } };
  }
  throw new HttpError(409, "Quiet hours changed while saving. Ask again to retry.");
};
