import { createHash } from "node:crypto";

import { sql } from "kysely";

import { assertDataContextDb, type DataContextDb, type PushSubscription } from "@moss/db";

import { createPushSubscriptionCipher, type PushSubscriptionCipher } from "./push-crypto.js";

/**
 * A device row with its secret envelope stripped: what the settings page and the
 * registration route see. The endpoint and keys only leave the row through
 * {@link PushSubscriptionsRepository.listActiveForDelivery}.
 */
export type PushSubscriptionDevice = Omit<PushSubscription, "credentials_ciphertext">;

/** Decrypted delivery target for one device; lives only inside the delivery worker. */
export interface PushDeliveryTarget {
  readonly id: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  /**
   * Key of the last payload this device received (#743 finding 8). The worker compares it
   * with the payload it is about to send and skips the device on a retry that would repeat
   * an earlier success.
   */
  readonly lastDeliveredKey: string | null;
}

const MAX_SUBSCRIPTIONS_PER_USER = 10;

export class PushSubscriptionLimitError extends Error {
  constructor() {
    super(`A user may register at most ${MAX_SUBSCRIPTIONS_PER_USER} push devices`);
    this.name = "PushSubscriptionLimitError";
  }
}

const DEVICE_COLUMNS = [
  "id",
  "owner_user_id",
  "endpoint_hash",
  "user_agent_label",
  "created_at",
  "last_used_at",
  "failure_count",
  "disabled_at",
  "last_delivered_key"
] as const;

/**
 * Explicit owner predicate on every statement. RLS (migration 0223) already restricts the
 * table to the current actor, but security review 1 finding 3 asked for the scoping to be
 * visible in the query itself, so a future policy edit or a role with wider grants cannot
 * silently widen these methods.
 */
const ownerIsActor = sql<boolean>`owner_user_id = app.current_actor_user_id()`;

/** sha256 hex of the endpoint URL: the uniqueness key, never reversible to the URL. */
export function hashPushEndpoint(endpoint: string): string {
  return createHash("sha256").update(endpoint, "utf8").digest("hex");
}

/**
 * All tables here are RLS-scoped to `app.current_actor_user_id()` (migration 0223), so
 * every method here is implicitly owner-scoped: the settings page reads/writes its own
 * user's rows, and the delivery worker (running in the recipient's data context) reads
 * and cleans up that same recipient's rows. No method takes an explicit owner id.
 *
 * Secrets at rest (security review 1, finding 2): the endpoint URL and the browser's
 * `p256dh`/`auth` keys are stored only inside an AES-256-GCM envelope; the row carries a
 * sha256 of the endpoint for the uniqueness constraint. Only `listActiveForDelivery`
 * opens the envelope.
 */
export class PushSubscriptionsRepository {
  constructor(private readonly cipher: PushSubscriptionCipher = createPushSubscriptionCipher()) {}

  /** All of the current actor's registered devices, active and disabled alike. Secret-free. */
  async listForActor(scopedDb: DataContextDb): Promise<readonly PushSubscriptionDevice[]> {
    assertDataContextDb(scopedDb);
    return scopedDb.db
      .selectFrom("app.push_subscriptions")
      .select(DEVICE_COLUMNS)
      .where(ownerIsActor)
      .orderBy("created_at", "asc")
      .execute();
  }

  /**
   * Non-disabled devices only, decrypted, for delivery fan-out. The returned targets hold
   * the plaintext endpoint and keys: they must not be logged, serialized into a job
   * payload, or returned from a route.
   */
  async listActiveForDelivery(scopedDb: DataContextDb): Promise<readonly PushDeliveryTarget[]> {
    assertDataContextDb(scopedDb);
    const rows = await scopedDb.db
      .selectFrom("app.push_subscriptions")
      .select(["id", "credentials_ciphertext", "last_delivered_key"])
      .where(ownerIsActor)
      .where("disabled_at", "is", null)
      .orderBy("created_at", "asc")
      .execute();

    return rows.map((row) =>
      this.openCredentials(row.id, row.credentials_ciphertext, row.last_delivered_key)
    );
  }

  /**
   * Registers or re-registers a browser subscription for the current actor. Re-registering
   * an existing endpoint (the browser's `PushSubscription` never changes for the life of a
   * service worker registration, but this call is also the recovery path after a delivery
   * failure disabled the row) clears `disabled_at` and resets `failure_count`.
   */
  async upsert(
    scopedDb: DataContextDb,
    input: {
      readonly endpoint: string;
      readonly p256dh: string;
      readonly auth: string;
      readonly userAgentLabel: string | null;
    }
  ): Promise<PushSubscriptionDevice> {
    assertDataContextDb(scopedDb);

    const endpointHash = hashPushEndpoint(input.endpoint);

    // Security review 1, finding 6: two registrations racing at nine devices both counted
    // nine and both inserted. A transaction-scoped advisory lock keyed on the actor makes
    // the count-then-insert atomic per user; it releases when withDataContext commits.
    await sql`
      SELECT pg_advisory_xact_lock(
        hashtext('push_subscriptions'),
        hashtext(app.current_actor_user_id()::text)
      )
    `.execute(scopedDb.db);

    const existingCount = await scopedDb.db
      .selectFrom("app.push_subscriptions")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where(ownerIsActor)
      .where("endpoint_hash", "!=", endpointHash)
      .executeTakeFirst();

    if (existingCount && Number(existingCount.count) >= MAX_SUBSCRIPTIONS_PER_USER) {
      throw new PushSubscriptionLimitError();
    }

    const ciphertext = this.cipher.encryptJson({
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth
    });

    const rows = await sql<PushSubscriptionDevice>`
      INSERT INTO app.push_subscriptions (
        owner_user_id, endpoint_hash, credentials_ciphertext, user_agent_label
      )
      VALUES (
        app.current_actor_user_id(),
        ${endpointHash},
        ${JSON.stringify(ciphertext)}::jsonb,
        ${input.userAgentLabel}
      )
      ON CONFLICT (owner_user_id, endpoint_hash) DO UPDATE SET
        credentials_ciphertext = excluded.credentials_ciphertext,
        user_agent_label = excluded.user_agent_label,
        disabled_at = NULL,
        failure_count = 0
      RETURNING id, owner_user_id, endpoint_hash, user_agent_label, created_at, last_used_at,
        failure_count, disabled_at
    `.execute(scopedDb.db);

    const row = rows.rows[0];
    if (!row) throw new Error("push subscription upsert returned no row");
    return row;
  }

  /**
   * Owner-only delete; returns whether a row was removed. `false` for a missing id and for
   * another user's id alike, so the route's 404 cannot be used to probe for existence.
   */
  async delete(scopedDb: DataContextDb, id: string): Promise<boolean> {
    assertDataContextDb(scopedDb);
    const result = await scopedDb.db
      .deleteFrom("app.push_subscriptions")
      .where(ownerIsActor)
      .where("id", "=", id)
      .executeTakeFirst();
    return (result.numDeletedRows ?? 0n) > 0n;
  }

  /**
   * A success resets the failure count and records `deliveredKey`, the payload's id, so a
   * retry of the same job can tell this device already has it (#743 finding 8).
   */
  async recordDeliverySuccess(
    scopedDb: DataContextDb,
    id: string,
    deliveredKey: string
  ): Promise<void> {
    assertDataContextDb(scopedDb);
    await scopedDb.db
      .updateTable("app.push_subscriptions")
      .set({ failure_count: 0, last_used_at: new Date(), last_delivered_key: deliveredKey })
      .where(ownerIsActor)
      .where("id", "=", id)
      .execute();
  }

  /** Fifth consecutive failure disables the row rather than deleting it (spec 5.2/5.4). */
  async recordDeliveryFailure(scopedDb: DataContextDb, id: string): Promise<void> {
    assertDataContextDb(scopedDb);
    await sql`
      UPDATE app.push_subscriptions
      SET failure_count = failure_count + 1,
          disabled_at = CASE WHEN failure_count + 1 >= 5 THEN now() ELSE disabled_at END
      WHERE id = ${id}
        AND owner_user_id = app.current_actor_user_id()
    `.execute(scopedDb.db);
  }

  private openCredentials(
    id: string,
    envelope: unknown,
    lastDeliveredKey: string | null
  ): PushDeliveryTarget {
    const decrypted = this.cipher.decryptJson(this.cipher.parseEnvelope(envelope));
    const { endpoint, p256dh, auth } = decrypted;
    if (typeof endpoint !== "string" || typeof p256dh !== "string" || typeof auth !== "string") {
      throw new Error("push subscription envelope is missing its endpoint or keys");
    }
    return { id, endpoint, p256dh, auth, lastDeliveredKey };
  }
}
