/**
 * #1025: the level ladder from spec §4.3 — each level is additive over the
 * previous one (admin+data = solo-admin + feature chunks; multi-user adds a
 * second user + cross-user fixtures on top of admin+data). Not four independent
 * seed files.
 */
export type UatSeedLevel = "bare" | "solo-admin" | "admin+data" | "multi-user";

// #1087 finding 5: canonical enum values, single source of truth for
// tests/uat/seed/level-validation.ts's fail-closed parsers — kept next to the
// type union itself so the two can never drift apart.
export const UAT_SEED_LEVELS: readonly UatSeedLevel[] = [
  "bare",
  "solo-admin",
  "admin+data",
  "multi-user"
];

/** #1025 spec §4.4: per-feature chunk list seeded at admin+data and above. */
export type UatSeedChunk = "news" | "sports" | "tasks" | "calendar" | "notes" | "finance";

// #1087 finding 5: canonical chunk names accepted in excludeChunks — see
// UAT_SEED_LEVELS above for why this lives beside the type.
export const UAT_SEED_CHUNKS: readonly UatSeedChunk[] = [
  "news",
  "sports",
  "tasks",
  "calendar",
  "notes",
  "finance"
];

// #1306/N33 (Task 22): job-search has NO chunk here, deliberately, and none should be added — not
// even a no-op. #1087 finding 3 requires job-search to be NOT INSTALLED by default at admin+data,
// so #1026's absent-module UI path stays reachable; a registered chunk is the vocabulary that
// invites a future agent to add it to `ADMIN_DATA_CHUNKS` (tests/uat/seed/levels.ts) and silently
// re-break that path. Task 22 Phase 1 installs the module LIVE via docker-cp + the admin UI (the
// finance precedent), so seeding a profile/criteria row here would also skip the very onboarding
// flow that UAT exists to exercise. See docs/superpowers/handoffs/2026-07-27-job-search/
// rulings-ledger.md#n33 for the full reasoning. If a later spec genuinely needs seeded job-search
// data, add a real chunk with real content, deliberately — do not resurrect this as a no-op.

// #1121: one id per fixture JSON at tests/uat/fixtures/chat-scripts/<id>.json. "phase1-smoke" is
// the only Phase 1 entry — backs Task 3's own end-to-end integration test, not a converted UAT
// spec. Each Phase 2 task appends its own id here when it adds that id's fixture JSON, same
// additive-registry pattern as UAT_SEED_LEVELS/UAT_SEED_CHUNKS above.
export type UatChatScript =
  | "phase1-smoke"
  | "1533-surface-probe"
  | "1252-audit-truth-livepath"
  | "1105-drawer-private";

export const UAT_CHAT_SCRIPTS: readonly UatChatScript[] = [
  "phase1-smoke",
  "1533-surface-probe",
  "1252-audit-truth-livepath",
  "1105-drawer-private"
];

export interface SeedOptions {
  readonly level: UatSeedLevel;
  /** #1025: e.g. omit a chunk to prove the absent-module UI path. */
  readonly excludeChunks?: readonly UatSeedChunk[];
  /** #1110: leave module.news unbound to a JSON-capable model, to prove the prerequisite-error path. */
  readonly withoutNewsJsonBinding?: boolean;
  /**
   * N42/#57: absent by default (no-op — see seedJobSearchAiProviderChunk). When set, seeds a fake
   * `openai-compatible` provider/model bound to `module.job-search` pointed at this base URL (the
   * job-search fixture server's docker-reachable address). Deliberately NOT a UatSeedChunk/
   * ADMIN_DATA_CHUNKS entry — see ./chunks/job-search-ai.ts's header and N33.
   */
  readonly jobSearchAiProviderBaseUrl?: string;
  /**
   * #1121: when set, seeds a neutral scripted AI provider/model (see
   * ./chunks/chat-script.ts) and writes JARVIS_UAT_SCRIPTED_PROVIDER_BIN (#1659 defect 4) so the
   * scripted-provider fixture's own bin/ lands ahead of the real tools bin on the container's
   * PATH — the deterministic UAT chat path. Absent by default; default seed behavior is
   * byte-for-byte unchanged.
   */
  readonly chatScript?: UatChatScript;
}
