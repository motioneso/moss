import { sql } from "kysely";
import { assertDataContextDb, type DataContextDb } from "@moss/db";
import { defaultProactiveMonitoringPreference } from "@moss/shared";

import { localMidnight } from "./anti-spam.js";
import { CardRepository } from "./card-repository.js";
import {
  resolveAutomaticEmailAlertsEnabled,
  resolveSourcePreference,
  type SavedProactiveMonitoringPreference
} from "./preferences-repository.js";

/** Unsolicited email findings selected per hour. */
const EMAIL_HOURLY_CAP = 1;

/**
 * `unsolicited` is an automatic email alert and spends the email budget. `requested` is a
 * responsibility the user asked for; it spends nothing and ignores the automatic-alert switch.
 */
export type EmailFindingKind = "unsolicited" | "requested";

export type EmailFindingRejection =
  | "automatic_email_alerts_off"
  | "global_daily_cap"
  | "source_daily_cap"
  | "source_hourly_cap";

/**
 * A finding charged by an earlier selection comes back selected but uncharged. Each consumer
 * decides whether it still has something to show for it.
 */
export type EmailFindingSelection =
  | { readonly selected: true; readonly charged: true }
  | {
      readonly selected: true;
      readonly charged: false;
      readonly reason: "requested" | "already_selected";
    }
  | { readonly selected: false; readonly reason: EmailFindingRejection };

export interface EmailFindingInput {
  readonly kind: EmailFindingKind;
  readonly ownerUserId: string;
  readonly stableKey: string;

  /** The owner's stored preference as read by the repository: undefined absent, null malformed. */
  readonly saved: SavedProactiveMonitoringPreference | null | undefined;
  readonly nowIso: string;
  readonly timeZone: string;
}

interface BudgetRow {
  readonly already: boolean;
  readonly email_today: string;
  readonly email_last_hour: string;
}

/**
 * The single selection point for unsolicited email findings. Every consumer that surfaces one
 * selects through it, so a finding is charged once.
 *
 * An allowed unsolicited selection writes its charge in the caller's transaction. A per-owner
 * transaction lock serialises concurrent scans, so the cap check and the charge are atomic.
 * Charges never refill on dismissal and are counted on the selection day in the owner's zone.
 */
export class EmailFindingPolicy {
  constructor(private readonly cards = new CardRepository()) {}

  async select(scopedDb: DataContextDb, input: EmailFindingInput): Promise<EmailFindingSelection> {
    assertDataContextDb(scopedDb);
    if (input.kind === "requested") return { selected: true, charged: false, reason: "requested" };
    if (!resolveAutomaticEmailAlertsEnabled(input.saved)) {
      return { selected: false, reason: "automatic_email_alerts_off" };
    }

    await sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${`proactive-email-budget:${input.ownerUserId}`}, 0))
    `.execute(scopedDb.db);

    const pref = input.saved?.preference ?? defaultProactiveMonitoringPreference();
    const dayStart = localMidnight(input.nowIso, input.timeZone);
    const result = await sql<BudgetRow>`
      SELECT
        EXISTS (
          SELECT 1 FROM app.proactive_email_finding_charges
          WHERE owner_user_id = ${input.ownerUserId}::uuid AND stable_key = ${input.stableKey}
        ) AS already,
        (SELECT COUNT(*) FROM app.proactive_email_finding_charges
          WHERE owner_user_id = ${input.ownerUserId}::uuid
            AND charged_at >= ${dayStart}::timestamptz) AS email_today,
        (SELECT COUNT(*) FROM app.proactive_email_finding_charges
          WHERE owner_user_id = ${input.ownerUserId}::uuid
            AND charged_at >= (${input.nowIso}::timestamptz - interval '1 hour')) AS email_last_hour
    `.execute(scopedDb.db);
    const row = result.rows[0];
    if (!row) throw new Error("email budget query returned no row");
    if (row.already) return { selected: true, charged: false, reason: "already_selected" };

    // Other sources keep their legacy rule: active cards today, so dismissal refills them.
    const active = await this.cards.getActiveCounts(
      scopedDb,
      input.ownerUserId,
      "email",
      input.nowIso,
      dayStart
    );
    const emailToday = Number(row.email_today);
    if (emailToday + active.totalToday - active.sourceToday >= pref.dailyCardCap) {
      return { selected: false, reason: "global_daily_cap" };
    }
    if (emailToday >= resolveSourcePreference(pref, "email").dailyCardCap) {
      return { selected: false, reason: "source_daily_cap" };
    }

    // An email card held by quiet hours counts at its release time, so held findings
    // surface at most one per hour once quiet hours end.
    if (Math.max(Number(row.email_last_hour), active.sourceLastHour) >= EMAIL_HOURLY_CAP) {
      return { selected: false, reason: "source_hourly_cap" };
    }

    const charged = await sql`
      INSERT INTO app.proactive_email_finding_charges (owner_user_id, stable_key, charged_at)
      VALUES (${input.ownerUserId}::uuid, ${input.stableKey}, ${input.nowIso}::timestamptz)
      ON CONFLICT (owner_user_id, stable_key) DO NOTHING
      RETURNING stable_key
    `.execute(scopedDb.db);
    return charged.rows.length > 0
      ? { selected: true, charged: true }
      : { selected: true, charged: false, reason: "already_selected" };
  }
}
