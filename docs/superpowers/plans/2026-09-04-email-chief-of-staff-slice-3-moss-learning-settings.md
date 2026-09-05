# Email as Chief of Staff, Slice 3: Moss knows, dismissals teach, settings

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Moss answer "what do I owe people?" in chat, make "Not something I owe" dismissals teach per sender, and give the user the two settings the spec names.

**Architecture:** The existing `commitments.list` tool grows to return email items with their proposed actions and why lines, so Moss reads the same rows the Today card shows (no standing context injection, spec section 7). A small sender-rules table in commitments counts "not owed" dismissals per sender address; at two it flips a flag the slice 1 worker already reads through `senderRuledNotObligation`. The two settings ride the existing email briefing-settings route and preferences store: "Judge with context" (feeds the worker's `contextEnabled`) and the sender rules list, both on the Email settings page.

**Tech Stack:** as the shared header (`2026-09-04-email-chief-of-staff.md`). Read that header and its Global Constraints first.

**Spec:** `docs/superpowers/specs/2026-09-04-email-chief-of-staff-design.md` sections 5 (dismiss reasons), 7 (Moss in chat), 8 (learning), 9 (settings).

**Spec deviation, decided here, flag to Ben:** the spec puts the per-sender "not something I owe" toggle on the sender's People entry. There is no People screen in the web app, so the rules are listed and switchable in Email settings instead, with the sender shown by display name and address.

## File Structure (this slice)

- Modify `packages/commitments/src/tools.ts`: `commitmentListExecute` returns email items with `actions`, `whyLines`, `threadRef`, `counterpartyLabel`, `stale`; tool description updated.
- Create `packages/commitments/sql/0218_commitment_sender_rules.sql`; `packages/commitments/src/sender-rules.ts` (repository + `recordNotOwedDismissal`, `isSenderRuledNotObligation`, `listSenderRules`, `setSenderRule`); routes `GET/PUT /api/commitments/sender-rules`.
- Modify `packages/shared/src/commitments-api.ts`: `CommitmentSenderRuleDto`, list/put request types and schemas.
- Modify `packages/shared/src/email-briefing-settings-api.ts`: `judgeWithContext` on the DTO, update request and schemas.
- Modify `packages/email/src/routes.ts`: read/write `EMAIL_JUDGE_WITH_CONTEXT_KEY = "email.judge_with_context"`; export `readJudgeWithContext(scopedDb, preferences)` from `packages/email/src/judge-with-context.ts`.
- Modify `packages/email/src/settings/index.tsx`: "Judge with context" switch and "Senders you have ruled not owed" list.
- Modify `packages/module-registry/src/index.ts`: pass `senderRuledNotObligation`, `contextEnabled`, `onNotOwed`.
- Modify manifests (commitments `settings`/`features`, email `features`) and `packages/shared/src/app-map-core.ts` if the Email settings description changes.
- Tests: `tests/unit/commitment-list-tool-email-items.test.ts`, `commitment-sender-rules.test.ts`, `commitment-sender-rules-routes.test.ts`, `email-judge-with-context-setting.test.ts`, `packages/email/src/settings/index.test.tsx` (extend if it exists; otherwise create following an existing module settings test).

### Task 1: `commitments.list` returns email items Moss can act on

**Files:**

- Modify: `packages/commitments/src/tools.ts:7-22`, `packages/commitments/src/manifest.ts:70-91`
- Test: `tests/unit/commitment-list-tool-email-items.test.ts`

**Interfaces (Consumes):** `CommitmentCandidate` fields from slice 1 Task 5 and slice 2 Task 3 (`threadRef`, `whyLines`, `proposedActions`, `stale`, `linkedTaskId`); `toOwedItemDto` from slice 2 Task 1 (`packages/commitments/src/owed-dto.ts`).

**Interfaces (Produces):** tool result `{ data: { items: ToolItem[], owedSummary: string } }` where

```ts
type ToolItem = {
  id;
  kind;
  title;
  status;
  confidence;
  dueLocalDate;
  counterpartyLabel;
  sourceCount;
  lastSeenAt;
  source: "email" | "other"; // the candidate row does not carry its source kind; sources live in a separate table
  whyLines?: string[]; // email items only
  actions?: { kind: "reply" | "task" | "snooze" | "dismiss"; label: string; primary: boolean }[];
  stale?: boolean;
  linkedTaskId?: string | null;
};
```

`owedSummary` is one plain sentence Moss can quote: "You owe 3 people something: Sarah Kim (Fri), Dr. Alvarez's office (Wed), Fidelity (Mon)." or "Nothing owed right now." Input gains optional `includeOlder?: boolean` (default false; when true, stale and snoozed email items are included and marked).

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it, vi } from "vitest";
vi.mock("../../packages/commitments/src/repository.js", () => ({
  CommitmentsRepository: vi.fn(() => repo)
}));
const repo = { listCandidates: vi.fn(), listOpenEmailCandidates: vi.fn() };
const { commitmentListExecute } = await import("../../packages/commitments/src/tools.js");
import { dataContextBrand } from "@moss/db";
const fakeDb = { [dataContextBrand]: true } as any;
const emailCand = {
  id: "c1",
  kind: "obligation",
  title: "Send Sarah the lease addendum",
  status: "pending_review",
  confidence: "high",
  dueLocalDate: "2026-09-05",
  counterpartyLabel: "Sarah Kim",
  counterpartyAddress: "sarah@kim.example",
  sourceCount: 2,
  lastSeenAt: new Date("2026-09-04T10:00:00Z"),
  threadRef: "t1",
  whyLines: ['"Could you send it back by Friday?"'],
  proposedActions: [{ kind: "task", title: "Send addendum", dueLocalDate: "2026-09-05" }],
  stale: false,
  linkedTaskId: null,
  snoozedUntil: null,
  resolutionRef: null
};
const chatCand = {
  ...emailCand,
  id: "c2",
  threadRef: null,
  whyLines: [],
  proposedActions: [],
  title: "Call mum",
  counterpartyLabel: "Mum",
  counterpartyAddress: null
};
describe("commitments.list with email items", () => {
  it("marks source, includes why and actions for email items only, and writes a summary", async () => {
    repo.listCandidates.mockResolvedValue([emailCand, chatCand]);
    const r: any = await commitmentListExecute(fakeDb, {}, { actorUserId: "u1" } as any);
    const [e, c] = r.data.items;
    expect(e.source).toBe("email");
    expect(e.actions[0]).toMatchObject({ kind: "task", primary: true, label: "Task, due Fri" });
    expect(e.whyLines).toHaveLength(1);
    expect(c.source).toBe("other");
    expect(c.actions).toBeUndefined();
    expect(r.data.owedSummary).toBe("You owe 2 people something: Sarah Kim (Fri), Mum.");
    expect(JSON.stringify(r.data)).not.toContain("sarah@kim.example");
  });
  it("hides stale email items unless includeOlder", async () => {
    repo.listCandidates.mockResolvedValue([{ ...emailCand, stale: true }]);
    expect(
      ((await commitmentListExecute(fakeDb, {}, { actorUserId: "u1" } as any)) as any).data
        .owedSummary
    ).toBe("Nothing owed right now.");
    expect(
      (
        (await commitmentListExecute(fakeDb, { includeOlder: true }, {
          actorUserId: "u1"
        } as any)) as any
      ).data.items[0].stale
    ).toBe(true);
  });
});
```

`assertDataContextDb` checks a brand symbol, so pass `{ [dataContextBrand]: true } as any` (import `dataContextBrand` from `@moss/db`) instead of `{} as any` for the first argument.

- [ ] **Step 2: Run, FAIL. Step 3: Implement:**

```ts
export const commitmentListExecute: ToolExecute = async (scopedDb, input, ctx) => {
  assertDataContextDb(scopedDb);
  const { status, includeOlder } = (input ?? {}) as {
    status?: CandidateStatus;
    includeOlder?: boolean;
  };
  const today = new Date().toISOString().slice(0, 10);
  const candidates = await repo.listCandidates(
    scopedDb,
    ctx.actorUserId,
    status ?? "pending_review"
  );
  const visible = candidates.filter(
    (c) =>
      includeOlder || !(c.threadRef && (c.stale || (c.snoozedUntil && c.snoozedUntil > new Date())))
  );
  const items = visible.map((c) => {
    const base = {
      id: c.id,
      kind: c.kind,
      title: c.title,
      status: c.status,
      confidence: c.confidence,
      dueLocalDate: c.dueLocalDate,
      counterpartyLabel: c.counterpartyLabel,
      sourceCount: c.sourceCount,
      lastSeenAt: c.lastSeenAt.toISOString(),
      source: c.threadRef ? "email" : "other"
    };
    if (!c.threadRef) return base;
    const dto = toOwedItemDto(c, {
      messageCount: c.sourceCount,
      replyToCacheMessageId: null,
      today
    });
    return {
      ...base,
      whyLines: dto.whyLines,
      actions: dto.actions.map(({ kind, label, primary }) => ({ kind, label, primary })),
      stale: dto.stale,
      linkedTaskId: dto.linkedTaskId
    };
  });
  return { data: { items, owedSummary: summarise(items, today) } } satisfies ToolResult;
};
function summarise(
  items: readonly { counterpartyLabel: string | null; dueLocalDate: string | null }[],
  today: string
): string {
  if (items.length === 0) return "Nothing owed right now.";
  const parts = items.map((i) => {
    const d = shortDue(i.dueLocalDate, today);
    return `${i.counterpartyLabel ?? "someone"}${d ? ` (${d[0].toUpperCase()}${d.slice(1)})` : ""}`;
  });
  return `You owe ${items.length} ${items.length === 1 ? "person" : "people"} something: ${parts.join(", ")}.`;
}
```

`shortDue` comes from `@moss/shared` (moved there in slice 2 Task 10). Update the manifest tool description to: "List what you owe people, from email, chats and notes. Email items include why Moss thinks so and the actions it proposes (reply, task, snooze, dismiss). Use includeOlder to see snoozed and stale items." and add `includeOlder: { type: "boolean" }` to `inputSchema.properties`.

- [ ] **Step 4: Run, PASS, typecheck. Step 5: Commit** `feat(commitments): commitments.list tells Moss what the user owes, with why and actions`.

### Task 2: Sender rules store

**Files:**

- Create: `packages/commitments/sql/0218_commitment_sender_rules.sql`, `packages/commitments/src/sender-rules.ts`
- Modify: `packages/commitments/src/manifest.ts` (migrations, ownedTables), `packages/commitments/src/types.ts`
- Test: `tests/unit/commitment-sender-rules.test.ts`

```sql
CREATE TABLE app.commitment_sender_rules (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  sender_address text NOT NULL,
  display_name text,
  not_owed_dismissals integer NOT NULL DEFAULT 0,
  ruled_not_obligation boolean NOT NULL DEFAULT false,
  ruled_by text NOT NULL DEFAULT 'auto' CHECK (ruled_by IN ('auto','user')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, sender_address)
);
ALTER TABLE app.commitment_sender_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.commitment_sender_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY commitment_sender_rules_owner ON app.commitment_sender_rules
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON app.commitment_sender_rules TO moss_app, moss_worker;
```

Copy the exact policy helper name and grant roles from `packages/commitments/sql/0125_commitment_candidates.sql`; do not guess them.

**Interfaces (Produces):**

```ts
export const NOT_OWED_THRESHOLD = 2;
export interface CommitmentSenderRule {
  ownerUserId;
  senderAddress;
  displayName: string | null;
  notOwedDismissals: number;
  ruledNotObligation: boolean;
  ruledBy: "auto" | "user";
  updatedAt: Date;
}
export class SenderRulesRepository {
  recordNotOwedDismissal(
    scopedDb,
    ownerUserId,
    senderAddress,
    displayName: string | null
  ): Promise<CommitmentSenderRule>; // upsert; increments; sets ruled_not_obligation = true when count >= 2 and ruled_by = 'auto'
  isRuledNotObligation(scopedDb, ownerUserId, senderAddress): Promise<boolean>;
  list(scopedDb, ownerUserId): Promise<CommitmentSenderRule[]>; // ordered by updated_at desc
  setRule(
    scopedDb,
    ownerUserId,
    senderAddress,
    ruledNotObligation: boolean
  ): Promise<CommitmentSenderRule>; // ruled_by = 'user'
}
```

Addresses are lower-cased and trimmed before every query (`normaliseAddress`). A user-set rule (`ruled_by='user'`) is never overridden by the auto counter.

- [ ] **Step 1: Failing tests** using `makeRecordingDb` from `tests/unit/helpers/recording-db.ts` (slice 1 Task 5): the compiled SQL of `recordNotOwedDismissal` contains `on conflict ("owner_user_id", "sender_address")`, `"not_owed_dismissals" + 1`, and a `case when` that sets the flag only where `"ruled_by" = 'auto'` and the new count reaches a parameter equal to `NOT_OWED_THRESHOLD`; `isRuledNotObligation` lower-cases the input (`"Sarah@Kim.Example"` appears in `parameters` as `"sarah@kim.example"`); `setRule` writes `ruled_by` = `'user'`. Write these with Kysely's `sql` template inside the query builder (`sql\`...\``) where the builder has no method for it, exactly as the existing repository does for anything non-trivial.
- [ ] **Step 2: Run, FAIL. Step 3: Implement. Step 4: Run, PASS, typecheck.** Add the file to `migrations` and `commitment_sender_rules` to `ownedTables`.
- [ ] **Step 5: Commit** `feat(commitments): per-sender "not something I owe" rules with a two-dismissal threshold`.

### Task 3: Wire learning into dismiss and judgement

**Files:**

- Modify: `packages/module-registry/src/index.ts`
- Test: `tests/unit/module-registry-sender-rules-wiring.test.ts`

Slice 1's worker takes `senderRuledNotObligation?: (scopedDb, actorUserId, address) => Promise<boolean>`; slice 2's `performDismiss` takes `onNotOwed?: (scopedDb, actorUserId, address) => Promise<void>` via `CommitmentsRouteDependencies.onNotOwed`. Build one `SenderRulesRepository` and pass:

```ts
const senderRules = new SenderRulesRepository();
// worker deps
senderRuledNotObligation: (db, uid, addr) => senderRules.isRuledNotObligation(db, uid, addr),
// routes deps
onNotOwed: async (db, uid, addr) => { await senderRules.recordNotOwedDismissal(db, uid, addr, null); },
```

Also, when a rule flips to true, open items from that sender should not linger: in `onNotOwed`, if the returned rule has `ruledNotObligation === true`, call `repository.rejectOpenEmailCandidatesFrom(db, uid, addr)` (new repository method built with the query builder: update `status` to `explicit_non_action` where `owner_user_id`, `counterparty_address` match, `thread_ref` is not null, `resolution_ref` is null and `status` is `pending_review` or `snoozed`; add a recording-db test in `tests/unit/commitment-email-repository-sql.test.ts`).

- [ ] Failing wiring test (fake `SenderRulesRepository`, assert both hooks call through with the same address; assert `rejectOpenEmailCandidatesFrom` is called only when the rule is flipped). Run; implement; run; commit `feat(registry): dismissals teach the judgement which senders are not owed`.

### Task 4: Sender rules routes

**Files:**

- Modify: `packages/shared/src/commitments-api.ts`, `packages/commitments/src/routes.ts`, `packages/commitments/src/manifest.ts` (routes)
- Test: `tests/unit/commitment-sender-rules-routes.test.ts`

```ts
export interface CommitmentSenderRuleDto {
  senderAddress: string;
  displayName: string | null;
  notOwedDismissals: number;
  ruledNotObligation: boolean;
  ruledBy: "auto" | "user";
  updatedAt: string;
}
export interface ListCommitmentSenderRulesResponse {
  rules: CommitmentSenderRuleDto[];
}
export interface PutCommitmentSenderRuleRequest {
  senderAddress: string;
  ruledNotObligation: boolean;
}
```

Routes: `GET /api/commitments/sender-rules` (permission `commitments.view`) and `PUT /api/commitments/sender-rules` (permission `commitments.update`; body validated with TypeBox `Type.Object({ senderAddress: Type.String({ format: "email" }), ruledNotObligation: Type.Boolean() })`). Both are declared in the manifest `routes`.

- [ ] Failing test: GET lists rules for the actor; PUT flips a rule and returns it with `ruledBy: "user"`; PUT with a malformed address is 400. Run; implement; run; commit `feat(commitments): read and set per-sender not-owed rules`.

### Task 5: "Judge with context" setting

**Files:**

- Modify: `packages/shared/src/email-briefing-settings-api.ts` (add `judgeWithContext: boolean` to the DTO and `required`, optional on the update request, both schemas), `packages/email/src/routes.ts` (`EMAIL_JUDGE_WITH_CONTEXT_KEY = "email.judge_with_context"`, read in `readEmailBriefingSettings` as `judgeWithContext === false ? false : true`, write in the PATCH branch list)
- Create: `packages/email/src/judge-with-context.ts` exporting `readJudgeWithContext(scopedDb, preferences: PreferencesPort): Promise<boolean>` (same default-true rule) and re-export from `packages/email/src/index.ts`
- Modify: `packages/module-registry/src/index.ts`: worker deps `contextEnabled: (db, uid) => readJudgeWithContext(db, preferencesRepository)`
- Test: `tests/unit/email-judge-with-context-setting.test.ts` (GET returns `judgeWithContext: true` when unset; PATCH `{ judgeWithContext: false }` writes the key; `readJudgeWithContext` returns false only for a stored `false`). Extend the existing briefing-settings route test if one exists rather than duplicating its harness.

- [ ] Failing tests; run; implement; run; commit `feat(email): "Judge with context" setting feeds the email judgement`.

### Task 6: Email settings page: switch and sender rules list

**Files:**

- Modify: `packages/email/src/settings/index.tsx`
- Create: `apps/web/src/api/client-commitments.ts` additions `getSenderRules()`, `putSenderRule(body)` (slice 2 created this file; the settings entry imports from `@moss/shared` types and calls `fetch` the way the rest of `index.tsx` does, since module settings entries do not import from `apps/web`)
- Test: `packages/email/src/settings/index.test.tsx` (create or extend)

Run the `design-system` skill first; use `Group`, `Row`, `Switch`, `Note` from `@moss/settings-ui` exactly like the existing rows.

New group "What you owe people", after "Briefing signal":

- Row "Judge with context", desc "When deciding whether an email means you owe someone something, Moss also reads your notes, tasks and calendar for that person. Turn off to judge from the email alone." Switch bound to `settings?.judgeWithContext ?? true`, mutation `settingsMutation.mutate({ judgeWithContext: value })`.
- Row list "Senders you have ruled not owed": one `Row` per rule, `name` = display name or address, `desc` = `ruledBy === "auto" ? "Learned from 2 dismissals" : "Set by you"`, control = Switch bound to `ruledNotObligation`, `onChange` → `putSenderRule({ senderAddress, ruledNotObligation: value })` then invalidate `["commitments", "sender-rules"]`. When empty, a `Note`: "Nothing here yet. Dismissing an item with 'Not something I owe' twice from the same sender adds them."

- [ ] Failing tests: switch reflects `judgeWithContext` and patches it; rule rows render name and learned/set text; toggling a rule calls PUT with the address; empty state note shows. Run; implement; run; design-system audit; commit `feat(email): settings for context judgement and not-owed senders`.

### Task 7: App map and manifest metadata, release note

**Files:**

- Modify: `packages/email/src/manifest.ts` settings entry description: append "and how Moss decides what you owe people"; `features` entries `email.judge_with_context` and `email.not_owed_senders` (plain descriptions of the switch and the two-dismissal rule and where to undo it).
- Modify: `packages/commitments/src/manifest.ts` `features`: `commitments.moss_knows_owed` ("Ask Moss 'what do I owe people?' and it lists the same items as the Today card, with why and the proposed actions.").
- Run `pnpm -s build:app-map` and the truthfulness check.
- PR template release note for the whole feature (one PR carries all three slices): Category Added; Title "Moss tells you what you owe people from your email"; Description "Today now shows the email threads where someone is waiting on you, with a suggested reply, task, snooze or dismiss. Moss can answer 'what do I owe people?' in chat, and learns which senders you never owe."
- Commit `docs(app-map): declare the owed-people features and settings`.

### Task 8: Live proof on dev (slice 3 deliverable)

- [ ] Reconcile modules (migration 0218), restart API and web.
- [ ] In chat, ask Moss "what do I owe people?" and confirm the answer names the same items as the Today card, with why lines. Cropped screenshot.
- [ ] Dismiss two items from one sender with "Not something I owe"; confirm the sender appears under Email settings with "Learned from 2 dismissals", that any other open item from them left the card, and that a fresh re-judge of a thread from them returns no item. Toggle the rule off in settings and confirm the row says "Set by you".
- [ ] Turn "Judge with context" off, re-judge one thread, and confirm the prompt log line (bounded warn from slice 1) shows no people/notes/tasks/calendar sections; turn it back on.
- [ ] Post results on the PR as "Slice 3 live proof". Then revert the TEMP 30d→10d edit in `google-sync-phases.ts` if the email-triage lane has not already, and delete nothing else.
