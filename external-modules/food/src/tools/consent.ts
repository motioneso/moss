// external-modules/food/src/tools/consent.ts
//
// Food Phase 1 (#926, #1701, plan §4 Task 4): food.consent.get (read) and
// food.consent.grant (write). Both operate on the single kv record at
// scope "user", namespace "food.settings" (manifest storage[0].namespace),
// key "consent" — the exact namespace/key worker.ts's hasGrantedConsent
// already reads, kept in sync here rather than re-guessed.
//
// Constraint 7 (read-risk tools must not call kv.set/kv.delete — the host
// returns forbidden_kv_mutation): food.consent.get only ever calls kv.get.

import type { ModuleWorkerContext } from "@moss/module-sdk/worker";

import { readBool, requireNoUnknownKeys, stripEnvelope } from "./validate.js";

const CONSENT_NAMESPACE = "food.settings";
const CONSENT_KEY = "consent";

export interface ConsentState {
  readonly granted: boolean;
  readonly grantedAt: string | null;
}

async function readConsent(ctx: ModuleWorkerContext): Promise<ConsentState> {
  const record = await ctx.kv.get("user", CONSENT_NAMESPACE, CONSENT_KEY);
  if (record === null || record["granted"] !== true) {
    return { granted: false, grantedAt: null };
  }
  const grantedAt = record["grantedAt"];
  return { granted: true, grantedAt: typeof grantedAt === "string" ? grantedAt : null };
}

/** `food.consent.get` — read. No input fields. */
export async function getConsent(ctx: ModuleWorkerContext): Promise<ConsentState> {
  const input = stripEnvelope(ctx.input);
  requireNoUnknownKeys(input, new Set());
  return readConsent(ctx);
}

const GRANT_CONSENT_KEYS = new Set(["granted"]);

/** `food.consent.grant` — write. Sets or revokes AI-estimation consent (plan §1 finding: consent
 * is a write-risk assistant tool the user grants through Chat, not a settings-page toggle in
 * Phase 1). `grantedAt` is always this call's own timestamp when granting, and null on revoke —
 * never a caller-supplied instant (no ambient-date input, matching job-search's convention). */
export async function grantConsent(ctx: ModuleWorkerContext): Promise<ConsentState> {
  const input = stripEnvelope(ctx.input);
  requireNoUnknownKeys(input, GRANT_CONSENT_KEYS);
  const granted = readBool(input, "granted", { required: true });

  const next: ConsentState = {
    granted,
    grantedAt: granted ? new Date().toISOString() : null
  };
  await ctx.kv.set("user", CONSENT_NAMESPACE, CONSENT_KEY, {
    granted: next.granted,
    grantedAt: next.grantedAt
  });
  return next;
}

export const consentHandlers = {
  "consent.get": getConsent,
  "consent.grant": grantConsent
};
