import { createHash } from "node:crypto";

import { PreferencesRepository } from "@moss/structured-state";

import {
  advanceWorkMailCursor,
  isNewerThanCursor,
  parseWorkMailCursor,
  WORK_MAIL_CURSOR_KEY
} from "./cursor.js";
import { formatWorkMailEntry } from "./entry.js";
import { validateWorkMailJudgement } from "./judge.js";
import {
  WORK_MAIL_BODY_MAX_CHARS,
  WORK_MAIL_MAX_PER_RUN,
  type WorkMailIngest,
  type WorkMailJudgeInput
} from "./types.js";

export const ingestWorkMail: WorkMailIngest = async (
  dataContext,
  access,
  messages,
  ports,
  signal
) => {
  return dataContext.withDataContext(access, async (db) => {
    const preferences = new PreferencesRepository();
    await preferences.lock(db, WORK_MAIL_CURSOR_KEY);
    let cursor = parseWorkMailCursor(await preferences.get(db, WORK_MAIL_CURSOR_KEY));
    let processed = 0;
    let stoppedAt: number | null = null;
    const ordered = [...messages].sort(
      (first, second) => Date.parse(first.receivedAt) - Date.parse(second.receivedAt)
    );
    for (const captured of ordered) {
      if (processed >= WORK_MAIL_MAX_PER_RUN) break;
      if (signal?.aborted) break;
      if (!isNewerThanCursor(cursor, captured)) continue;
      const message = {
        ...captured,
        body: captured.body.slice(0, WORK_MAIL_BODY_MAX_CHARS),
        bodyTruncated: captured.bodyTruncated || captured.body.length > WORK_MAIL_BODY_MAX_CHARS
      };
      try {
        const input: WorkMailJudgeInput = {
          message,
          preferences: await ports.preferences.list(db, access.actorUserId),
          senderContext: await ports.people.senderContext(db, access.actorUserId, message.sender),
          candidates: (
            await ports.notes.candidates(
              db,
              access,
              `${message.sender.slice(0, 500)} ${message.subject.slice(0, 1_000)}`,
              5
            )
          ).slice(0, 5)
        };
        if (signal?.aborted) break;
        const judgement = validateWorkMailJudgement(await ports.judge(db, input, signal), input);
        if (signal?.aborted) break;
        if (judgement.decision === "note" && judgement.target && judgement.entry) {
          const target = judgement.target;
          const path =
            target.kind === "default"
              ? "default"
              : input.candidates.find((candidate) => candidate.index === target.index)?.path;
          if (!path) throw new Error("ai-invalid");
          const identity = createHash("sha256")
            .update(
              JSON.stringify([
                access.actorUserId,
                message.sender,
                message.subject,
                message.receivedAt
              ])
            )
            .digest("hex");
          const entry =
            `\n<!-- work-mail:${identity} -->` +
            formatWorkMailEntry(message, judgement.entry, ports.now());
          let result = await ports.notes.append(db, access, path, entry);
          if (result === "changed" && !signal?.aborted) {
            result = await ports.notes.append(db, access, path, entry);
          }
          if (result !== "written") throw new Error("vault-unavailable");
        }
      } catch {
        stoppedAt = processed;
        break;
      }
      cursor = advanceWorkMailCursor(cursor, message);
      await preferences.upsert(db, WORK_MAIL_CURSOR_KEY, cursor);
      processed++;
    }
    return { processed, stoppedAt, cursor };
  });
};
