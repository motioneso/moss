// #3309: the step before the classifier gate and the model. A recognised reminder request is
// answered by code from the user's own raw words, so no model output can create a reminder.

import type { ChatReminderOriginV1 } from "@moss/shared";

import { recognizeRelativeReminder } from "../reminders/recognizer.js";
import type { ReminderTurnPlan } from "../reminders/turn.js";
import { REMINDER_MAIN_ONLY_REPLY } from "../reminders/wording.js";
import type { ChatSurface } from "./chat-surface.js";
import {
  cancelledTurn,
  dropWarmSessionForGate,
  selectTurnThread,
  tryGatedTurn,
  type GateLifecycleHost
} from "./classifier-gate-lifecycle.js";

export const REMINDER_STORAGE_FAILURE_MESSAGE =
  "I couldn't save that reminder, so nothing is set. Try again in a moment.";

const REFUSED_ORIGIN: ChatReminderOriginV1 = {
  version: 1,
  kind: "reminder",
  event: "refused",
  reminderId: null
};

/** Same contract as tryGatedTurn. A request that is not a reminder goes to it unchanged. */
export async function tryPreModelTurn(
  ...args: Parameters<typeof tryGatedTurn>
): ReturnType<typeof tryGatedTurn> {
  const [host, actorUserId, surface, text, opts, controller] = args;
  const recognition = recognizeRelativeReminder(text);
  if (recognition.kind === "none") return tryGatedTurn(...args);

  const threadState = await selectTurnThread(host, actorUserId, surface);
  const requestIncognito = threadState?.incognito ?? false;
  const requestThreadId = threadState?.id ?? null;
  const done = (result: Awaited<ReturnType<typeof tryGatedTurn>>["result"]) => ({
    result,
    requestIncognito,
    requestThreadId
  });

  if (controller.signal.aborted) return done(cancelledTurn(host, actorUserId, surface));

  // A private chat keeps nothing, so the refusal is shown and never stored.
  if (requestIncognito) {
    return done(emitUnsaved(host, actorUserId, surface, text, REMINDER_MAIN_ONLY_REPLY));
  }

  // A module-controlled turn speaks for a module, not for the user, so it never saves.
  const plan: ReminderTurnPlan = opts?.moduleControl ? { kind: "main_only" } : recognition;
  const attachments = opts?.attachments ?? [];
  let stored: Awaited<ReturnType<NonNullable<typeof host.deps.persistence.recordReminderTurn>>>;
  try {
    stored = await host.deps.persistence.recordReminderTurn?.(
      actorUserId,
      text,
      plan,
      {
        threadId: requestThreadId,
        stopSignal: controller.signal,
        attachments:
          attachments.length > 0
            ? attachments.map((meta) => ({
                id: meta.id,
                fileName: meta.fileName,
                mimeType: meta.mimeType,
                sizeBytes: meta.sizeBytes
              }))
            : undefined
      },
      surface
    );
  } catch {
    stored = undefined;
  }
  if (stored === "stopped") return done(cancelledTurn(host, actorUserId, surface));
  if (!stored) {
    return done(emitUnsaved(host, actorUserId, surface, text, REMINDER_STORAGE_FAILURE_MESSAGE));
  }

  host.emit(actorUserId, surface, { kind: "user", text });
  host.emit(actorUserId, surface, {
    kind: "reply",
    text: stored.reply,
    messageId: stored.assistantMessageId,
    origin: stored.origin
  });

  // The warm model session never saw this turn, so the next model turn replays history.
  await dropWarmSessionForGate(host, actorUserId, surface);
  return done({
    reply: stored.reply,
    userMessageId: stored.userMessageId,
    assistantMessageId: stored.assistantMessageId
  });
}

function emitUnsaved(
  host: GateLifecycleHost,
  actorUserId: string,
  surface: ChatSurface,
  text: string,
  reply: string
): { reply: string } {
  host.emit(actorUserId, surface, { kind: "user", text });
  host.emit(actorUserId, surface, { kind: "reply", text: reply, origin: REFUSED_ORIGIN });
  return { reply };
}
