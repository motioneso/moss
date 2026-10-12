import { recognizeReminderEdit } from "../reminders/edit-recognizer.js";
import { namesScheduledRead } from "../scheduled-reads/request.js";
import { typedDeletionAgreement, isDeletionNearMiss } from "../reminders/delete-agreement.js";
// #3309: reminder commands run before the classifier; edits and reads use validated model terms.
// #3310: the same holds for listing and cancelling.

import type { ChatReminderOriginV1 } from "@moss/shared";

import { namesQuietHoursReminder } from "../reminders/quiet-hours-recognizer.js";
import { recognizeReminderPlan } from "../reminders/commands.js";
import type { ReminderTurnPlan } from "../reminders/turn.js";
import { REMINDER_MAIN_ONLY_REPLY, REMINDER_MANAGE_MAIN_ONLY_REPLY } from "../reminders/wording.js";
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

export const REMINDER_MANAGE_FAILURE_MESSAGE =
  "I couldn't reach your reminders, so nothing changed. Try again in a moment.";

export const REMINDER_AGREEMENT_FAILURE_MESSAGE =
  "I could not check that just now. Nothing changed, ask again.";

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
  const [host, actorUserId, surface, text, opts, controller, flushActions] = args;
  let recognition: ReminderTurnPlan | undefined;
  if (!opts?.moduleControl && !opts?.attachments?.length && namesScheduledRead(text)) {
    const thread = await (args[7] ?? selectTurnThread(host, actorUserId, surface));
    const main = await host.deps.persistence.getMainThreadState?.(actorUserId);
    if (!thread?.id || thread.incognito || main?.id !== thread.id)
      recognition = { kind: "main_only" };
    else {
      try {
        recognition = await host.deps.persistence.resolveScheduledReadRequest?.(
          actorUserId,
          text,
          controller.signal
        );
        if (
          recognition?.kind === "scheduled_read" &&
          (!recognition.taskId || !recognition.when) &&
          !recognition.failure
        )
          recognition = undefined;
      } catch {
        recognition = {
          kind: "scheduled_read",
          failure: "unavailable",
          taskId: null,
          title: "",
          when: null
        };
      }
    }
  }
  if (recognizeReminderEdit(text) && (opts?.moduleControl || opts?.attachments?.length))
    recognition = {
      kind: "edit_refused",
      reply: "Type the reminder edit directly in Main chat without attachments. Nothing changed."
    };
  if (!recognizeReminderEdit(text)) recognition ??= recognizeReminderPlan(text);
  if (recognition?.kind === "quiet_allowance" && !namesQuietHoursReminder(text)) {
    try {
      if (
        !(await host.deps.persistence.hasQuietHoursReminderTarget?.(
          actorUserId,
          recognition.target
        ))
      )
        recognition = undefined;
    } catch {
      recognition = undefined;
    }
  }
  if (recognition?.kind === "quiet_agreement" && opts?.attachments?.length) recognition = undefined;
  const agreement = typedDeletionAgreement(text);
  let threadState: Awaited<ReturnType<typeof selectTurnThread>>;
  let threadRead = args[7];
  if (recognition?.kind === "quiet_agreement") {
    try {
      threadRead ??= selectTurnThread(host, actorUserId, surface);
      threadState = await threadRead;
      if (
        !threadState?.id ||
        !(await host.deps.persistence.hasPendingQuietHoursProposal?.(actorUserId, threadState.id))
      )
        recognition = undefined;
    } catch {
      return {
        result: emitUnsaved(host, actorUserId, surface, text, REMINDER_AGREEMENT_FAILURE_MESSAGE),
        requestIncognito: threadState?.incognito ?? false,
        requestThreadId: threadState?.id ?? null
      };
    }
  }
  if (
    !recognition &&
    !opts?.moduleControl &&
    !opts?.attachments?.length &&
    (agreement !== undefined || isDeletionNearMiss(text)) &&
    host.deps.persistence.hasPendingReminderDeletion
  ) {
    try {
      threadRead ??= selectTurnThread(host, actorUserId, surface);
      threadState = await threadRead;
      if (
        threadState?.id &&
        !threadState.incognito &&
        (await host.deps.persistence.hasPendingReminderDeletion(actorUserId, threadState.id))
      )
        recognition = { kind: "confirm_delete", agree: agreement ?? false };
    } catch {
      return {
        result: emitUnsaved(host, actorUserId, surface, text, REMINDER_AGREEMENT_FAILURE_MESSAGE),
        requestIncognito: threadState?.incognito ?? false,
        requestThreadId: threadState?.id ?? null
      };
    }
  }
  if (
    !recognition &&
    !opts?.moduleControl &&
    !opts?.attachments?.length &&
    host.deps.persistence.prepareReminderEdit
  ) {
    try {
      threadRead ??= selectTurnThread(host, actorUserId, surface);
      threadState = await threadRead;
      if (threadState?.incognito && recognizeReminderEdit(text))
        recognition = { kind: "main_only", manage: true };
      if (threadState?.id && !threadState.incognito)
        recognition = await host.deps.persistence.prepareReminderEdit(
          actorUserId,
          text,
          threadState.id,
          controller.signal
        );
    } catch {
      if (recognizeReminderEdit(text))
        recognition = { kind: "edit_refused", reply: REMINDER_MANAGE_FAILURE_MESSAGE };
    }
  }
  if (!recognition)
    return tryGatedTurn(
      host,
      actorUserId,
      surface,
      text,
      opts,
      controller,
      flushActions,
      threadRead
    );
  const manage =
    recognition.kind !== "request" &&
    recognition.kind !== "clock_request" &&
    recognition.kind !== "scheduled_read" &&
    recognition.kind !== "unsupported";

  threadState = await (threadRead ?? selectTurnThread(host, actorUserId, surface));
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
    const reply = manage ? REMINDER_MANAGE_MAIN_ONLY_REPLY : REMINDER_MAIN_ONLY_REPLY;
    return done(emitUnsaved(host, actorUserId, surface, text, reply));
  }

  // A module-controlled turn speaks for a module, not for the user, so it never saves or cancels.
  const plan: ReminderTurnPlan = opts?.moduleControl
    ? { kind: "main_only", ...(manage ? { manage } : {}) }
    : recognition;
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
    const reply =
      recognition.kind === "confirm_delete"
        ? REMINDER_AGREEMENT_FAILURE_MESSAGE
        : manage
          ? REMINDER_MANAGE_FAILURE_MESSAGE
          : REMINDER_STORAGE_FAILURE_MESSAGE;
    return done(emitUnsaved(host, actorUserId, surface, text, reply));
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
