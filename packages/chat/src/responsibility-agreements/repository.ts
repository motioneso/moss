import { sql } from "kysely";
import { assertDataContextDb, type DataContextDb } from "@moss/db";
import { termsFingerprint, typedResponsibilityAgreement } from "./terms.js";

/** Storage owns binding and consume-once; callers own the semantics of their typed terms. */
export interface ResponsibilityProposal<T> {
  readonly id: string;
  readonly version: number;
  readonly kind: string;
  readonly fingerprint: string;
  readonly terms: T;
}

export async function clearResponsibilityProposals(
  db: DataContextDb,
  threadId: string
): Promise<void> {
  assertDataContextDb(db);
  await db.db
    .updateTable("app.chat_responsibility_proposals")
    .set({ state: "cancelled" })
    .where("thread_id", "=", threadId)
    .where("state", "=", "pending")
    .execute();
}

export async function saveResponsibilityProposal(
  db: DataContextDb,
  input: {
    readonly id: string;
    readonly threadId: string;
    readonly sourceMessageId: string;
    readonly kind: string;
    readonly terms: Record<string, unknown>;
    readonly validUntil?: Date;
  }
): Promise<void> {
  assertDataContextDb(db);
  const source = await db.db
    .selectFrom("app.chat_messages")
    .select(["tool_metadata", "created_at"])
    .where("id", "=", input.sourceMessageId)
    .where("thread_id", "=", input.threadId)
    .where("role", "=", "user")
    .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
    .executeTakeFirstOrThrow();
  const question = await db.db
    .selectFrom("app.chat_messages")
    .select(["id", "model_metadata"])
    .where("thread_id", "=", input.threadId)
    .where("role", "=", "assistant")
    .where("status", "=", "stored")
    .where("created_at", "=", source.created_at)
    .where(sql<boolean>`tool_metadata->>'turnId' = ${source.tool_metadata.turnId}`)
    .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
    .executeTakeFirstOrThrow();
  const id = input.id;
  const fingerprint = termsFingerprint(input.terms);
  if (
    !proposalBindingMatches(question.model_metadata, {
      id,
      kind: input.kind,
      version: 1,
      fingerprint
    })
  )
    throw new Error("proposal question does not match its exact terms");
  await clearResponsibilityProposals(db, input.threadId);
  await db.db
    .insertInto("app.chat_responsibility_proposals")
    .values({
      id,
      owner_user_id: sql<string>`app.current_actor_user_id()`,
      thread_id: input.threadId,
      proposal_kind: input.kind,
      proposal_version: 1,
      terms_json: input.terms,
      valid_until: input.validUntil ?? null,
      terms_fingerprint: fingerprint,
      question_user_message_id: input.sourceMessageId,
      question_assistant_message_id: question.id,
      state: "pending"
    })
    .executeTakeFirstOrThrow();
}

export async function pendingResponsibilityProposal<T>(
  db: DataContextDb,
  threadId: string,
  kind: string,
  validate: (value: unknown) => T | undefined
): Promise<ResponsibilityProposal<T> | undefined> {
  assertDataContextDb(db);
  const proposal = await db.db
    .selectFrom("app.chat_responsibility_proposals")
    .selectAll()
    .where("thread_id", "=", threadId)
    .where("proposal_kind", "=", kind)
    .where("state", "=", "pending")
    .where(sql<boolean>`valid_until IS NULL OR valid_until > clock_timestamp()`)
    .forUpdate()
    .executeTakeFirst();
  if (!proposal) return undefined;
  const latest = await db.db
    .selectFrom("app.chat_messages")
    .select(["id", "model_metadata"])
    .where("thread_id", "=", threadId)
    .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
    .where("status", "=", "stored")
    .where(sql<boolean>`coalesce(model_metadata->'origin'->>'event', '') <> 'delivered'`)
    .where(sql<boolean>`coalesce(tool_metadata->>'actionOutcomeOnly', 'false') <> 'true'`)
    .orderBy("created_at", "desc")
    .orderBy(sql<number>`case when role = 'assistant' then 0 else 1 end`)
    .orderBy("id", "desc")
    .limit(1)
    .executeTakeFirst();
  const terms = validate(proposal.terms_json);
  if (
    latest?.id !== proposal.question_assistant_message_id ||
    !proposalBindingMatches(latest.model_metadata, {
      id: proposal.id,
      kind: proposal.proposal_kind,
      version: proposal.proposal_version,
      fingerprint: proposal.terms_fingerprint
    }) ||
    !terms ||
    proposal.terms_fingerprint !== termsFingerprint(proposal.terms_json)
  )
    return undefined;
  return {
    id: proposal.id,
    version: proposal.proposal_version,
    kind: proposal.proposal_kind,
    fingerprint: proposal.terms_fingerprint,
    terms
  };
}

export async function consumeResponsibilityProposal<T>(
  db: DataContextDb,
  threadId: string,
  expected: ResponsibilityProposal<T>,
  validate: (value: unknown) => T | undefined,
  acceptanceMessageId: string
): Promise<boolean> {
  assertDataContextDb(db);
  const current = await db.db
    .selectFrom("app.chat_responsibility_proposals")
    .selectAll()
    .where("id", "=", expected.id)
    .where("thread_id", "=", threadId)
    .where("state", "=", "pending")
    .where(sql<boolean>`valid_until IS NULL OR valid_until > clock_timestamp()`)
    .forUpdate()
    .executeTakeFirst();
  if (
    !current ||
    current.proposal_kind !== expected.kind ||
    current.proposal_version !== expected.version ||
    current.terms_fingerprint !== expected.fingerprint ||
    !validate(current.terms_json) ||
    termsFingerprint(current.terms_json) !== expected.fingerprint
  )
    return false;
  const acceptance = await db.db
    .selectFrom("app.chat_messages")
    .select(["tool_metadata", "created_at", "body"])
    .where("id", "=", acceptanceMessageId)
    .where("thread_id", "=", threadId)
    .where("role", "=", "user")
    .where("status", "=", "stored")
    .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
    .executeTakeFirst();
  if (
    !acceptance ||
    typedResponsibilityAgreement(acceptance.body) !== true ||
    !acceptance.tool_metadata.turnId
  )
    return false;
  const previous = await db.db
    .selectFrom("app.chat_messages")
    .select("id")
    .where("thread_id", "=", threadId)
    .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
    .where("status", "=", "stored")
    .where(
      sql<boolean>`coalesce(tool_metadata->>'turnId', '') <> ${acceptance.tool_metadata.turnId}`
    )
    .where(sql<boolean>`coalesce(model_metadata->'origin'->>'event', '') <> 'delivered'`)
    .where(sql<boolean>`coalesce(tool_metadata->>'actionOutcomeOnly', 'false') <> 'true'`)
    .orderBy("created_at", "desc")
    .orderBy(sql<number>`case when role = 'assistant' then 0 else 1 end`)
    .orderBy("id", "desc")
    .limit(1)
    .executeTakeFirst();
  const question = await db.db
    .selectFrom("app.chat_messages")
    .select(["created_at", "tool_metadata", "model_metadata"])
    .where("id", "=", current.question_assistant_message_id)
    .executeTakeFirst();
  if (
    previous?.id !== current.question_assistant_message_id ||
    !question ||
    !proposalBindingMatches(question.model_metadata, expected) ||
    acceptance.created_at < question.created_at ||
    acceptance.tool_metadata.turnId === question.tool_metadata.turnId
  )
    return false;
  const accepted = await db.db
    .updateTable("app.chat_responsibility_proposals")
    .set({
      state: "accepted",
      acceptance_message_id: acceptanceMessageId,
      accepted_at: sql<Date>`clock_timestamp()`
    })
    .where("id", "=", current.id)
    .where(sql<boolean>`valid_until IS NULL OR valid_until > clock_timestamp()`)
    .returning("id")
    .executeTakeFirst();
  return accepted !== undefined;
}

export function proposalBindingMatches(
  metadata: Record<string, unknown>,
  expected: {
    readonly id: string;
    readonly kind: string;
    readonly version: number;
    readonly fingerprint: string;
  }
): boolean {
  const origin = metadata.origin;
  if (!origin || typeof origin !== "object" || Array.isArray(origin)) return false;
  const binding = (origin as Record<string, unknown>).responsibilityProposal;
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) return false;
  const row = binding as Record<string, unknown>;
  return (
    Object.keys(row).length === 4 &&
    row.id === expected.id &&
    row.kind === expected.kind &&
    row.version === expected.version &&
    row.fingerprint === expected.fingerprint
  );
}

export async function agreementNow(db: DataContextDb): Promise<Date> {
  assertDataContextDb(db);
  const result = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(db.db);
  return result.rows[0]!.now;
}
