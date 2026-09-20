import type pg from "pg";

import {
  COMPANION_APPROVAL_PATH,
  COMPANION_PAIR_ATTEMPT_TTL_SECONDS,
  type CreatePairAttemptRequest,
  type PairAttemptSummaryResponse,
  type RedeemPairAttemptPending,
  type RedeemPairAttemptRequest,
  type RedeemPairAttemptResponse
} from "@moss/shared";

import {
  digestsMatch,
  mintCompanionCredential,
  randomBase64url,
  sha256Base64url
} from "./companion-crypto.js";

/**
 * Browser-approved device pairing for the Trail Marker Mac companion (#2560).
 *
 * Three secrets, three holders. The app keeps a verifier and proves possession of it
 * at redeem. The browser carries an approval code that can decide an attempt but can
 * never redeem one. The credential is minted once, at redeem, and only for the app
 * that started the attempt. Cancelling, denying or letting an attempt expire can
 * therefore never leave a usable credential behind.
 */

/** Sliding inactivity window for a companion credential. */
const CREDENTIAL_INACTIVITY_DAYS = 90;

/** Hard ceiling from the moment of issue; relinking is the only way past it. */
const CREDENTIAL_ABSOLUTE_DAYS = 365;

export interface CreatedPairAttempt {
  readonly attemptId: string;
  /** Raw code, handed to the browser in the approval URL. Only its digest is stored. */
  readonly approvalCode: string;
  readonly approvalPath: string;
  readonly expiresAt: Date;
}

export type DecidePairAttemptResult =
  | { readonly ok: true; readonly decision: "approve" | "deny" }
  | { readonly ok: false; readonly reason: "unknown" | "not_pending" };

export type RedeemResult =
  | { readonly status: "issued"; readonly response: RedeemPairAttemptResponse }
  | RedeemPairAttemptPending;

export interface CompanionPairingService {
  create(input: CreatePairAttemptRequest): Promise<CreatedPairAttempt>;
  summarize(input: { approvalCode: string }): Promise<PairAttemptSummaryResponse | null>;
  decide(input: {
    approvalCode: string;
    decision: "approve" | "deny";
    actorUserId: string;
  }): Promise<DecidePairAttemptResult>;
  redeem(input: RedeemPairAttemptRequest): Promise<RedeemResult>;
  cancel(input: RedeemPairAttemptRequest): Promise<void>;
}

interface PairingDeps {
  readonly pool: pg.Pool;
  /** Injectable clock so expiry is testable without waiting ten minutes. */
  readonly now?: () => Date;
}

interface AttemptRow {
  readonly id: string;
  readonly device_name: string;
  readonly status: "pending" | "approved" | "denied" | "redeemed";
  readonly user_id: string | null;
  readonly expires_at: Date;
}

export function createCompanionPairingService(deps: PairingDeps): CompanionPairingService {
  const { pool } = deps;
  const now = deps.now ?? (() => new Date());

  async function purgeExpired(): Promise<void> {
    await pool.query("DELETE FROM app.companion_pair_attempts WHERE expires_at < $1", [now()]);
  }

  return {
    async create(input) {
      // Lazy cleanup on the one endpoint an attacker cannot call for free: no scheduler,
      // and an abandoned attempt never outlives its window.
      await purgeExpired();

      const approvalCode = randomBase64url(24);
      const expiresAt = new Date(now().getTime() + COMPANION_PAIR_ATTEMPT_TTL_SECONDS * 1000);

      const result = await pool.query<{ id: string }>(
        `INSERT INTO app.companion_pair_attempts
           (approval_code_hash, verifier_hash, device_name, platform, app_version, os_version,
            status, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)
         RETURNING id`,
        [
          sha256Base64url(approvalCode),
          input.verifierHash,
          input.deviceName,
          input.platform,
          input.appVersion,
          input.osVersion,
          now(),
          expiresAt
        ]
      );

      const attemptId = result.rows[0]?.id;
      if (!attemptId) throw new Error("companion pairing: attempt insert returned no row");

      return {
        attemptId,
        approvalCode,
        // The code sits in the fragment, which a browser never puts in a request and never
        // sends in a Referer header. The same server serves this page and logs every URL
        // it is asked for, so a query parameter would log a live approval secret.
        approvalPath: `${COMPANION_APPROVAL_PATH}#code=${encodeURIComponent(approvalCode)}`,
        expiresAt
      };
    },

    async summarize({ approvalCode }) {
      const result = await pool.query<AttemptRow>(
        `SELECT id, device_name, status, user_id, expires_at
           FROM app.companion_pair_attempts
          WHERE approval_code_hash = $1 AND expires_at > $2`,
        [sha256Base64url(approvalCode), now()]
      );
      const row = result.rows[0];
      if (!row) return null;

      // A redeemed attempt is finished; the browser has nothing left to decide, and
      // saying so would only confirm that a code once existed.
      if (row.status === "redeemed") return null;

      return { deviceName: row.device_name, status: row.status };
    },

    async decide({ approvalCode, decision, actorUserId }) {
      // Binds the approving account here, from the cookie session, never from the body.
      // The status guard makes a second decision on the same attempt impossible.
      const result = await pool.query<{ id: string }>(
        `UPDATE app.companion_pair_attempts
            SET status = $1, user_id = $2
          WHERE approval_code_hash = $3
            AND status = 'pending'
            AND expires_at > $4
          RETURNING id`,
        [
          decision === "approve" ? "approved" : "denied",
          actorUserId,
          sha256Base64url(approvalCode),
          now()
        ]
      );

      if (result.rows[0]) return { ok: true, decision };

      // Distinguish "no such code" from "already decided" for the browser's message,
      // which is safe: reaching this point already required a valid signed-in session
      // holding the code.
      const existing = await pool.query<{ status: string }>(
        `SELECT status FROM app.companion_pair_attempts
          WHERE approval_code_hash = $1 AND expires_at > $2`,
        [sha256Base64url(approvalCode), now()]
      );
      if (existing.rows[0]) return { ok: false, reason: "not_pending" };
      return { ok: false, reason: "unknown" };
    },

    async redeem({ attemptId, verifier }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // One statement decides the race. Two concurrent redeems both match
        // status='approved', but only one UPDATE returns a row, so only one mints.
        const claimed = await client.query<{ user_id: string; device_name: string }>(
          `UPDATE app.companion_pair_attempts
              SET status = 'redeemed'
            WHERE id = $1
              AND status = 'approved'
              AND verifier_hash = $2
              AND expires_at > $3
            RETURNING user_id, device_name`,
          [attemptId, sha256Base64url(verifier), now()]
        );

        const claim = claimed.rows[0];
        if (!claim) {
          await client.query("ROLLBACK");
          return { status: await explainFailedRedeem(pool, attemptId, verifier, now()) };
        }

        const { credential, hash } = mintCompanionCredential();
        const issuedAt = now();
        const expiresAt = addDays(issuedAt, CREDENTIAL_INACTIVITY_DAYS);
        const absoluteExpiresAt = addDays(issuedAt, CREDENTIAL_ABSOLUTE_DAYS);

        const device = await client.query<{ id: string; display_name: string }>(
          `INSERT INTO app.companion_devices
             (user_id, credential_hash, display_name, platform, app_version, os_version,
              created_at, expires_at, absolute_expires_at, pair_attempt_id)
           SELECT $1, $2, $3, a.platform, a.app_version, a.os_version, $4, $5, $6, a.id
             FROM app.companion_pair_attempts a
            WHERE a.id = $7
           RETURNING id, display_name`,
          [
            claim.user_id,
            hash,
            claim.device_name,
            issuedAt,
            expiresAt,
            absoluteExpiresAt,
            attemptId
          ]
        );

        const deviceRow = device.rows[0];
        if (!deviceRow) {
          await client.query("ROLLBACK");
          throw new Error("companion pairing: device insert returned no row");
        }

        const account = await client.query<{ name: string | null; email: string }>(
          "SELECT name, email FROM app.users WHERE id = $1",
          [claim.user_id]
        );
        const accountRow = account.rows[0];
        if (!accountRow) {
          await client.query("ROLLBACK");
          return { status: "unknown" };
        }

        await client.query("COMMIT");

        return {
          status: "issued",
          response: {
            credential,
            device: { id: deviceRow.id, displayName: deviceRow.display_name },
            account: { name: accountRow.name ?? accountRow.email, email: accountRow.email },
            expiresAt: expiresAt.toISOString()
          }
        };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async cancel({ attemptId, verifier }) {
      // Possession of the verifier is the whole authorization. A cancel wins against a
      // late browser approval because the row is gone before the approval can land.
      //
      // Cancelling also undoes a link that already happened. A redeem can land in the
      // moment between the person deciding to cancel and the request arriving, and a
      // cancel that left that credential alive would leave a working Mac nobody meant to
      // connect. Both deletes are one transaction, so neither can survive the other.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // The device goes first. Deleting the attempt clears the link column, so the
        // other order would leave the credential with nothing pointing at it.
        await client.query(
          `DELETE FROM app.companion_devices
            WHERE pair_attempt_id IN (
              SELECT id FROM app.companion_pair_attempts
               WHERE id = $1 AND verifier_hash = $2
            )`,
          [attemptId, sha256Base64url(verifier)]
        );
        await client.query(
          "DELETE FROM app.companion_pair_attempts WHERE id = $1 AND verifier_hash = $2",
          [attemptId, sha256Base64url(verifier)]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }
  };
}

/**
 * Why a redeem did not mint. A wrong verifier is reported as `unknown`, exactly like a
 * nonexistent attempt, so holding the public attempt id reveals nothing about whether
 * it exists or has been approved.
 */
async function explainFailedRedeem(
  pool: pg.Pool,
  attemptId: string,
  verifier: string,
  at: Date
): Promise<Exclude<RedeemPairAttemptPending["status"], never>> {
  const result = await pool.query<AttemptRow & { verifier_hash: string }>(
    `SELECT id, device_name, status, user_id, expires_at, verifier_hash
       FROM app.companion_pair_attempts
      WHERE id = $1`,
    [attemptId]
  );
  const row = result.rows[0];
  if (!row) return "unknown";
  if (!digestsMatch(row.verifier_hash, sha256Base64url(verifier))) return "unknown";
  if (row.expires_at <= at) return "expired";
  if (row.status === "pending") return "pending";
  if (row.status === "denied") return "denied";
  if (row.status === "redeemed") return "redeemed";
  return "unknown";
}

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}
