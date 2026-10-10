/**
 * Upgrade shims for already-shipped migration files that cannot be edited (the runner
 * hash-checks applied files). A shim runs inside the same transaction as its file, so it is
 * applied or rolled back with it.
 *
 * #3201: the owner tables below are FORCE ROW LEVEL SECURITY with runtime-role policies only,
 * and migrations run as a NOBYPASSRLS owner, so under FORCE the owner sees no rows and the
 * file's backfills touch nothing. The runner lifts FORCE on the listed tables for the file's
 * transaction only and restores the prior setting before commit.
 */
export interface LegacyUpgradeShim {
  /** Exact file bytes the shim was written for; any other bytes get no shim. */
  readonly checksum: string;
  /** Tables whose FORCE ROW LEVEL SECURITY is lifted for this file's transaction. */
  readonly relaxForcedRls: readonly string[];
  /** Statements run before the file, after FORCE is lifted. */
  readonly before?: readonly string[];
}

export type LegacyUpgradeShims = Readonly<Record<string, LegacyUpgradeShim>>;

export const LEGACY_UPGRADE_SHIMS: LegacyUpgradeShims = {
  "0191_sports_public_source_runtime.sql": {
    checksum: "9c54be2ac548c2b3e39a68ffe9aa3d6c175e9978dedae1bbef554607bbc37e6b",
    relaxForcedRls: ["app.sports_custom_sources", "app.sports_source_assignments"]
  },
  // The old health CHECK would reject the rewrite to the new values, which 0204 only drops
  // afterwards. Dropped here only while it is still the old definition.
  "0204_news_source_health_states.sql": {
    checksum: "3f2a7f2ab458bab2d568ef202e92960cb6574cbe3a857fbb91194b09717c0053",
    relaxForcedRls: ["app.news_custom_sources"],
    before: [
      `DO $$
       BEGIN
         IF EXISTS (
           SELECT 1 FROM pg_constraint
            WHERE conrelid = 'app.news_custom_sources'::regclass
              AND conname = 'news_custom_sources_health_status_check'
              AND pg_get_constraintdef(oid) LIKE '%''available''%'
         ) THEN
           ALTER TABLE app.news_custom_sources DROP CONSTRAINT news_custom_sources_health_status_check;
         END IF;
       END
       $$`
    ]
  },
  "0218_news_source_kinds.sql": {
    checksum: "2f4ce7bf4ba1ce322109652ec4fb517b934ec032fff9632c1d73f2419f8c79ec",
    relaxForcedRls: ["app.news_custom_sources"]
  }
};
