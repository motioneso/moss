//! Device pairing for the Trail Marker and ring companions. Runs on the auth role, the only
//! role that can reach the pairing tables. No method here returns a credential hash, a
//! verifier or a proof hash. The raw credential and approval code leave only in the one
//! value that issues them.
use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use safety_core::db::Database;
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub const MAC_PREFIX: &str = "tm1_";
pub const RING_PREFIX: &str = "vr1_";
pub const APPROVAL_PATH: &str = "/link/trail-marker";
pub const ATTEMPT_TTL_SECONDS: i32 = 600;
pub const INACTIVITY_DAYS: i32 = 90;
pub const ABSOLUTE_DAYS: i32 = 365;

const ISO: &str = "to_char($COL AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')";

fn iso(column: &str) -> String {
    ISO.replace("$COL", column)
}

/// base64url sha256, 43 characters, the form every stored secret takes.
pub fn digest(input: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(input.as_bytes()))
}

fn random_b64(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

/// True when `value` is a credential of the given prefix: prefix plus 43 url-safe characters.
pub fn credential_shape(value: &str, prefix: &str) -> bool {
    value.strip_prefix(prefix).is_some_and(|rest| {
        rest.len() == 43 && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    })
}

#[derive(Clone)]
pub struct PairingStore {
    auth: Database,
}

pub struct NewAttempt {
    /// Already a digest. The app keeps the verifier itself.
    pub verifier_hash: String,
    pub device_name: String,
    pub platform: String,
    pub app_version: String,
    pub os_version: String,
    pub recording_proof_hash: Option<String>,
    pub recording_policy_version: Option<i32>,
}

pub struct CreatedAttempt {
    pub attempt_id: Uuid,
    /// Raw code for the browser. Only its digest is stored.
    pub approval_code: String,
    pub approval_path: String,
    pub expires_at: String,
}

pub struct AttemptSummary {
    pub device_name: String,
    pub status: String,
    pub platform: String,
    pub recording_policy_version: Option<i32>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    Done,
    NotPending,
    Unknown,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Pending {
    Pending,
    Denied,
    Expired,
    Redeemed,
    Unknown,
}

pub struct Issued {
    /// The one time the raw credential leaves the server.
    pub credential: String,
    pub device_id: Uuid,
    pub display_name: String,
    pub account_name: String,
    pub account_email: String,
    pub account_id: Option<Uuid>,
    pub expires_at: String,
    pub recording_revision: Option<i32>,
}

pub enum Redeemed {
    Issued(Box<Issued>),
    Not(Pending),
}

pub struct RingSession {
    pub owner: Uuid,
    pub device_id: Uuid,
}

impl PairingStore {
    pub fn new(auth: Database) -> Self {
        Self { auth }
    }

    async fn client(&self) -> Result<deadpool_postgres::Object> {
        self.auth.auth_client().await.map_err(|e| anyhow!("{e:?}"))
    }

    pub async fn create(&self, a: NewAttempt) -> Result<CreatedAttempt> {
        let mut c = self.client().await?;
        let tx = c.transaction().await?;
        // Lazy cleanup keeps an abandoned attempt from outliving its window. An attempt that
        // an issued device still points at stays, so a lost-response cancel still works.
        tx.execute(
            "DELETE FROM app.companion_pair_attempts a WHERE a.expires_at < now() \
             AND NOT EXISTS (SELECT 1 FROM app.companion_devices d WHERE d.pair_attempt_id = a.id)",
            &[],
        )
        .await?;
        let code = random_b64(24);
        let sql = format!(
            "INSERT INTO app.companion_pair_attempts \
               (approval_code_hash, verifier_hash, device_name, platform, app_version, os_version, \
                status, expires_at, recording_proof_hash, recording_policy_version) \
             VALUES ($1,$2,$3,$4,$5,$6,'pending', now() + make_interval(secs => $7::int), $8, $9) \
             RETURNING id, {}",
            iso("expires_at")
        );
        let row = tx
            .query_one(
                &sql,
                &[
                    &digest(&code),
                    &a.verifier_hash,
                    &a.device_name,
                    &a.platform,
                    &a.app_version,
                    &a.os_version,
                    &ATTEMPT_TTL_SECONDS,
                    &a.recording_proof_hash,
                    &a.recording_policy_version,
                ],
            )
            .await?;
        tx.commit().await?;
        Ok(CreatedAttempt {
            attempt_id: row.get(0),
            approval_path: format!("{APPROVAL_PATH}#code={code}"),
            approval_code: code,
            expires_at: row.get(1),
        })
    }

    pub async fn summarize(&self, approval_code: &str) -> Result<Option<AttemptSummary>> {
        let c = self.client().await?;
        let row = c
            .query_opt(
                "SELECT device_name, status, platform, recording_policy_version FROM app.companion_pair_attempts \
                 WHERE approval_code_hash = $1 AND expires_at > now() AND status <> 'redeemed'",
                &[&digest(approval_code)],
            )
            .await?;
        Ok(row.map(|r| AttemptSummary {
            device_name: r.get(0),
            status: r.get(1),
            platform: r.get(2),
            recording_policy_version: r.get(3),
        }))
    }

    /// Binds the approving account here, from the browser session, never from a request body.
    /// The status guard makes a second decision on one attempt impossible.
    pub async fn decide(
        &self,
        approval_code: &str,
        approve: bool,
        actor: Uuid,
        browser_session: Option<Uuid>,
        recording_policy_version: Option<i32>,
    ) -> Result<Decision> {
        let c = self.client().await?;
        let status = if approve { "approved" } else { "denied" };
        let hash = digest(approval_code);
        let done = c
            .query_opt(
                "UPDATE app.companion_pair_attempts \
                    SET status = $1, user_id = $2, \
                        recording_consent_version = CASE WHEN $1 = 'approved' AND recording_proof_hash IS NOT NULL THEN $5::integer ELSE NULL END \
                  WHERE approval_code_hash = $3 AND status = 'pending' AND expires_at > now() \
                    AND ((recording_proof_hash IS NULL AND platform = 'macos') OR $1 = 'denied' OR \
                      ((platform = 'android' OR recording_policy_version = $5::integer) AND EXISTS ( \
                        SELECT 1 FROM app.better_auth_sessions s JOIN app.users u ON u.id = s.user_id \
                         WHERE s.id = $4::uuid AND s.user_id = $2::uuid AND s.expires_at > now() AND u.status = 'active'))) \
                  RETURNING id",
                &[&status, &actor, &hash, &browser_session, &recording_policy_version],
            )
            .await?;
        if done.is_some() {
            return Ok(Decision::Done);
        }
        let seen = c
            .query_opt(
                "SELECT 1 FROM app.companion_pair_attempts WHERE approval_code_hash = $1 AND expires_at > now()",
                &[&hash],
            )
            .await?;
        Ok(if seen.is_some() { Decision::NotPending } else { Decision::Unknown })
    }

    pub async fn redeem(&self, attempt: Uuid, verifier: &str) -> Result<Redeemed> {
        let mut c = self.client().await?;
        let tx = c.transaction().await?;
        // One statement decides the race. Two redeems both match, only one UPDATE returns a row.
        let claim = tx
            .query_opt(
                "UPDATE app.companion_pair_attempts SET status = 'redeemed' \
                  WHERE id = $1 AND status = 'approved' AND verifier_hash = $2 AND expires_at > now() \
                  RETURNING user_id, device_name, recording_proof_hash, recording_consent_version, platform",
                &[&attempt, &digest(verifier)],
            )
            .await?;
        let Some(claim) = claim else {
            tx.rollback().await?;
            return Ok(Redeemed::Not(self.explain(attempt, verifier).await?));
        };
        let (user, name, proof, consent, platform): (Uuid, String, Option<String>, Option<i32>, String) =
            (claim.get(0), claim.get(1), claim.get(2), claim.get(3), claim.get(4));
        let credential = format!(
            "{}{}",
            if platform == "android" { RING_PREFIX } else { MAC_PREFIX },
            random_b64(32)
        );
        let sql = format!(
            "INSERT INTO app.companion_devices \
               (user_id, credential_hash, display_name, platform, app_version, os_version, \
                expires_at, absolute_expires_at, pair_attempt_id) \
             SELECT $1, $2, $3, a.platform, a.app_version, a.os_version, \
                    now() + make_interval(days => $4::int), now() + make_interval(days => $5::int), a.id \
               FROM app.companion_pair_attempts a WHERE a.id = $6 \
             RETURNING id, display_name, {}",
            iso("expires_at")
        );
        let device = tx
            .query_one(
                &sql,
                &[&user, &digest(&credential), &name, &INACTIVITY_DAYS, &ABSOLUTE_DAYS, &attempt],
            )
            .await?;
        let device_id: Uuid = device.get(0);
        let approved = proof.is_some() && consent == Some(1);
        if let (true, Some(proof)) = (approved, proof) {
            tx.execute(
                "INSERT INTO app.companion_recording_capabilities(device_id, owner_user_id, proof_hash, policy_version, revision, approved_at) \
                 VALUES ($1,$2,$3,1,1,now())",
                &[&device_id, &user, &proof],
            )
            .await?;
        }
        let account = tx.query_opt("SELECT name, email FROM app.users WHERE id = $1", &[&user]).await?;
        let Some(account) = account else {
            tx.rollback().await?;
            return Ok(Redeemed::Not(Pending::Unknown));
        };
        let (acc_name, email): (Option<String>, String) = (account.get(0), account.get(1));
        tx.commit().await?;
        Ok(Redeemed::Issued(Box::new(Issued {
            credential,
            device_id,
            display_name: device.get(1),
            account_name: acc_name.unwrap_or_else(|| email.clone()),
            account_email: email,
            account_id: (platform == "android").then_some(user),
            expires_at: device.get(2),
            recording_revision: approved.then_some(1),
        })))
    }

    /// A wrong verifier reads as unknown, exactly like a missing attempt.
    async fn explain(&self, attempt: Uuid, verifier: &str) -> Result<Pending> {
        let c = self.client().await?;
        let row = c
            .query_opt(
                "SELECT status, expires_at <= now(), verifier_hash = $2 FROM app.companion_pair_attempts WHERE id = $1",
                &[&attempt, &digest(verifier)],
            )
            .await?;
        let Some(row) = row else { return Ok(Pending::Unknown) };
        let (status, expired, matches): (String, bool, bool) = (row.get(0), row.get(1), row.get(2));
        Ok(if !matches {
            Pending::Unknown
        } else if expired {
            Pending::Expired
        } else {
            match status.as_str() {
                "pending" => Pending::Pending,
                "denied" => Pending::Denied,
                "redeemed" => Pending::Redeemed,
                _ => Pending::Unknown,
            }
        })
    }

    /// Cancel undoes the whole link. The device goes first because deleting the attempt
    /// clears the column that points at it.
    pub async fn cancel(&self, attempt: Uuid, verifier: &str) -> Result<()> {
        let mut c = self.client().await?;
        let tx = c.transaction().await?;
        let hash = digest(verifier);
        tx.query(
            "SELECT id FROM app.companion_pair_attempts WHERE id = $1 AND verifier_hash = $2 FOR UPDATE",
            &[&attempt, &hash],
        )
        .await?;
        tx.execute(
            "DELETE FROM app.companion_devices WHERE pair_attempt_id IN \
               (SELECT id FROM app.companion_pair_attempts WHERE id = $1 AND verifier_hash = $2)",
            &[&attempt, &hash],
        )
        .await?;
        tx.execute(
            "DELETE FROM app.companion_pair_attempts WHERE id = $1 AND verifier_hash = $2",
            &[&attempt, &hash],
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }

    /// Deletes the device a credential belongs to. Revoked means the row is gone.
    pub async fn logout(&self, credential: &str) -> Result<()> {
        let c = self.client().await?;
        c.execute("DELETE FROM app.companion_devices WHERE credential_hash = $1", &[&digest(credential)])
            .await?;
        Ok(())
    }

    /// The owner removes one of their own devices. `false` when the device is not theirs, so a
    /// guessed id learns nothing. The device's credential stops working at once.
    pub async fn unlink(&self, owner: Uuid, device: Uuid) -> Result<bool> {
        let c = self.client().await?;
        let removed = c
            .execute("DELETE FROM app.companion_devices WHERE id = $1 AND user_id = $2", &[&device, &owner])
            .await?;
        Ok(removed > 0)
    }

    /// The ring (Android) credential's owner and device, refreshing its expiry like any call.
    pub async fn ring_session(&self, credential: &str) -> Result<Option<RingSession>> {
        if !credential_shape(credential, RING_PREFIX) {
            return Ok(None);
        }
        let c = self.client().await?;
        let row = c
            .query_opt(
                "SELECT user_id, device_id FROM app.resolve_companion_device($1) WHERE platform = 'android'",
                &[&digest(credential)],
            )
            .await?;
        let Some(r) = row else { return Ok(None) };
        let owner: Uuid = r.get(0);
        // A pending or deactivated account gets no ring session.
        let status: Option<String> = c
            .query_opt("SELECT status FROM app.get_user_by_id($1::uuid)", &[&owner])
            .await?
            .map(|u| u.get(0));
        if matches!(status.as_deref(), None | Some("pending") | Some("deactivated")) {
            return Ok(None);
        }
        Ok(Some(RingSession { owner, device_id: r.get(1) }))
    }

    /// Admin sign-out. Removes every device and every browser session of one account in one
    /// transaction, so a failure leaves both untouched.
    pub async fn revoke_all_for(&self, user: Uuid) -> Result<u64> {
        let mut c = self.client().await?;
        let tx = c.transaction().await?;
        // With Meetings never installed the table does not exist, and there are no devices.
        let present: bool = tx.query_one("SELECT to_regclass('app.companion_devices') IS NOT NULL", &[]).await?.get(0);
        let devices = if present {
            tx.execute("DELETE FROM app.companion_devices WHERE user_id = $1", &[&user]).await?
        } else {
            0
        };
        let sessions = tx.execute("DELETE FROM app.better_auth_sessions WHERE user_id = $1", &[&user]).await?;
        tx.commit().await?;
        Ok(devices + sessions)
    }
}
