import { randomUUID } from "node:crypto";
import { authorizeTaskBackgroundRead } from "@moss/tasks";
import type { ReminderCommandHandler, ReminderTurnDecision } from "../reminders/commands/types.js";
import { boundedActionScope, typedResponsibilityAgreement, termsFingerprint } from "./terms.js";
import {
  agreementNow,
  clearResponsibilityProposals,
  consumeResponsibilityProposal,
  pendingResponsibilityProposal,
  saveResponsibilityProposal
} from "./repository.js";
import {
  BOUNDED_ACTION_PROPOSAL_KIND,
  INACTIVE_AGREEMENT_MESSAGE,
  SCOPE_REFUSED_MESSAGE
} from "./prepare.js";

function reply(
  text: string,
  event: "scope_proposed" | "scope_saved" | "scope_refused",
  id: string | null = null
): ReminderTurnDecision {
  return {
    reply: text,
    origin: { version: 1, kind: "reminder", event, reminderId: null, proposalId: id }
  };
}

export const responsibilityAgreement: ReminderCommandHandler = async (context, plan) => {
  const { scopedDb, actorUserId, thread, deps } = context;
  const closeProposal = async (text: string, expectedId?: string) => {
    const pending = await scopedDb.db
      .selectFrom("app.chat_responsibility_proposals")
      .select("id")
      .where("thread_id", "=", thread.id)
      .where("state", "=", "pending")
      .limit(1)
      .executeTakeFirst();
    await clearResponsibilityProposals(scopedDb, thread.id);
    return reply(text, "scope_refused", pending?.id ?? expectedId ?? null);
  };
  if (plan.kind === "scope_refused") return closeProposal(plan.reply, plan.proposalId);
  if (plan.kind === "scope_proposal") {
    const scope = boundedActionScope(plan.scope);
    if (
      (await deps.scopeAvailable?.()) !== true ||
      !scope ||
      scope.destinationThreadId !== thread.id ||
      new Date(scope.dueAt) <= (await agreementNow(scopedDb)) ||
      !(await authorizeTaskBackgroundRead(scopedDb, { taskId: scope.taskId }, { actorUserId }))
    )
      return closeProposal(SCOPE_REFUSED_MESSAGE);
    const id = randomUUID();
    const locale = await deps.locale();
    const time = new Intl.DateTimeFormat("en", {
      timeZone: locale.timeZone,
      dateStyle: "medium",
      timeStyle: "medium"
    }).format(new Date(scope.dueAt));
    const terms = { ...scope, timeZone: locale.timeZone };
    const decision = reply(
      `Save your agreement to mark task "${scope.taskTitle}" (${scope.taskId}) done once on ${time} (${locale.timeZone})? Scheduled changes aren't available yet, so this will stay not active and no change will run. Reply yes or no.`,
      "scope_proposed",
      id
    );
    return {
      ...decision,
      origin: {
        ...decision.origin,
        responsibilityProposal: {
          id,
          kind: BOUNDED_ACTION_PROPOSAL_KIND,
          version: 1,
          fingerprint: termsFingerprint(terms)
        }
      },
      save: (sourceMessageId) =>
        saveResponsibilityProposal(scopedDb, {
          id,
          threadId: thread.id,
          sourceMessageId,
          kind: BOUNDED_ACTION_PROPOSAL_KIND,
          terms,
          validUntil: new Date(scope.dueAt)
        })
    };
  }
  if (plan.kind !== "scope_agreement") throw new Error("invalid responsibility agreement plan");
  const current = await pendingResponsibilityProposal(
    scopedDb,
    thread.id,
    BOUNDED_ACTION_PROPOSAL_KIND,
    boundedActionScope
  );
  if (
    (await deps.scopeAvailable?.()) !== true ||
    !current ||
    typedResponsibilityAgreement(context.userText ?? "") !== plan.agree ||
    plan.agree !== true ||
    current.id !== plan.proposal.id ||
    current.version !== plan.proposal.version ||
    current.fingerprint !== plan.proposal.fingerprint ||
    current.terms.destinationThreadId !== thread.id ||
    new Date(current.terms.dueAt) <= (await agreementNow(scopedDb)) ||
    !(await authorizeTaskBackgroundRead(
      scopedDb,
      { taskId: current.terms.taskId },
      { actorUserId }
    ))
  ) {
    await clearResponsibilityProposals(scopedDb, thread.id);
    return reply(
      plan.agree === false
        ? "Nothing is saved or changed."
        : "Those terms weren't approved. Nothing is saved or changed. Ask again with the scope you want.",
      "scope_refused",
      current?.id ?? plan.proposal.id
    );
  }
  return {
    ...reply(INACTIVE_AGREEMENT_MESSAGE, "scope_saved", current.id),
    save: async (sourceMessageId) => {
      if (
        !(await consumeResponsibilityProposal(
          scopedDb,
          thread.id,
          current,
          boundedActionScope,
          sourceMessageId
        ))
      )
        throw new Error("responsibility agreement changed");
    }
  };
};
