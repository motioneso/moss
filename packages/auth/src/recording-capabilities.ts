import type { AbortablePgPool } from "@moss/db";
import { RecordingCapabilityError } from "./recording-capability-error.js";
import {
  acquireCaptureBinding,
  probeCaptureBinding,
  type CaptureBindingInput,
  type CaptureBindingLease
} from "./capture-binding.js";
// Legacy mutation helpers remain for isolated compatibility fixtures; public attempt/decide
// routes are retired. New recording authority is issued only by initial companion pairing.
import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type pg from "pg";
import type {
  DecideRecordingCapabilityInput,
  DecideRecordingCapabilityResponse,
  RecordingCapabilitiesResponse,
  RecordingCapabilityAttempt,
  RecordingCapabilityAttemptInput
} from "@moss/shared";
import type { CompanionContext, CompanionDevicesService } from "./companion-devices.js";
import type { BrowserSessionBinding } from "./session-bindings.js";
import { digestsMatch } from "./companion-crypto.js";

export { RecordingCapabilityError } from "./recording-capability-error.js";

export interface RecordingCapabilityContext extends CompanionContext {
  readonly capabilityRevision: number;
  readonly expiresAt: Date;
}

export interface RecordingCapabilitiesService {
  acquireCaptureBinding(input: CaptureBindingInput): Promise<CaptureBindingLease>;
  probeCaptureBinding(input: CaptureBindingInput, signal: AbortSignal): Promise<void>;
  resolve(input: {
    headers: IncomingHttpHeaders;
    requestId: string;
  }): Promise<RecordingCapabilityContext>;
  assertLive(input: {
    actorUserId: string;
    deviceId: string;
    capabilityRevision: number;
  }): Promise<{ expiresAt: Date }>;
  createAttempt(
    actor: CompanionContext,
    input: RecordingCapabilityAttemptInput
  ): Promise<RecordingCapabilityAttempt>;
  attemptStatus(actor: CompanionContext, attemptId: string): Promise<RecordingCapabilityAttempt>;
  list(actorUserId: string): Promise<RecordingCapabilitiesResponse>;
  decide(
    actor: BrowserSessionBinding,
    input: DecideRecordingCapabilityInput
  ): Promise<DecideRecordingCapabilityResponse>;
  revoke(actor: BrowserSessionBinding, deviceId: string): Promise<void>;
}

interface CapabilityRow {
  proof_hash: string;
  revision: number;
  expires_at: Date;
}
interface AttemptRow {
  id: string;
  device_id: string;
  owner_user_id: string;
  proof_hash: string;
  policy_version: number;
  status: "pending" | "approved" | "denied";
  approved_revision: number | null;
  expires_at: Date;
}
const digest = (proof: string) => createHash("sha256").update(proof).digest("hex");
const validProofHash = (hash: string) => /^[a-f0-9]{64}$/.test(hash);

export function createRecordingCapabilitiesService(deps: {
  readonly pool: pg.Pool;
  readonly maintenancePool: AbortablePgPool;
  readonly companionDevices: CompanionDevicesService;
  readonly now?: () => Date;
}): RecordingCapabilitiesService {
  const { pool } = deps;
  const now = deps.now ?? (() => new Date());
  async function transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async function deviceLock(client: pg.PoolClient, deviceId: string) {
    // Never hold an auth-pool connection while waiting behind capture, which needs
    // this same pool for its final verification. A busy mutation retries after release.
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtextextended('meeting-device:' || $1::uuid::text,0)) AS locked",
      [deviceId]
    );
    if (!result.rows[0]?.locked) throw new RecordingCapabilityError(429, 1);
  }
  async function liveDevice(
    client: Pick<pg.PoolClient, "query">,
    actor: { actorUserId: string; deviceId: string }
  ) {
    const result = await client.query<{ expires_at: Date }>(
      `SELECT LEAST(d.expires_at,d.absolute_expires_at) AS expires_at
       FROM app.companion_devices d JOIN app.users u ON u.id=d.user_id
       WHERE d.id=$1 AND d.user_id=$2 AND u.status='active' AND d.expires_at>$3 AND d.absolute_expires_at>$3`,
      [actor.deviceId, actor.actorUserId, now()]
    );
    if (!result.rows[0]) throw new RecordingCapabilityError();
    return result.rows[0];
  }
  async function liveBrowser(client: pg.PoolClient, actor: BrowserSessionBinding) {
    const result = await client.query(
      `SELECT s.id FROM app.better_auth_sessions s JOIN app.users u ON u.id=s.user_id
       WHERE s.id=$1 AND s.user_id=$2 AND s.expires_at>$3 AND u.status='active'`,
      [actor.sessionId, actor.actorUserId, now()]
    );
    if (!result.rows[0]) throw new RecordingCapabilityError();
  }
  async function capability(
    input: {
      actorUserId: string;
      deviceId: string;
    },
    client: Pick<pg.PoolClient, "query"> = pool
  ): Promise<CapabilityRow> {
    const result = await client.query<CapabilityRow>(
      `SELECT c.proof_hash,c.revision,LEAST(d.expires_at,d.absolute_expires_at) AS expires_at
       FROM app.companion_recording_capabilities c
       JOIN app.companion_devices d ON d.id=c.device_id AND d.user_id=c.owner_user_id
       JOIN app.users u ON u.id=c.owner_user_id
       WHERE c.device_id=$1 AND c.owner_user_id=$2 AND c.revoked_at IS NULL AND c.policy_version=1
       AND d.expires_at>$3 AND d.absolute_expires_at>$3 AND u.status='active'`,
      [input.deviceId, input.actorUserId, now()]
    );
    if (!result.rows[0]) throw new RecordingCapabilityError();
    return result.rows[0];
  }
  function view(row: AttemptRow, expired = row.expires_at <= now()): RecordingCapabilityAttempt {
    return {
      attemptId: row.id,
      expiresAt: row.expires_at.toISOString(),
      policyVersion: 1,
      status: expired ? "expired" : row.status,
      ...(!expired && row.status === "approved" && row.approved_revision
        ? { revision: row.approved_revision }
        : {})
    };
  }
  return {
    acquireCaptureBinding: (input) => acquireCaptureBinding(pool, input),
    probeCaptureBinding: (input, signal) =>
      probeCaptureBinding(deps.maintenancePool, input, signal),
    async resolve({ headers, requestId }) {
      const proof = headers["x-moss-recording-proof"];
      if (headers.cookie || typeof proof !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(proof))
        throw new RecordingCapabilityError();
      const actor = await deps.companionDevices.resolve({ headers, requestId });
      const row = await capability(actor);
      if (!digestsMatch(digest(proof), row.proof_hash)) throw new RecordingCapabilityError();
      return { ...actor, capabilityRevision: row.revision, expiresAt: row.expires_at };
    },
    async assertLive(input) {
      const row = await capability(input);
      if (row.revision !== input.capabilityRevision) throw new RecordingCapabilityError();
      return { expiresAt: row.expires_at };
    },
    async createAttempt(actor, input) {
      if (input.policyVersion !== 1 || !validProofHash(input.proofHash))
        throw new RecordingCapabilityError(400);
      return transaction(async (client) => {
        await deviceLock(client, actor.deviceId);
        const device = await liveDevice(client, actor);
        const previous = await client.query<AttemptRow>(
          "SELECT * FROM app.companion_recording_attempts WHERE device_id=$1 AND owner_user_id=$2 AND request_key=$3",
          [actor.deviceId, actor.actorUserId, input.requestKey]
        );
        if (previous.rows[0]) {
          if (
            !digestsMatch(previous.rows[0].proof_hash, input.proofHash) ||
            previous.rows[0].policy_version !== input.policyVersion
          )
            throw new RecordingCapabilityError(409);
          const old = previous.rows[0];
          if (old.status === "approved") {
            const active = await capability(actor, client).catch((error: unknown) => {
              if (error instanceof RecordingCapabilityError) return null;
              throw error;
            });
            return view(
              old,
              !active ||
                active.revision !== old.approved_revision ||
                !digestsMatch(active.proof_hash, old.proof_hash)
            );
          }
          return view(old);
        }
        await client.query(
          "DELETE FROM app.companion_recording_attempts WHERE device_id=$1 AND expires_at<$2",
          [actor.deviceId, now()]
        );
        const count = await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM app.companion_recording_attempts WHERE device_id=$1",
          [actor.deviceId]
        );
        if (Number(count.rows[0]?.count ?? 0) >= 5) throw new RecordingCapabilityError(429);
        const expiresAt = new Date(Math.min(now().getTime() + 600000, device.expires_at.getTime()));
        const result = await client.query<AttemptRow>(
          `INSERT INTO app.companion_recording_attempts(owner_user_id,device_id,request_key,proof_hash,policy_version,created_at,expires_at)
           VALUES($1,$2,$3,$4,1,$5,$6) RETURNING *`,
          [actor.actorUserId, actor.deviceId, input.requestKey, input.proofHash, now(), expiresAt]
        );
        if (!result.rows[0]) throw new RecordingCapabilityError();
        return view(result.rows[0]);
      });
    },
    async attemptStatus(actor, attemptId) {
      await liveDevice(pool, actor);
      const result = await pool.query<AttemptRow>(
        "SELECT * FROM app.companion_recording_attempts WHERE id=$1 AND owner_user_id=$2 AND device_id=$3",
        [attemptId, actor.actorUserId, actor.deviceId]
      );
      const row = result.rows[0];
      if (!row) throw new RecordingCapabilityError();
      if (row.status === "approved") {
        const active = await capability(actor).catch((error: unknown) => {
          if (error instanceof RecordingCapabilityError) return null;
          throw error;
        });
        if (
          !active ||
          active.revision !== row.approved_revision ||
          !digestsMatch(active.proof_hash, row.proof_hash)
        )
          return view(row, true);
        // Attempt expiry bounds approval, not the lifetime of an already approved proof.
        return view(row, false);
      }
      return view(row);
    },
    async list(actorUserId) {
      const result = await pool.query<{
        device_id: string;
        display_name: string;
        revision: number | null;
        revoked_at: Date | null;
        attempt_id: string | null;
        attempt_expires_at: Date | null;
      }>(
        `SELECT d.id AS device_id,d.display_name,c.revision,c.revoked_at,a.id AS attempt_id,a.expires_at AS attempt_expires_at
         FROM app.companion_devices d JOIN app.users u ON u.id=d.user_id
         LEFT JOIN app.companion_recording_capabilities c ON c.device_id=d.id AND c.owner_user_id=d.user_id
         LEFT JOIN LATERAL (SELECT id,expires_at FROM app.companion_recording_attempts
           WHERE device_id=d.id AND owner_user_id=d.user_id AND status='pending' AND expires_at>$2
           ORDER BY created_at DESC LIMIT 1) a ON true
         WHERE d.user_id=$1 AND u.status='active' AND d.expires_at>$2 AND d.absolute_expires_at>$2
         ORDER BY d.created_at DESC LIMIT 100`,
        [actorUserId, now()]
      );
      return {
        devices: result.rows.map((row) => ({
          deviceId: row.device_id,
          deviceName: row.display_name,
          state:
            row.revision === null
              ? ("unapproved" as const)
              : row.revoked_at
                ? ("revoked" as const)
                : ("approved" as const),
          revision: row.revision ?? 0,
          policyVersion: 1 as const,
          ...(row.attempt_id && row.attempt_expires_at
            ? {
                pending: {
                  attemptId: row.attempt_id,
                  expiresAt: row.attempt_expires_at.toISOString(),
                  policyVersion: 1 as const
                }
              }
            : {})
        }))
      };
    },
    async decide(actor, input) {
      if (input.policyVersion !== 1) throw new RecordingCapabilityError(400);
      return transaction(async (client) => {
        const initial = await client.query<AttemptRow>(
          "SELECT * FROM app.companion_recording_attempts WHERE id=$1 AND owner_user_id=$2",
          [input.attemptId, actor.actorUserId]
        );
        if (!initial.rows[0]) throw new RecordingCapabilityError();
        const deviceId = initial.rows[0].device_id;
        await deviceLock(client, deviceId);
        await liveBrowser(client, actor);
        await liveDevice(client, { actorUserId: actor.actorUserId, deviceId });
        const selected = await client.query<AttemptRow>(
          "SELECT * FROM app.companion_recording_attempts WHERE id=$1 AND owner_user_id=$2 FOR UPDATE",
          [input.attemptId, actor.actorUserId]
        );
        const attempt = selected.rows[0];
        if (
          !attempt ||
          attempt.expires_at <= now() ||
          attempt.policy_version !== input.policyVersion
        )
          throw new RecordingCapabilityError();
        if (attempt.status !== "pending") {
          if (attempt.status === "denied" && input.decision === "deny") return { status: "denied" };
          const current = await client.query<{
            revision: number;
            proof_hash: string;
            revoked_at: Date | null;
          }>(
            "SELECT revision,proof_hash,revoked_at FROM app.companion_recording_capabilities WHERE device_id=$1 AND owner_user_id=$2",
            [deviceId, actor.actorUserId]
          );
          const row = current.rows[0];
          if (
            input.decision === "approve" &&
            attempt.status === "approved" &&
            row &&
            !row.revoked_at &&
            row.revision === attempt.approved_revision &&
            digestsMatch(row.proof_hash, attempt.proof_hash)
          )
            return { status: "approved", revision: row.revision };
          throw new RecordingCapabilityError(409);
        }
        if (input.decision === "deny") {
          await client.query(
            "UPDATE app.companion_recording_attempts SET status='denied' WHERE id=$1",
            [attempt.id]
          );
          return { status: "denied" };
        }
        const approved = await client.query<{ revision: number }>(
          `INSERT INTO app.companion_recording_capabilities(device_id,owner_user_id,proof_hash,policy_version,revision,approved_at)
           VALUES($1,$2,$3,1,1,$4) ON CONFLICT(device_id) DO UPDATE SET proof_hash=EXCLUDED.proof_hash,
           policy_version=1,revision=companion_recording_capabilities.revision+1,approved_at=EXCLUDED.approved_at,revoked_at=NULL
           WHERE companion_recording_capabilities.owner_user_id=EXCLUDED.owner_user_id RETURNING revision`,
          [deviceId, actor.actorUserId, attempt.proof_hash, now()]
        );
        const revision = approved.rows[0]?.revision;
        if (!revision) throw new RecordingCapabilityError();
        await client.query(
          "UPDATE app.companion_recording_attempts SET status='approved',approved_revision=$2 WHERE id=$1",
          [attempt.id, revision]
        );
        return { status: "approved", revision };
      });
    },
    async revoke(actor, deviceId) {
      await transaction(async (client) => {
        await deviceLock(client, deviceId);
        await liveBrowser(client, actor);
        await liveDevice(client, { actorUserId: actor.actorUserId, deviceId });
        await client.query(
          "UPDATE app.companion_recording_capabilities SET revoked_at=$3,revision=revision+1 WHERE device_id=$1 AND owner_user_id=$2 AND revoked_at IS NULL",
          [deviceId, actor.actorUserId, now()]
        );
        await client.query(
          "UPDATE app.companion_recording_attempts SET status='denied' WHERE device_id=$1 AND owner_user_id=$2 AND status='pending'",
          [deviceId, actor.actorUserId]
        );
      });
    }
  };
}
