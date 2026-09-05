# Email as Chief of Staff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn flagged email threads into one actionable "you owe this person" item each, judged with the user's People, notes, tasks and calendar context, shown on Today with four actions, and closed automatically when the user acts.

**Architecture:** Two model passes. A cheap gate in the connectors extraction (`email-extract.ts`) sorts every synced message into nothing / worth knowing / maybe owed. "Maybe owed" threads are queued (pg-boss, metadata only) to a new worker in the Commitments module, which gathers context through injected provider interfaces (no cross-module imports or table reads) and writes one Commitments candidate per thread. The Today card and Moss's tools read Commitments' REST routes and assistant tools.

**Tech Stack:** TypeScript monorepo (pnpm), Fastify REST, pg-boss jobs, Postgres with RLS, `@moss/ai` `generateStructured` with tier hints, React web app with `jds-*` design-system primitives, vitest.

**Spec:** `docs/superpowers/specs/2026-09-04-email-chief-of-staff-design.md` (read it first; the mockups are in `docs/superpowers/specs/assets/2026-09-04-email-chief-of-staff/`).

**Plan files:** this file is slice 1 plus the shared header. Slice 2 is `2026-09-04-email-chief-of-staff-slice-2-today-card.md`, slice 3 is `2026-09-04-email-chief-of-staff-slice-3-moss-learning-settings.md`. All three slices share one branch and one PR (Ben's ruling 2026-08-25).

## Global Constraints

- Never name a provider or model. The gate asks `generateStructured` with `tierHint: "economy"`; the judgement asks with `tierHint: "reasoning"` (`AiModelTier` in `packages/module-sdk/src/ai-capabilities.ts`).
- pg-boss payloads carry only `actorUserId`, an opaque thread reference and an idempotency key. Run `assertMetadataOnlyPayload` on every payload.
- No module imports another module's internals or reads its tables. Cross-module needs are typed provider interfaces declared in `packages/module-sdk/src/index.ts` and injected in `packages/module-registry/src/index.ts`.
- Never edit an applied migration. New SQL files go in the owning module's `sql/` folder; the next free number at planning time was `0215` (check `ls packages/*/sql | sort` before creating).
- Every new table and column is owner-only under RLS; copy the policy shape from `packages/commitments/sql/0125_commitment_candidates.sql`.
- Email bodies, recipient lists and note content never land in the candidate, the queue, or logs. The only text stored from mail is the capped "why" lines (one sentence per quote, max three lines).
- No new required environment variable or hand-edited settings file (Ben's ruling 2026-09-01).
- App map: every new screen, setting and behaviour is declared in the same PR (`packages/shared/src/app-map-core.ts` for Today; module manifests for the rest).
- UI uses `jds-*` primitives and `tokens.css`; run the `design-system` skill before any UI work.
- Unit tests live in `tests/unit/`. Run them with `pnpm vitest run tests/unit/<file>.test.ts`. Anything that touches a database goes through the `verify-gate` skill only.
- Chat and status text to Ben is plain English; commit messages and code comments stay technical.
- Commit each task with a path-scoped `git add`, never `-A`; follow the `shared-checkout` skill before any commit in `~/Jarv1s`.

## File Structure (all slices)

Connectors (first pass):

- Modify `packages/connectors/src/email-extract.ts`: add the gate outcome to the result, the gate prompt and its sanitiser, the known-sender option.
- Modify `packages/connectors/src/extract-deps.ts`: schema gains `gate` and `deliversSignInCode` stays; nothing else.
- Modify `packages/connectors/src/google-sync-phases.ts` and `packages/connectors/src/imap-sync-jobs.ts`: after persisting a `maybe_owed` result, ask the injected requester for a thread judgement.

Email module:

- Create `packages/email/sql/0215_email_thread_lookup.sql`: index on `external_metadata->>'threadId'`.
- Modify `packages/email/src/repository.ts`: `listByThread`, `listOpenThreadsNewerThan` helpers.
- Create `packages/email/src/thread-provider.ts`: implements the module-sdk `EmailThreadProvider` over the repository.

Module SDK (shared contracts):

- Modify `packages/module-sdk/src/index.ts`: `EmailThreadJudgementRequester`, `EmailThreadProvider`, `EmailThreadMessage`, `CommitmentContextProviders`, `ProposedCommitmentAction`, `EmailJudgementOutcome`.

Commitments module (second pass, store, actions):

- Create `packages/commitments/sql/0216_commitment_email_items.sql`: new candidate columns, thread-judgement table, RLS.
- Modify `packages/commitments/src/manifest.ts`: new queue, routes, tool changes, settings.
- Modify `packages/commitments/src/jobs.ts`: `enqueueEmailThreadJudgement`.
- Create `packages/commitments/src/email-judgement.ts`: prompt builder, schema, parser, context capping (pure functions).
- Create `packages/commitments/src/email-judgement-worker.ts`: the worker.
- Modify `packages/commitments/src/repository.ts` and `types.ts`: email-item fields and methods.
- Create `packages/commitments/src/email-actions.ts` (slice 2): the four actions' server side.
- Create `packages/commitments/src/email-close.ts` (slice 2): the three closing triggers.
- Create `packages/commitments/src/sender-rules.ts` (slice 3): dismiss learning.

Web (slice 2 and 3):

- Create `apps/web/src/today/owed-card.tsx`, `owed-row.tsx`, `owed-reply-sheet.tsx`, `owed-dismiss-sheet.tsx`, `owed-snooze-menu.tsx`, `use-owed-items.ts`.
- Modify `apps/web/src/today/` page composition to mount the card.
- Modify the People entry screen (slice 3) for the per-sender toggle.

Composition root:

- Modify `packages/module-registry/src/index.ts`: build the requester and providers, register the worker.

Tests: `tests/unit/email-gate.test.ts`, `tests/unit/email-gate-known-sender.test.ts`, `tests/unit/commitment-email-judgement-prompt.test.ts`, `tests/unit/commitment-email-judgement-worker.test.ts`, `tests/unit/commitment-email-jobs.test.ts`, `tests/unit/google-sync-thread-judgement-request.test.ts`, and per-slice files listed in the other plan files.

---

# Slice 1: the judgement pipeline

Deliverable: on dev, a real "maybe owed" thread produces one Commitments candidate with a title, who is waiting, an owed-by date, proposed actions and "why" lines; ordinary mail produces no summary or verdict. No UI.

### Task 1: Gate outcome type, prompt and sanitiser in the extraction

**Files:**

- Modify: `packages/connectors/src/email-extract.ts` (types near line 168-253, prompt builder, `sanitizeExtractResult` near line 644)
- Modify: `packages/connectors/src/extract-deps.ts` (`EMAIL_SIGNALS_SCHEMA`)
- Test: `tests/unit/email-gate.test.ts`

**Interfaces:**

- Produces: `export type EmailGateOutcome = "nothing" | "worth_knowing" | "maybe_owed";` and `EmailExtractResult.gate?: EmailGateOutcome`. When `gate === "maybe_owed"` the result has `summary: null`, `signals.actionability` unset and `signals.pendingJudgement: true`. When `gate === "nothing"` the result has `summary: null` and `signals.actionability.category === "noise"`. When `gate === "worth_knowing"` the summary is kept and `category === "fyi"`.
- Consumes: existing `ParsedEmail`, `EmailExtractDeps.runChat`, `looksLikeBulkMail`, `looksLikeOneTimeCodeEmail`, `otpSkippedResult`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/email-gate.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  extractEmailSignals,
  type EmailExtractDeps,
  type ParsedEmail
} from "../../packages/connectors/src/email-extract.js";

function parsed(over: Partial<ParsedEmail>): ParsedEmail {
  return {
    externalId: "m1",
    threadId: "t1",
    historyId: "1",
    subject: "Hello",
    from: "a@example.com",
    recipients: ["ben@ben.com"],
    receivedAt: "2026-09-04T10:00:00Z",
    labelIds: [],
    snippet: null,
    body: "body",
    bodyTruncated: false,
    hasListUnsubscribe: false,
    ...over
  };
}
const answer = (obj: unknown): EmailExtractDeps => ({
  runChat: vi.fn(async () => ({ text: JSON.stringify(obj) }))
});

describe("email gate", () => {
  it("nothing: stores no summary and a noise verdict", async () => {
    const r = await extractEmailSignals(
      parsed({ subject: "Weekend sale" }),
      answer({ gate: "nothing", summary: "A sale" })
    );
    expect(r.gate).toBe("nothing");
    expect(r.summary).toBeNull();
    expect(r.signals.actionability?.category).toBe("noise");
    expect(r.signals.pendingJudgement).toBeUndefined();
  });
  it("worth_knowing: keeps the summary, verdict fyi", async () => {
    const r = await extractEmailSignals(
      parsed({ subject: "Your parcel arrived" }),
      answer({ gate: "worth_knowing", summary: "Parcel delivered" })
    );
    expect(r.gate).toBe("worth_knowing");
    expect(r.summary).toBe("Parcel delivered");
    expect(r.signals.actionability?.category).toBe("fyi");
  });
  it("maybe_owed: no summary, no verdict, pending flag", async () => {
    const r = await extractEmailSignals(
      parsed({ subject: "Lease addendum" }),
      answer({ gate: "maybe_owed", summary: "Landlord wants addendum" })
    );
    expect(r.gate).toBe("maybe_owed");
    expect(r.summary).toBeNull();
    expect(r.signals.actionability).toBeUndefined();
    expect(r.signals.pendingJudgement).toBe(true);
  });
  it("prompt carries the three outcomes and the 2271 lists", async () => {
    const deps = answer({ gate: "nothing" });
    await extractEmailSignals(parsed({}), deps);
    const prompt = (deps.runChat as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    for (const s of [
      "nothing",
      "worth_knowing",
      "maybe_owed",
      "unsubscribe",
      "sign-in",
      "terms of service",
      "When you cannot tell, answer maybe_owed"
    ]) {
      expect(prompt).toContain(s);
    }
  });
  it("an unknown gate value is treated as nothing", async () => {
    const r = await extractEmailSignals(parsed({}), answer({ gate: "banana", summary: "x" }));
    expect(r.gate).toBe("nothing");
    expect(r.summary).toBeNull();
  });
  it("otp skip still wins before the model", async () => {
    const deps = answer({ gate: "maybe_owed" });
    const r = await extractEmailSignals(
      parsed({ subject: "Your sign-in code is 123456", body: "123456 is your code" }),
      deps
    );
    expect(r.signals.skipped).toBe("otp");
    expect(deps.runChat).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/unit/email-gate.test.ts`
Expected: FAIL, `gate` is undefined on the result and the prompt lacks the outcome words.

- [ ] **Step 3: Add the type, prompt section and sanitiser**

In `email-extract.ts`, next to `EmailActionabilityCategory`:

```ts
export type EmailGateOutcome = "nothing" | "worth_knowing" | "maybe_owed";
export const EMAIL_GATE_OUTCOMES: readonly EmailGateOutcome[] = [
  "nothing",
  "worth_knowing",
  "maybe_owed"
];
```

Add to `EmailSignals`: `pendingJudgement?: boolean;`. Add to `EmailExtractResult`: `gate?: EmailGateOutcome;`.

In the prompt builder (the function that produces the instructions text passed to `runChat`), add a block before the existing verdict rules:

```ts
const GATE_INSTRUCTIONS = [
  "First decide the gate. Answer exactly one of: nothing, worth_knowing, maybe_owed.",
  "nothing: ordinary mail, bulk or not, that asks nothing of this user: newsletters, sales, receipts, shipping notices, ticket releases, fundraising, petitions, event promos, product updates, social notifications, test alerts, terms of service and policy updates, sign-in and security notices where nothing failed, routine back-and-forth that asks nothing.",
  "worth_knowing: the user would want to glance at it but it asks nothing: a parcel arrived, a payment went through, a friend's news, a calendar notification, an account activity summary.",
  "maybe_owed: a person or institution the user already deals with may be waiting on them, or a date may bind them: a bill or payment problem, an appointment or form, a deadline from an employer, school, landlord, bank, insurer or doctor, a question from someone they know. Urgent wording (act now, action required, final notice) is not evidence by itself. Mail with an unsubscribe link can still be maybe_owed (rent reminders, loan statements).",
  "When you cannot tell, answer maybe_owed; a stronger reader decides later.",
  "Only write a summary when the gate is worth_knowing."
].join("\n");
```

Include `GATE_INSTRUCTIONS` in the prompt, and add `gate` to the JSON the model is told to return. In `extract-deps.ts`, add to `EMAIL_SIGNALS_SCHEMA.properties`: `gate: { type: "string", enum: ["nothing", "worth_knowing", "maybe_owed"] }` and add `"gate"` to `required`.

In `sanitizeExtractResult`, after the existing body-echo guard and bulk flag:

```ts
const gate: EmailGateOutcome = EMAIL_GATE_OUTCOMES.includes(raw.gate as EmailGateOutcome)
  ? (raw.gate as EmailGateOutcome)
  : "nothing";
if (gate === "nothing") {
  return {
    gate,
    summary: null,
    signals: { ...signals, actionability: { category: "noise" }, pendingJudgement: undefined }
  };
}
if (gate === "worth_knowing") {
  return { gate, summary, signals: { ...signals, actionability: { category: "fyi" } } };
}
const { actionability: _drop, ...rest } = signals;
return { gate, summary: null, signals: { ...rest, pendingJudgement: true } };
```

Keep `otpSkippedResult()` unchanged (no `gate`); it returns before the model as today.

- [ ] **Step 4: Run the test and the existing email tests**

Run: `pnpm vitest run tests/unit/email-gate.test.ts tests/unit/email-extract-actionability.test.ts tests/unit/email-extract-bulk-mail.test.ts tests/unit/email-extract-otp-skip.test.ts tests/unit/email-extract-schema-bound.test.ts tests/unit/email-extract-compact-batch.test.ts`
Expected: new file PASS. Existing files that assert a `needs_reply` verdict from a single-pass answer will FAIL: update those fixtures so the fake answer carries `gate: "worth_knowing"` where they assert a kept summary, and move any assertion that a message becomes `needs_reply` into the slice 1 judgement tests (Task 6). The guard tests (body echo, bulk flag, otp) must still pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/connectors/src/email-extract.ts packages/connectors/src/extract-deps.ts tests/unit/email-gate.test.ts tests/unit/email-extract-*.test.ts
git commit -m "feat(email): first-pass gate sorts mail into nothing / worth_knowing / maybe_owed"
```

### Task 2: Known-sender input to the gate

**Files:**

- Modify: `packages/connectors/src/email-extract.ts` (`EmailExtractOptions`, prompt builder)
- Test: `tests/unit/email-gate-known-sender.test.ts`

**Interfaces:**

- Produces: `EmailExtractOptions.knownSender?: boolean` (per single call) and `EmailExtractBatchOptions.knownSenders?: ReadonlySet<string>` (lower-cased addresses, for the batch path). When true, the prompt gains the line `Sender: someone this user already deals with (in their People or previously replied to). Lean toward maybe_owed, but it is not proof.`
- Consumes: Task 1.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import {
  extractEmailSignals,
  extractEmailSignalsBatch,
  type EmailExtractDeps
} from "../../packages/connectors/src/email-extract.js";
// reuse parsed() from email-gate.test.ts by copying it here

describe("known sender line", () => {
  it("is present when knownSender is true and absent otherwise", async () => {
    const deps: EmailExtractDeps = {
      runChat: vi.fn(async () => ({ text: JSON.stringify({ gate: "nothing" }) }))
    };
    await extractEmailSignals(parsed({}), deps, { knownSender: true });
    await extractEmailSignals(parsed({}), deps);
    const calls = (deps.runChat as any).mock.calls.map((c: any[]) => c[0] as string);
    expect(calls[0]).toContain("someone this user already deals with");
    expect(calls[1]).not.toContain("someone this user already deals with");
  });
  it("batch path marks only the matching addresses", async () => {
    const deps: EmailExtractDeps = {
      runChat: vi.fn(async () => ({
        text: JSON.stringify({
          results: [
            { index: 0, value: { gate: "nothing" } },
            { index: 1, value: { gate: "nothing" } }
          ]
        })
      }))
    };
    await extractEmailSignalsBatch(
      [
        parsed({ from: "Sarah <sarah@kim.example>" }),
        parsed({ externalId: "m2", from: "shop@promo.example" })
      ],
      deps,
      { knownSenders: new Set(["sarah@kim.example"]) }
    );
    const prompt = (deps.runChat as any).mock.calls[0][0] as string;
    expect(prompt.indexOf("someone this user already deals with")).toBeGreaterThan(-1);
    expect(prompt.match(/someone this user already deals with/g)?.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/unit/email-gate-known-sender.test.ts`
Expected: FAIL, line absent.

- [ ] **Step 3: Implement**

Add `knownSender?: boolean` to `EmailExtractOptions` and `knownSenders?: ReadonlySet<string>` to the batch options type. Add a helper:

```ts
export function senderAddress(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}
const KNOWN_SENDER_LINE =
  "Sender: someone this user already deals with (in their People or previously replied to). Lean toward maybe_owed, but it is not proof.";
```

In the single-message prompt builder, append `KNOWN_SENDER_LINE` when `options.knownSender`. In the batch prompt builder, append it inside each message's block when `options.knownSenders?.has(senderAddress(message.from))`.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run tests/unit/email-gate-known-sender.test.ts tests/unit/email-gate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/connectors/src/email-extract.ts tests/unit/email-gate-known-sender.test.ts
git commit -m "feat(email): tell the gate when the sender is someone the user already deals with"
```

### Task 3: Shared contracts in module-sdk

**Files:**

- Modify: `packages/module-sdk/src/index.ts` (append after `CommitmentResolutionVerifier`, line ~854)
- Test: `tests/unit/module-sdk-email-judgement-types.test.ts` (type-level compile test)

**Interfaces (Produces, used by every later task):**

```ts
export interface EmailThreadJudgementRequester {
  requestThreadJudgement(actorUserId: string, threadRef: string): Promise<void>;
}

export interface EmailThreadMessage {
  readonly externalId: string;
  readonly cacheMessageId: string; // app.email_messages.id, what email.draftReply / sendReply take
  readonly fromAddress: string;
  readonly fromIsUser: boolean;
  readonly subject: string;
  readonly receivedAt: string;
  readonly bodyExcerpt: string; // capped by the provider to 4_000 chars
}

export interface EmailThreadProvider {
  listThreadMessages(
    scopedDb: unknown,
    actorUserId: string,
    threadRef: string
  ): Promise<readonly EmailThreadMessage[]>;
  /** Threads with an open email candidate that received a message newer than the given message id. Slice 2 uses it. */
  listThreadsWithNewerMessages(
    scopedDb: unknown,
    actorUserId: string,
    threads: readonly { threadRef: string; afterExternalId: string }[]
  ): Promise<readonly { threadRef: string; newest: EmailThreadMessage }[]>;
}

export interface CommitmentPersonContext {
  readonly personId: string | null;
  readonly displayName: string | null;
  readonly relationshipSummary: string | null;
  readonly recentNoteLines: readonly string[];
}
export interface CommitmentOpenTask {
  readonly id: string;
  readonly title: string;
  readonly dueLocalDate: string | null;
}
export interface CommitmentCalendarWindow {
  readonly busy: readonly { start: string; end: string; title: string }[];
  readonly timezone: string;
}

export interface CommitmentContextProviders {
  people?: {
    resolveByEmail(
      scopedDb: unknown,
      actorUserId: string,
      address: string
    ): Promise<CommitmentPersonContext | null>;
  };
  notes?: {
    searchLines(
      scopedDb: unknown,
      actorUserId: string,
      query: string,
      limit: number
    ): Promise<readonly string[]>;
  };
  tasks?: {
    listOpen(
      scopedDb: unknown,
      actorUserId: string,
      limit: number
    ): Promise<readonly CommitmentOpenTask[]>;
  };
  calendar?: {
    windowFromNow(
      scopedDb: unknown,
      actorUserId: string,
      days: number
    ): Promise<CommitmentCalendarWindow | null>;
  };
}

export type ProposedCommitmentAction =
  | { kind: "reply"; facts: readonly string[]; wantsFreeSlots: boolean }
  | { kind: "task"; title: string; dueLocalDate: string | null }
  | { kind: "snooze"; untilLocalDate: string }
  | { kind: "dismiss" };

export interface EmailJudgementOutcome {
  readonly owed: boolean;
  readonly title: string | null;
  readonly counterpartyLabel: string | null;
  readonly counterpartyAddress: string | null;
  readonly dueLocalDate: string | null;
  readonly confidence: "high" | "medium" | "low";
  readonly why: readonly string[]; // max 3, each max 240 chars
  readonly actions: readonly ProposedCommitmentAction[]; // max 4
}
```

- [ ] **Step 1: Write the compile test**

```ts
// tests/unit/module-sdk-email-judgement-types.test.ts
import { describe, expect, it } from "vitest";
import type {
  EmailJudgementOutcome,
  ProposedCommitmentAction,
  EmailThreadJudgementRequester
} from "../../packages/module-sdk/src/index.js";
describe("email judgement contracts", () => {
  it("compile and are shaped as the spec says", () => {
    const action: ProposedCommitmentAction = {
      kind: "task",
      title: "Send addendum",
      dueLocalDate: "2026-09-05"
    };
    const outcome: EmailJudgementOutcome = {
      owed: true,
      title: "Send Sarah the lease addendum",
      counterpartyLabel: "Sarah Kim",
      counterpartyAddress: "sarah@kim.example",
      dueLocalDate: "2026-09-05",
      confidence: "high",
      why: ['"Could you send the signed addendum back by Friday?"'],
      actions: [action, { kind: "dismiss" }]
    };
    const requester: EmailThreadJudgementRequester = { requestThreadJudgement: async () => {} };
    expect(outcome.actions).toHaveLength(2);
    expect(typeof requester.requestThreadJudgement).toBe("function");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm vitest run tests/unit/module-sdk-email-judgement-types.test.ts` — Expected: FAIL, types not exported.
- [ ] **Step 3: Add the interfaces above to `packages/module-sdk/src/index.ts`** exactly as written, with a comment block naming this spec.
- [ ] **Step 4: Run** the test and `pnpm -s typecheck` — Expected: PASS, exit 0.
- [ ] **Step 5: Commit**

```bash
git add packages/module-sdk/src/index.ts tests/unit/module-sdk-email-judgement-types.test.ts
git commit -m "feat(module-sdk): contracts for email thread judgement and context providers"
```

### Task 4: Email module can list a thread

**Files:**

- Create: `packages/email/sql/0215_email_thread_lookup.sql`
- Modify: `packages/email/src/manifest.ts` (`database.migrations`, add the new file)
- Modify: `packages/email/src/repository.ts` (add two methods after `listSyncMarkers`, line ~275)
- Create: `packages/email/src/thread-provider.ts`
- Modify: `packages/email/src/index.ts` (export `createEmailThreadProvider`)
- Test: `tests/unit/email-thread-provider.test.ts` (fakes the repository); DB proof through `verify-gate` only.

**Interfaces:**

- Produces: `EmailRepository.listByThread(scopedDb: DataContextDb, ownerUserId: string, threadId: string): Promise<EmailMessage[]>` (ordered by `received_at` asc, max 50) and `EmailRepository.listNewerInThreads(scopedDb, ownerUserId, pairs: {threadId, afterExternalId}[]): Promise<{threadId: string; message: EmailMessage}[]>`; `createEmailThreadProvider(repo: EmailRepository, userAddressesFor: (scopedDb, ownerUserId) => Promise<ReadonlySet<string>>): EmailThreadProvider`.
- Consumes: Task 3 types; `EmailMessage` row type; `external_metadata->>'threadId'`.

- [ ] **Step 1: Migration**

```sql
-- packages/email/sql/0215_email_thread_lookup.sql
-- Spec 2026-09-04-email-chief-of-staff: the second pass reads a whole thread.
CREATE INDEX IF NOT EXISTS idx_email_messages_owner_thread
  ON app.email_messages (owner_user_id, (external_metadata->>'threadId'), received_at);
```

Add `"sql/0215_email_thread_lookup.sql"` to the manifest's migrations list.

- [ ] **Step 2: Write the failing provider test**

```ts
// tests/unit/email-thread-provider.test.ts
import { describe, expect, it } from "vitest";
import { createEmailThreadProvider } from "../../packages/email/src/thread-provider.js";
const row = (o: Partial<any>) => ({
  id: "x",
  external_id: "m1",
  sender: "Sarah <sarah@kim.example>",
  subject: "Addendum",
  received_at: new Date("2026-09-01T10:00:00Z"),
  body_excerpt: "a".repeat(5000),
  external_metadata: { threadId: "t1" },
  ...o
});
describe("email thread provider", () => {
  it("maps rows, marks the user's own messages, caps the excerpt", async () => {
    const repo = {
      listByThread: async () => [row({}), row({ external_id: "m2", sender: "ben@ben.com" })],
      listNewerInThreads: async () => []
    } as any;
    const p = createEmailThreadProvider(repo, async () => new Set(["ben@ben.com"]));
    const msgs = await p.listThreadMessages({}, "u1", "t1");
    expect(msgs).toHaveLength(2);
    expect(msgs[0].fromAddress).toBe("sarah@kim.example");
    expect(msgs[0].fromIsUser).toBe(false);
    expect(msgs[1].fromIsUser).toBe(true);
    expect(msgs[0].bodyExcerpt.length).toBe(4000);
  });
});
```

- [ ] **Step 3: Run to verify it fails** — `pnpm vitest run tests/unit/email-thread-provider.test.ts` — Expected: FAIL, module missing.
- [ ] **Step 4: Implement**

Repository:

```ts
async listByThread(scopedDb: DataContextDb, ownerUserId: string, threadId: string): Promise<EmailMessage[]> {
  const { rows } = await scopedDb.query<EmailMessageRow>(
    `SELECT * FROM app.email_messages
      WHERE owner_user_id = $1 AND external_metadata->>'threadId' = $2
      ORDER BY received_at ASC LIMIT 50`, [ownerUserId, threadId]);
  return rows.map(mapRow);
}
async listNewerInThreads(scopedDb: DataContextDb, ownerUserId: string, pairs: readonly { threadId: string; afterExternalId: string }[]) {
  const out: { threadId: string; message: EmailMessage }[] = [];
  for (const p of pairs) {
    const { rows } = await scopedDb.query<EmailMessageRow>(
      `SELECT m.* FROM app.email_messages m
        WHERE m.owner_user_id = $1 AND m.external_metadata->>'threadId' = $2
          AND m.received_at > (SELECT received_at FROM app.email_messages WHERE owner_user_id = $1 AND external_id = $3 LIMIT 1)
        ORDER BY received_at DESC LIMIT 1`, [ownerUserId, p.threadId, p.afterExternalId]);
    if (rows[0]) out.push({ threadId: p.threadId, message: mapRow(rows[0]) });
  }
  return out;
}
```

(`mapRow` is whatever the file already uses to turn a row into `EmailMessage`; reuse it.)

`thread-provider.ts`:

```ts
import type { EmailThreadProvider, EmailThreadMessage } from "@moss/module-sdk";
import type { EmailRepository, EmailMessage } from "./repository.js";
const EXCERPT_CAP = 4_000;
export function senderAddress(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}
export function createEmailThreadProvider(
  repo: EmailRepository,
  userAddressesFor: (scopedDb: unknown, ownerUserId: string) => Promise<ReadonlySet<string>>
): EmailThreadProvider {
  const map = (m: EmailMessage, mine: ReadonlySet<string>): EmailThreadMessage => ({
    externalId: m.externalId,
    cacheMessageId: m.id,
    fromAddress: senderAddress(m.sender),
    fromIsUser: mine.has(senderAddress(m.sender)),
    subject: m.subject ?? "",
    receivedAt: m.receivedAt.toISOString(),
    bodyExcerpt: (m.bodyExcerpt ?? "").slice(0, EXCERPT_CAP)
  });
  return {
    async listThreadMessages(scopedDb, actorUserId, threadRef) {
      const mine = await userAddressesFor(scopedDb, actorUserId);
      return (await repo.listByThread(scopedDb as never, actorUserId, threadRef)).map((m) =>
        map(m, mine)
      );
    },
    async listThreadsWithNewerMessages(scopedDb, actorUserId, threads) {
      const mine = await userAddressesFor(scopedDb, actorUserId);
      const rows = await repo.listNewerInThreads(
        scopedDb as never,
        actorUserId,
        threads.map((t) => ({ threadId: t.threadRef, afterExternalId: t.afterExternalId }))
      );
      return rows.map((r) => ({ threadRef: r.threadId, newest: map(r.message, mine) }));
    }
  };
}
```

`userAddressesFor` is supplied by the composition root from the connector accounts table (the connected Gmail address), lower-cased.

- [ ] **Step 5: Run** the test and `pnpm -s typecheck` — Expected: PASS.
- [ ] **Step 6: Commit**

```bash
git add packages/email/sql/0215_email_thread_lookup.sql packages/email/src/manifest.ts packages/email/src/repository.ts packages/email/src/thread-provider.ts packages/email/src/index.ts tests/unit/email-thread-provider.test.ts
git commit -m "feat(email): list a thread and expose it as a provider for the second pass"
```

### Task 5: Commitments store: email item columns and thread-judgement table

**Files:**

- Create: `packages/commitments/sql/0216_commitment_email_items.sql`
- Modify: `packages/commitments/src/manifest.ts` (`database.migrations`, `ownedTables`)
- Modify: `packages/commitments/src/types.ts`, `packages/commitments/src/repository.ts`
- Test: `tests/unit/commitment-email-repository-sql.test.ts` (asserts the compiled SQL and parameters through the recording fake database; real DB proof through `verify-gate`)

**Interfaces:**

- Produces: `UpsertEmailCandidateInput = UpsertCandidateInput & { counterpartyPersonId: string | null; counterpartyAddress: string | null; proposedActions: ProposedCommitmentAction[]; whyLines: string[]; threadRef: string; lastJudgedExternalId: string }`; `CommitmentsRepository.upsertEmailCandidate(scopedDb, input): Promise<CommitmentCandidate>`; `recordThreadJudgement(scopedDb, ownerUserId, threadRef, lastJudgedExternalId, outcome: "no_item" | "item")`; `getThreadJudgement(scopedDb, ownerUserId, threadRef): Promise<{ lastJudgedExternalId: string; outcome: string } | null>`; `listOpenEmailCandidates(scopedDb, ownerUserId): Promise<CommitmentCandidate[]>`. `CommitmentCandidate` gains the optional fields `counterpartyPersonId`, `counterpartyAddress`, `proposedActions`, `whyLines`, `threadRef`, `lastJudgedExternalId`, `stale`.
- Consumes: Task 3 `ProposedCommitmentAction`; existing `buildCandidateSignature`.

- [ ] **Step 1: Migration**

```sql
-- packages/commitments/sql/0216_commitment_email_items.sql
-- Spec 2026-09-04-email-chief-of-staff: one candidate per email thread, with proposed actions.
ALTER TABLE app.commitment_candidates
  ADD COLUMN counterparty_person_id   uuid,
  ADD COLUMN counterparty_address     text CHECK (char_length(counterparty_address) <= 320),
  ADD COLUMN proposed_actions         jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(proposed_actions) = 'array'),
  ADD COLUMN why_lines                text[] NOT NULL DEFAULT '{}' CHECK (cardinality(why_lines) <= 3),
  ADD COLUMN thread_ref               text CHECK (char_length(thread_ref) <= 256),
  ADD COLUMN last_judged_external_id  text CHECK (char_length(last_judged_external_id) <= 256),
  ADD COLUMN stale                    boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS uq_commitment_candidates_owner_thread
  ON app.commitment_candidates (owner_user_id, thread_ref) WHERE thread_ref IS NOT NULL;

CREATE TABLE app.commitment_email_thread_judgements (
  owner_user_id            uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  thread_ref               text NOT NULL CHECK (char_length(thread_ref) <= 256),
  last_judged_external_id  text NOT NULL CHECK (char_length(last_judged_external_id) <= 256),
  outcome                  text NOT NULL CHECK (outcome IN ('no_item', 'item')),
  judged_at                timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, thread_ref)
);
ALTER TABLE app.commitment_email_thread_judgements ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.commitment_email_thread_judgements FORCE ROW LEVEL SECURITY;
CREATE POLICY commitment_email_thread_judgements_owner ON app.commitment_email_thread_judgements
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON app.commitment_email_thread_judgements TO jarvis_app, jarvis_worker;
```

Copy the exact policy function name and role names from `0125_commitment_candidates.sql` if they differ from `app.current_actor_user_id()`, `jarvis_app`, `jarvis_worker`. Add the file to `manifest.database.migrations` and the table to `ownedTables`.

- [ ] **Step 2: Write the failing repository test**

The repository is written with the Kysely query builder, so tests capture the compiled SQL through a recording fake database, not a raw `query` stub. First move `makeRecordingDb()` out of `tests/unit/email-rejudge-owner-scope.test.ts` (lines 27-60) into `tests/unit/helpers/recording-db.ts`, export it, and import it back in that test so it still passes. It returns `{ scoped, queries }` where `scoped` carries the data-context brand and `queries` is the list of `CompiledQuery` objects (`sql`, `parameters`) the code ran. The dummy connection returns no rows, so methods that map a returned row get their row from a second helper: `makeRecordingDb({ rows: [row] })` (add that option: the fake connection's `executeQuery` resolves `{ rows }`).

```ts
// tests/unit/commitment-email-repository-sql.test.ts
import { describe, expect, it } from "vitest";
import { makeRecordingDb } from "./helpers/recording-db.js";
import { CommitmentsRepository } from "../../packages/commitments/src/repository.js";
const row = {
  id: "c1",
  owner_user_id: "u1",
  candidate_signature: "s",
  kind: "obligation",
  title: "T",
  due_local_date: null,
  counterparty_label: "Sarah",
  counterparty_person_id: null,
  counterparty_address: "sarah@kim.example",
  status: "pending_review",
  confidence: "high",
  suggested_handling: null,
  resolution_ref: null,
  suppressed_by: null,
  source_count: 1,
  first_seen_at: new Date(),
  last_seen_at: new Date(),
  snoozed_until: null,
  expires_at: null,
  created_at: new Date(),
  updated_at: new Date(),
  proposed_actions: [{ kind: "dismiss" }],
  why_lines: [],
  thread_ref: "t1",
  last_judged_external_id: "m2",
  stale: false
};
describe("email candidate persistence", () => {
  it("upsertEmailCandidate writes the email columns and conflicts on owner+signature", async () => {
    const { scoped, queries } = makeRecordingDb({ rows: [row] });
    const c = await new CommitmentsRepository().upsertEmailCandidate(scoped, {
      ownerUserId: "u1",
      candidateSignature: "s",
      kind: "obligation",
      title: "T",
      dueLocalDate: null,
      counterpartyLabel: "Sarah",
      counterpartyPersonId: null,
      counterpartyAddress: "sarah@kim.example",
      confidence: "high",
      suggestedHandling: null,
      proposedActions: [{ kind: "dismiss" }],
      whyLines: [],
      threadRef: "t1",
      lastJudgedExternalId: "m2"
    });
    expect(queries[0].sql).toContain("proposed_actions");
    expect(queries[0].sql).toContain('on conflict ("owner_user_id", "candidate_signature")');
    expect(c.threadRef).toBe("t1");
    expect(c.proposedActions).toEqual([{ kind: "dismiss" }]);
  });
  it("recordThreadJudgement upserts on owner+thread", async () => {
    const { scoped, queries } = makeRecordingDb();
    await new CommitmentsRepository().recordThreadJudgement(scoped, "u1", "t1", "m2", "no_item");
    expect(queries[0].sql).toContain('on conflict ("owner_user_id", "thread_ref")');
    expect(queries[0].parameters).toEqual(expect.arrayContaining(["u1", "t1", "m2", "no_item"]));
  });
});
```

- [ ] **Step 3: Run to verify it fails** — `pnpm vitest run tests/unit/commitment-email-repository-sql.test.ts` — Expected: FAIL, methods missing.
- [ ] **Step 4: Implement** in `types.ts` (add the optional fields to `CommitmentCandidate` and the `UpsertEmailCandidateInput` type) and `repository.ts`:

```ts
async upsertEmailCandidate(scopedDb: DataContextDb, input: UpsertEmailCandidateInput): Promise<CommitmentCandidate> {
  const { rows } = await scopedDb.query<CandidateRow>(
    `INSERT INTO app.commitment_candidates
       (owner_user_id, candidate_signature, kind, title, due_local_date, counterparty_label, confidence, suggested_handling,
        counterparty_person_id, counterparty_address, proposed_actions, why_lines, thread_ref, last_judged_external_id, source_count, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::text[],$13,$14,1,now())
     ON CONFLICT (owner_user_id, candidate_signature) DO UPDATE SET
       title = EXCLUDED.title, due_local_date = EXCLUDED.due_local_date, counterparty_label = EXCLUDED.counterparty_label,
       confidence = EXCLUDED.confidence, suggested_handling = EXCLUDED.suggested_handling,
       counterparty_person_id = EXCLUDED.counterparty_person_id, counterparty_address = EXCLUDED.counterparty_address,
       proposed_actions = EXCLUDED.proposed_actions, why_lines = EXCLUDED.why_lines,
       last_judged_external_id = EXCLUDED.last_judged_external_id, stale = false,
       status = CASE WHEN app.commitment_candidates.status IN ('rejected','explicit_non_action') THEN app.commitment_candidates.status ELSE 'pending_review' END,
       source_count = app.commitment_candidates.source_count + 1, last_seen_at = now(), updated_at = now()
     RETURNING *`,
    [input.ownerUserId, input.candidateSignature, input.kind, input.title, input.dueLocalDate, input.counterpartyLabel, input.confidence, input.suggestedHandling,
     input.counterpartyPersonId, input.counterpartyAddress, JSON.stringify(input.proposedActions), input.whyLines, input.threadRef, input.lastJudgedExternalId]);
  return mapCandidate(rows[0]);
}
async recordThreadJudgement(scopedDb: DataContextDb, ownerUserId: string, threadRef: string, lastJudgedExternalId: string, outcome: "no_item" | "item"): Promise<void> {
  await scopedDb.query(
    `INSERT INTO app.commitment_email_thread_judgements (owner_user_id, thread_ref, last_judged_external_id, outcome)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (owner_user_id, thread_ref) DO UPDATE SET last_judged_external_id = EXCLUDED.last_judged_external_id, outcome = EXCLUDED.outcome, judged_at = now()`,
    [ownerUserId, threadRef, lastJudgedExternalId, outcome]);
}
async getThreadJudgement(scopedDb: DataContextDb, ownerUserId: string, threadRef: string) {
  const { rows } = await scopedDb.query<{ last_judged_external_id: string; outcome: string }>(
    `SELECT last_judged_external_id, outcome FROM app.commitment_email_thread_judgements WHERE owner_user_id = $1 AND thread_ref = $2`, [ownerUserId, threadRef]);
  return rows[0] ? { lastJudgedExternalId: rows[0].last_judged_external_id, outcome: rows[0].outcome } : null;
}
async listOpenEmailCandidates(scopedDb: DataContextDb, ownerUserId: string): Promise<CommitmentCandidate[]> {
  const { rows } = await scopedDb.query<CandidateRow>(
    `SELECT * FROM app.commitment_candidates WHERE owner_user_id = $1 AND thread_ref IS NOT NULL
       AND status IN ('pending_review','accepted','snoozed') AND resolution_ref IS NULL ORDER BY due_local_date NULLS LAST, last_seen_at DESC`, [ownerUserId]);
  return rows.map(mapCandidate);
}
```

Extend the existing row-to-candidate mapper with the new columns (`counterpartyPersonId`, `counterpartyAddress`, `proposedActions`, `whyLines`, `threadRef`, `lastJudgedExternalId`, `stale`). The email candidate's signature is `buildCandidateSignature({ kind, counterpartyLabel: null, title: "email-thread", dueLocalDate: null, sourceKind: "email", sourceRef: threadRef })` so re-judgement updates the same row (the thread_ref unique index is a second guard).

- [ ] **Step 5: Run** the test and `pnpm -s typecheck` — Expected: PASS.
- [ ] **Step 6: Commit**

```bash
git add packages/commitments/sql/0216_commitment_email_items.sql packages/commitments/src/manifest.ts packages/commitments/src/types.ts packages/commitments/src/repository.ts tests/unit/commitment-email-repository-sql.test.ts
git commit -m "feat(commitments): email item columns, thread judgement table, repository methods"
```

### Task 6: Judgement prompt, schema and parser (pure functions)

**Files:**

- Create: `packages/commitments/src/email-judgement.ts`
- Test: `tests/unit/commitment-email-judgement-prompt.test.ts`

**Interfaces:**

- Produces:
  - `EMAIL_JUDGEMENT_SERVICE: ModuleServiceKey = "module.commitments.email-judgement"`
  - `EMAIL_JUDGEMENT_SCHEMA` (JSON schema for `EmailJudgementOutcome`)
  - `buildEmailJudgementPrompt(input: { today: string; timezone: string; messages: readonly EmailThreadMessage[]; person: CommitmentPersonContext | null; noteLines: readonly string[]; openTasks: readonly CommitmentOpenTask[]; calendar: CommitmentCalendarWindow | null; missing: readonly ("people"|"notes"|"tasks"|"calendar")[]; senderRuledNotObligation: boolean }): string`
  - `parseEmailJudgement(raw: unknown): EmailJudgementOutcome | null` (null on malformed; caps why to 3 lines of 240 chars and one sentence per quote; caps actions to 4; drops unknown action kinds; rejects a due date that is not `YYYY-MM-DD`)
  - `capQuoteToOneSentence(s: string): string`
- Consumes: Task 3 types.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/commitment-email-judgement-prompt.test.ts
import { describe, expect, it } from "vitest";
import {
  buildEmailJudgementPrompt,
  parseEmailJudgement,
  capQuoteToOneSentence,
  EMAIL_JUDGEMENT_SERVICE
} from "../../packages/commitments/src/email-judgement.js";
const msg = (o: any = {}) => ({
  externalId: "m1",
  cacheMessageId: "00000000-0000-0000-0000-000000000001",
  fromAddress: "sarah@kim.example",
  fromIsUser: false,
  subject: "Addendum",
  receivedAt: "2026-09-01T10:00:00Z",
  bodyExcerpt: "Could you send the signed addendum back by Friday? Thanks!",
  ...o
});
const base = {
  today: "2026-09-04",
  timezone: "America/Los_Angeles",
  messages: [msg()],
  person: null,
  noteLines: [],
  openTasks: [],
  calendar: null,
  missing: [] as const,
  senderRuledNotObligation: false
};

describe("judgement prompt", () => {
  it("names the service key", () =>
    expect(EMAIL_JUDGEMENT_SERVICE).toBe("module.commitments.email-judgement"));
  it("carries the one question, the due-date rule, and the thread", () => {
    const p = buildEmailJudgementPrompt(base);
    expect(p).toContain("does this thread create something the user owes");
    expect(p).toContain("when the user's reply or step is owed, never the event date");
    expect(p).toContain("sarah@kim.example");
    expect(p).toContain("Today: 2026-09-04");
  });
  it("says what context it could not see", () => {
    expect(buildEmailJudgementPrompt({ ...base, missing: ["calendar"] })).toContain(
      "Calendar: unavailable"
    );
  });
  it("includes person, notes, tasks and busy slots when present", () => {
    const p = buildEmailJudgementPrompt({
      ...base,
      person: {
        personId: "p1",
        displayName: "Sarah Kim",
        relationshipSummary: "landlord",
        recentNoteLines: ["Told her Tue I'd send it this week"]
      },
      noteLines: ["Signed copy scanned Aug 30"],
      openTasks: [{ id: "t1", title: "Renew lease", dueLocalDate: "2026-09-15" }],
      calendar: {
        timezone: "America/Los_Angeles",
        busy: [{ start: "2026-09-09T16:00:00Z", end: "2026-09-09T17:00:00Z", title: "Standup" }]
      }
    });
    for (const s of [
      "Sarah Kim",
      "landlord",
      "send it this week",
      "Signed copy",
      "Renew lease",
      "Standup"
    ])
      expect(p).toContain(s);
  });
  it("tells the model when the user ruled this sender not an obligation", () => {
    expect(buildEmailJudgementPrompt({ ...base, senderRuledNotObligation: true })).toContain(
      "ruled that mail from this sender is not something they owe"
    );
  });
});

describe("parseEmailJudgement", () => {
  it("returns null on garbage", () => {
    expect(parseEmailJudgement("nope")).toBeNull();
    expect(parseEmailJudgement({ owed: "yes" })).toBeNull();
  });
  it("accepts a well-formed owed answer and caps why and actions", () => {
    const r = parseEmailJudgement({
      owed: true,
      title: "Send Sarah the lease addendum",
      counterpartyLabel: "Sarah Kim",
      counterpartyAddress: "sarah@kim.example",
      dueLocalDate: "2026-09-05",
      confidence: "high",
      why: [
        '"Could you send the signed addendum back by Friday? Thanks so much for this, I appreciate it."',
        "b",
        "c",
        "d"
      ],
      actions: [
        { kind: "reply", facts: ["x"], wantsFreeSlots: false },
        { kind: "task", title: "T", dueLocalDate: "2026-09-05" },
        { kind: "snooze", untilLocalDate: "2026-09-06" },
        { kind: "dismiss" },
        { kind: "teleport" }
      ]
    });
    expect(r?.why).toHaveLength(3);
    expect(r?.why[0]).toBe('"Could you send the signed addendum back by Friday?"');
    expect(r?.actions).toHaveLength(4);
    expect(r?.actions.map((a) => a.kind)).toEqual(["reply", "task", "snooze", "dismiss"]);
  });
  it("rejects a bad due date", () => {
    expect(
      parseEmailJudgement({
        owed: true,
        title: "T",
        counterpartyLabel: null,
        counterpartyAddress: null,
        dueLocalDate: "Friday",
        confidence: "low",
        why: [],
        actions: []
      })
    ).toBeNull();
  });
  it("not owed needs nothing else", () => {
    expect(parseEmailJudgement({ owed: false })).toEqual({
      owed: false,
      title: null,
      counterpartyLabel: null,
      counterpartyAddress: null,
      dueLocalDate: null,
      confidence: "low",
      why: [],
      actions: []
    });
  });
});

describe("capQuoteToOneSentence", () => {
  it("keeps the first sentence inside the quotes", () =>
    expect(capQuoteToOneSentence('"One. Two."')).toBe('"One."'));
  it("caps at 240 chars", () =>
    expect(capQuoteToOneSentence("x".repeat(300)).length).toBeLessThanOrEqual(240));
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm vitest run tests/unit/commitment-email-judgement-prompt.test.ts` — Expected: FAIL, module missing.
- [ ] **Step 3: Implement `email-judgement.ts`**

```ts
import type { ModuleServiceKey } from "@moss/shared";
import type {
  EmailThreadMessage,
  CommitmentPersonContext,
  CommitmentOpenTask,
  CommitmentCalendarWindow,
  EmailJudgementOutcome,
  ProposedCommitmentAction
} from "@moss/module-sdk";

export const EMAIL_JUDGEMENT_SERVICE: ModuleServiceKey = "module.commitments.email-judgement";
export const WHY_MAX_LINES = 3,
  WHY_MAX_CHARS = 240,
  ACTIONS_MAX = 4,
  MESSAGES_MAX = 12;

export const EMAIL_JUDGEMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "owed",
    "title",
    "counterpartyLabel",
    "counterpartyAddress",
    "dueLocalDate",
    "confidence",
    "why",
    "actions"
  ],
  properties: {
    owed: { type: "boolean" },
    title: { type: ["string", "null"] },
    counterpartyLabel: { type: ["string", "null"] },
    counterpartyAddress: { type: ["string", "null"] },
    dueLocalDate: { type: ["string", "null"] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    why: { type: "array", items: { type: "string" } },
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string" },
          facts: { type: "array", items: { type: "string" } },
          wantsFreeSlots: { type: "boolean" },
          title: { type: "string" },
          dueLocalDate: { type: ["string", "null"] },
          untilLocalDate: { type: "string" }
        },
        required: ["kind"]
      }
    }
  }
} as const;

export interface EmailJudgementPromptInput {
  today: string;
  timezone: string;
  messages: readonly EmailThreadMessage[];
  person: CommitmentPersonContext | null;
  noteLines: readonly string[];
  openTasks: readonly CommitmentOpenTask[];
  calendar: CommitmentCalendarWindow | null;
  missing: readonly ("people" | "notes" | "tasks" | "calendar")[];
  senderRuledNotObligation: boolean;
}

export function buildEmailJudgementPrompt(i: EmailJudgementPromptInput): string {
  const lines: string[] = [];
  lines.push(
    "You are the user's chief of staff. Read this email thread with what you know about the user, and answer one question: does this thread create something the user owes?"
  );
  lines.push(
    "Owed means a person or institution the user deals with is waiting on them, or a date binds them. Urgent wording is not evidence. Promotions, notices, newsletters and routine back-and-forth that ask nothing are not owed."
  );
  lines.push(
    "If owed: give a short title in the form 'Do X for Y', who is waiting, the due date as when the user's reply or step is owed, never the event date, a confidence, up to three why lines (quote at most one sentence from the email; otherwise say which fact you leaned on), and up to four proposed actions from: reply (with facts to use and whether free slots help), task (title, dueLocalDate), snooze (untilLocalDate), dismiss."
  );
  lines.push(
    "Dates are YYYY-MM-DD in the user's timezone. If not owed, answer owed:false and nothing else."
  );
  lines.push(`Today: ${i.today} (${i.timezone})`);
  if (i.senderRuledNotObligation)
    lines.push(
      "The user has ruled that mail from this sender is not something they owe. Only answer owed:true if this thread is clearly different."
    );
  lines.push("", "## Thread (oldest first)");
  for (const m of i.messages.slice(-MESSAGES_MAX))
    lines.push(
      `- ${m.receivedAt} from ${m.fromIsUser ? "the user" : m.fromAddress}: ${m.subject}\n  ${m.bodyExcerpt}`
    );
  lines.push("", "## Who this is");
  if (i.missing.includes("people")) lines.push("People: unavailable");
  else if (i.person) {
    lines.push(
      `Person: ${i.person.displayName ?? "(unnamed)"}${i.person.relationshipSummary ? `, ${i.person.relationshipSummary}` : ""}`
    );
    for (const l of i.person.recentNoteLines) lines.push(`- ${l}`);
  } else lines.push("Person: not in the user's People.");
  lines.push("", "## Notes that mention them");
  if (i.missing.includes("notes")) lines.push("Notes: unavailable");
  else if (i.noteLines.length === 0) lines.push("None.");
  else for (const l of i.noteLines) lines.push(`- ${l}`);
  lines.push("", "## Open tasks that may relate");
  if (i.missing.includes("tasks")) lines.push("Tasks: unavailable");
  else if (i.openTasks.length === 0) lines.push("None.");
  else
    for (const t of i.openTasks)
      lines.push(`- ${t.title}${t.dueLocalDate ? ` (due ${t.dueLocalDate})` : ""}`);
  lines.push("", "## Calendar, next 14 days (busy)");
  if (i.missing.includes("calendar")) lines.push("Calendar: unavailable");
  else if (!i.calendar) lines.push("Not needed for this thread.");
  else if (i.calendar.busy.length === 0) lines.push("Nothing booked.");
  else for (const b of i.calendar.busy) lines.push(`- ${b.start} to ${b.end}: ${b.title}`);
  return lines.join("\n");
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export function capQuoteToOneSentence(s: string): string {
  const t = s.trim().slice(0, WHY_MAX_CHARS);
  const quoted = t.startsWith('"');
  const inner = quoted ? t.slice(1).replace(/"$/, "") : t;
  const m = inner.match(/^[^.!?]*[.!?]/);
  const one = m ? m[0] : inner;
  return (quoted ? `"${one}"` : one).slice(0, WHY_MAX_CHARS);
}
function parseAction(a: any): ProposedCommitmentAction | null {
  if (!a || typeof a !== "object") return null;
  switch (a.kind) {
    case "reply":
      return {
        kind: "reply",
        facts: Array.isArray(a.facts)
          ? a.facts.filter((f: unknown) => typeof f === "string").slice(0, 6)
          : [],
        wantsFreeSlots: a.wantsFreeSlots === true
      };
    case "task":
      return typeof a.title === "string"
        ? {
            kind: "task",
            title: a.title.slice(0, 200),
            dueLocalDate:
              typeof a.dueLocalDate === "string" && DATE.test(a.dueLocalDate)
                ? a.dueLocalDate
                : null
          }
        : null;
    case "snooze":
      return typeof a.untilLocalDate === "string" && DATE.test(a.untilLocalDate)
        ? { kind: "snooze", untilLocalDate: a.untilLocalDate }
        : null;
    case "dismiss":
      return { kind: "dismiss" };
    default:
      return null;
  }
}
export function parseEmailJudgement(raw: unknown): EmailJudgementOutcome | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.owed !== "boolean") return null;
  if (!r.owed)
    return {
      owed: false,
      title: null,
      counterpartyLabel: null,
      counterpartyAddress: null,
      dueLocalDate: null,
      confidence: "low",
      why: [],
      actions: []
    };
  if (typeof r.title !== "string" || r.title.trim() === "") return null;
  if (r.dueLocalDate != null && !(typeof r.dueLocalDate === "string" && DATE.test(r.dueLocalDate)))
    return null;
  const confidence =
    r.confidence === "high" || r.confidence === "medium" || r.confidence === "low"
      ? r.confidence
      : "low";
  const why = (Array.isArray(r.why) ? r.why : [])
    .filter((w): w is string => typeof w === "string")
    .slice(0, WHY_MAX_LINES)
    .map(capQuoteToOneSentence);
  const seen = new Set<string>();
  const actions = (Array.isArray(r.actions) ? r.actions : [])
    .map(parseAction)
    .filter(
      (a): a is ProposedCommitmentAction => a !== null && !seen.has(a.kind) && !!seen.add(a.kind)
    )
    .slice(0, ACTIONS_MAX);
  return {
    owed: true,
    title: r.title.trim().slice(0, 200),
    counterpartyLabel:
      typeof r.counterpartyLabel === "string" ? r.counterpartyLabel.slice(0, 200) : null,
    counterpartyAddress:
      typeof r.counterpartyAddress === "string"
        ? r.counterpartyAddress.toLowerCase().slice(0, 320)
        : null,
    dueLocalDate: (r.dueLocalDate as string | null) ?? null,
    confidence,
    why,
    actions
  };
}
```

- [ ] **Step 4: Run** — `pnpm vitest run tests/unit/commitment-email-judgement-prompt.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/commitments/src/email-judgement.ts tests/unit/commitment-email-judgement-prompt.test.ts
git commit -m "feat(commitments): email judgement prompt, schema and parser"
```

### Task 7: Queue and enqueue with debounce

**Files:**

- Modify: `packages/commitments/src/manifest.ts` (constant, `jobs`)
- Modify: `packages/commitments/src/jobs.ts`
- Test: `tests/unit/commitment-email-jobs.test.ts`

**Interfaces:**

- Produces: `COMMITMENT_EMAIL_JUDGEMENT_QUEUE = "commitment-email-judgement"`; `EmailThreadJudgementJobPayload = { actorUserId: string; threadRef: string; idempotencyKey: string }`; `enqueueEmailThreadJudgement(boss: PgBoss, actorUserId: string, threadRef: string): Promise<void>` using `sendJob(boss, queue, payload, { singletonKey: idempotencyKey, startAfter: EMAIL_JUDGEMENT_DEBOUNCE_SECONDS })` with `EMAIL_JUDGEMENT_DEBOUNCE_SECONDS = 180`; `idempotencyKey = \`email-thread:${actorUserId}:${sha8(threadRef)}\``(reuse`sha8`from`signature.ts`, export it if not already).
- Consumes: existing `sendJob`, `assertMetadataOnlyPayload`.

- [ ] **Step 1: Failing test**

```ts
// tests/unit/commitment-email-jobs.test.ts
import { describe, expect, it, vi } from "vitest";
vi.mock("../../packages/jobs/src/index.js", async (orig) => ({
  ...(await orig<any>()),
  sendJob: vi.fn(async () => "job1")
}));
import { sendJob } from "../../packages/jobs/src/index.js";
import {
  enqueueEmailThreadJudgement,
  EMAIL_JUDGEMENT_DEBOUNCE_SECONDS
} from "../../packages/commitments/src/jobs.js";
import { COMMITMENT_EMAIL_JUDGEMENT_QUEUE } from "../../packages/commitments/src/manifest.js";
describe("enqueueEmailThreadJudgement", () => {
  it("sends a metadata-only payload keyed by owner and thread, debounced", async () => {
    await enqueueEmailThreadJudgement({} as never, "u1", "thread-abc");
    const [, queue, payload, opts] = (sendJob as any).mock.calls[0];
    expect(queue).toBe(COMMITMENT_EMAIL_JUDGEMENT_QUEUE);
    expect(Object.keys(payload).sort()).toEqual(["actorUserId", "idempotencyKey", "threadRef"]);
    expect(payload.idempotencyKey).toMatch(/^email-thread:u1:[0-9a-f]{8}$/);
    expect(opts.singletonKey).toBe(payload.idempotencyKey);
    expect(opts.startAfter).toBe(EMAIL_JUDGEMENT_DEBOUNCE_SECONDS);
  });
});
```

Adjust the mock path to wherever `jobs.ts` imports `sendJob` from (read the import line).

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL, export missing.
- [ ] **Step 3: Implement** in `manifest.ts`: `export const COMMITMENT_EMAIL_JUDGEMENT_QUEUE = "commitment-email-judgement";` and add `{ queueName: COMMITMENT_EMAIL_JUDGEMENT_QUEUE, metadataOnly: true }` to `jobs`. In `jobs.ts`:

```ts
export const EMAIL_JUDGEMENT_DEBOUNCE_SECONDS = 180;
export interface EmailThreadJudgementJobPayload {
  readonly actorUserId: string;
  readonly threadRef: string;
  readonly idempotencyKey: string;
}
export async function enqueueEmailThreadJudgement(
  boss: PgBoss,
  actorUserId: string,
  threadRef: string
): Promise<void> {
  const payload: EmailThreadJudgementJobPayload = {
    actorUserId,
    threadRef,
    idempotencyKey: `email-thread:${actorUserId}:${sha8(threadRef)}`
  };
  assertMetadataOnlyPayload(payload);
  await sendJob(boss, COMMITMENT_EMAIL_JUDGEMENT_QUEUE, payload, {
    singletonKey: payload.idempotencyKey,
    startAfter: EMAIL_JUDGEMENT_DEBOUNCE_SECONDS
  });
}
```

- [ ] **Step 4: Run** the test and `pnpm -s typecheck` — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/commitments/src/manifest.ts packages/commitments/src/jobs.ts tests/unit/commitment-email-jobs.test.ts
git commit -m "feat(commitments): per-thread email judgement queue with a 3-minute debounce"
```

### Task 8: The judgement worker

**Files:**

- Create: `packages/commitments/src/email-judgement-worker.ts`
- Modify: `packages/commitments/src/index.ts` (export)
- Test: `tests/unit/commitment-email-judgement-worker.test.ts`

**Interfaces:**

- Produces: `registerEmailThreadJudgementWorker(boss: PgBoss, dataContext: DataContextRunner, deps: EmailJudgementWorkerDeps): Promise<string>` and the pure core `judgeEmailThread(scopedDb, payload, deps): Promise<"no_item" | "item" | "skipped">` where

```ts
export interface EmailJudgementWorkerDeps {
  readonly repository: CommitmentsRepository;
  readonly threads: EmailThreadProvider;
  readonly context: CommitmentContextProviders;
  readonly generate: (scopedDb: unknown, actorUserId: string, prompt: string) => Promise<unknown>; // returns the parsed JSON object; throws on model failure
  readonly senderRuledNotObligation?: (
    scopedDb: unknown,
    actorUserId: string,
    address: string
  ) => Promise<boolean>; // slice 3 supplies; default false
  readonly contextEnabled?: (scopedDb: unknown, actorUserId: string) => Promise<boolean>; // slice 3 setting; default true
  readonly now?: () => Date;
  readonly timezoneFor?: (scopedDb: unknown, actorUserId: string) => Promise<string>;
  readonly logger?: CommitmentExtractionWarnLogger;
}
```

- Consumes: Tasks 3 to 7.

- [ ] **Step 1: Failing tests**

```ts
// tests/unit/commitment-email-judgement-worker.test.ts
import { describe, expect, it, vi } from "vitest";
import { judgeEmailThread } from "../../packages/commitments/src/email-judgement-worker.js";
const msg = (o: any = {}) => ({
  externalId: "m1",
  cacheMessageId: "00000000-0000-0000-0000-000000000001",
  fromAddress: "sarah@kim.example",
  fromIsUser: false,
  subject: "Addendum",
  receivedAt: "2026-09-01T10:00:00Z",
  bodyExcerpt: "Could you send it back by Friday?",
  ...o
});
function deps(over: any = {}) {
  return {
    repository: {
      getThreadJudgement: vi.fn(async () => null),
      upsertEmailCandidate: vi.fn(async (_db: any, i: any) => ({ id: "c1", ...i })),
      recordThreadJudgement: vi.fn(async () => {})
    },
    threads: {
      listThreadMessages: vi.fn(async () => [msg()]),
      listThreadsWithNewerMessages: vi.fn(async () => [])
    },
    context: {
      people: {
        resolveByEmail: vi.fn(async () => ({
          personId: "p1",
          displayName: "Sarah Kim",
          relationshipSummary: "landlord",
          recentNoteLines: []
        }))
      },
      notes: { searchLines: vi.fn(async () => ["Signed copy Aug 30"]) },
      tasks: { listOpen: vi.fn(async () => []) },
      calendar: { windowFromNow: vi.fn(async () => ({ timezone: "UTC", busy: [] })) }
    },
    generate: vi.fn(async () => ({
      owed: true,
      title: "Send Sarah the lease addendum",
      counterpartyLabel: "Sarah Kim",
      counterpartyAddress: "sarah@kim.example",
      dueLocalDate: "2026-09-05",
      confidence: "high",
      why: ['"Could you send it back by Friday?"'],
      actions: [
        { kind: "reply", facts: [], wantsFreeSlots: false },
        { kind: "task", title: "Send addendum", dueLocalDate: "2026-09-05" },
        { kind: "dismiss" }
      ]
    })),
    now: () => new Date("2026-09-04T12:00:00Z"),
    timezoneFor: async () => "UTC",
    ...over
  } as any;
}
const payload = { actorUserId: "u1", threadRef: "t1", idempotencyKey: "k" };

describe("judgeEmailThread", () => {
  it("writes one candidate with person link, actions and why", async () => {
    const d = deps();
    expect(await judgeEmailThread({}, payload, d)).toBe("item");
    const input = d.repository.upsertEmailCandidate.mock.calls[0][1];
    expect(input.threadRef).toBe("t1");
    expect(input.lastJudgedExternalId).toBe("m1");
    expect(input.counterpartyPersonId).toBe("p1");
    expect(input.proposedActions.map((a: any) => a.kind)).toEqual(["reply", "task", "dismiss"]);
    expect(input.whyLines).toHaveLength(1);
    expect(input.suggestedHandling).toBe("create_task");
    expect(d.repository.recordThreadJudgement).toHaveBeenCalledWith({}, "u1", "t1", "m1", "item");
  });
  it("records no_item and writes no candidate when not owed", async () => {
    const d = deps({ generate: vi.fn(async () => ({ owed: false })) });
    expect(await judgeEmailThread({}, payload, d)).toBe("no_item");
    expect(d.repository.upsertEmailCandidate).not.toHaveBeenCalled();
    expect(d.repository.recordThreadJudgement).toHaveBeenCalledWith(
      {},
      "u1",
      "t1",
      "m1",
      "no_item"
    );
  });
  it("skips when the thread was already judged at its newest message", async () => {
    const d = deps({
      repository: {
        ...deps().repository,
        getThreadJudgement: vi.fn(async () => ({ lastJudgedExternalId: "m1", outcome: "no_item" }))
      }
    });
    expect(await judgeEmailThread({}, payload, d)).toBe("skipped");
    expect(d.generate).not.toHaveBeenCalled();
  });
  it("skips when the newest message is from the user", async () => {
    const d = deps({
      threads: {
        listThreadMessages: vi.fn(async () => [
          msg(),
          msg({ externalId: "m2", fromIsUser: true, fromAddress: "ben@ben.com" })
        ]),
        listThreadsWithNewerMessages: vi.fn()
      }
    });
    expect(await judgeEmailThread({}, payload, d)).toBe("skipped");
  });
  it("runs without a failing provider and tells the prompt", async () => {
    const d = deps({
      context: {
        ...deps().context,
        calendar: {
          windowFromNow: vi.fn(async () => {
            throw new Error("boom");
          })
        }
      }
    });
    await judgeEmailThread({}, payload, d);
    const prompt = d.generate.mock.calls[0][2] as string;
    expect(prompt).toContain("Calendar: unavailable");
  });
  it("treats a malformed answer as no item and logs a bounded warning", async () => {
    const warn = vi.fn();
    const d = deps({ generate: vi.fn(async () => ({ owed: "maybe" })), logger: { warn } });
    expect(await judgeEmailThread({}, payload, d)).toBe("no_item");
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain("Could you send");
  });
  it("lets a model failure throw so pg-boss retries", async () => {
    const d = deps({
      generate: vi.fn(async () => {
        throw new Error("model down");
      })
    });
    await expect(judgeEmailThread({}, payload, d)).rejects.toThrow("model down");
    expect(d.repository.recordThreadJudgement).not.toHaveBeenCalled();
  });
  it("never puts message bodies in the candidate beyond the why lines", async () => {
    const d = deps();
    await judgeEmailThread({}, payload, d);
    const input = JSON.stringify(d.repository.upsertEmailCandidate.mock.calls[0][1]);
    expect(input.match(/Could you send it back by Friday\?/g)?.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL, module missing.
- [ ] **Step 3: Implement**

```ts
// packages/commitments/src/email-judgement-worker.ts
import type PgBoss from "pg-boss";
import { registerDataContextWorker, type DataContextRunner } from "@moss/db"; // same import workers.ts uses
import type {
  EmailThreadProvider,
  CommitmentContextProviders,
  CommitmentPersonContext,
  CommitmentOpenTask,
  CommitmentCalendarWindow,
  EmailThreadMessage
} from "@moss/module-sdk";
import { COMMITMENT_EMAIL_JUDGEMENT_QUEUE } from "./manifest.js";
import type { EmailThreadJudgementJobPayload } from "./jobs.js";
import type { CommitmentsRepository } from "./repository.js";
import { buildEmailJudgementPrompt, parseEmailJudgement } from "./email-judgement.js";
import { buildCandidateSignature } from "./signature.js";
import type { CommitmentExtractionWarnLogger } from "./extractor.js";

export interface EmailJudgementWorkerDeps {
  /* as in Interfaces above */
}

const MEETING_WORDS =
  /\b(meet|meeting|call|appointment|schedule|reschedule|availability|available|time that works|slot|calendar|zoom|coffee|lunch)\b/i;

async function tryProvider<T>(
  missing: string[],
  name: "people" | "notes" | "tasks" | "calendar",
  fn: (() => Promise<T>) | undefined,
  fallback: T
): Promise<T> {
  if (!fn) return fallback;
  try {
    return await fn();
  } catch {
    missing.push(name);
    return fallback;
  }
}

function localDate(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
}

export async function judgeEmailThread(
  scopedDb: unknown,
  payload: EmailThreadJudgementJobPayload,
  deps: EmailJudgementWorkerDeps
): Promise<"no_item" | "item" | "skipped"> {
  const { actorUserId, threadRef } = payload;
  const messages = await deps.threads.listThreadMessages(scopedDb, actorUserId, threadRef);
  if (messages.length === 0) return "skipped";
  const newest = messages[messages.length - 1];
  if (newest.fromIsUser) return "skipped";
  const prior = await deps.repository.getThreadJudgement(scopedDb as never, actorUserId, threadRef);
  if (prior && prior.lastJudgedExternalId === newest.externalId) return "skipped";

  const contextOn = deps.contextEnabled ? await deps.contextEnabled(scopedDb, actorUserId) : true;
  const missing: ("people" | "notes" | "tasks" | "calendar")[] = [];
  const sender = newest.fromAddress;
  const wantsCalendar = messages.some((m) => MEETING_WORDS.test(`${m.subject} ${m.bodyExcerpt}`));
  const ctx = contextOn ? deps.context : {};
  const person = await tryProvider<CommitmentPersonContext | null>(
    missing,
    "people",
    ctx.people ? () => ctx.people!.resolveByEmail(scopedDb, actorUserId, sender) : undefined,
    null
  );
  const noteLines = await tryProvider<readonly string[]>(
    missing,
    "notes",
    ctx.notes
      ? () => ctx.notes!.searchLines(scopedDb, actorUserId, person?.displayName ?? sender, 5)
      : undefined,
    []
  );
  const openTasks = await tryProvider<readonly CommitmentOpenTask[]>(
    missing,
    "tasks",
    ctx.tasks ? () => ctx.tasks!.listOpen(scopedDb, actorUserId, 25) : undefined,
    []
  );
  const calendar = wantsCalendar
    ? await tryProvider<CommitmentCalendarWindow | null>(
        missing,
        "calendar",
        ctx.calendar ? () => ctx.calendar!.windowFromNow(scopedDb, actorUserId, 14) : undefined,
        null
      )
    : null;
  const ruled = deps.senderRuledNotObligation
    ? await deps.senderRuledNotObligation(scopedDb, actorUserId, sender)
    : false;
  const timezone = deps.timezoneFor ? await deps.timezoneFor(scopedDb, actorUserId) : "UTC";
  const now = deps.now ? deps.now() : new Date();

  const prompt = buildEmailJudgementPrompt({
    today: localDate(now, timezone),
    timezone,
    messages,
    person,
    noteLines,
    openTasks,
    calendar,
    missing,
    senderRuledNotObligation: ruled
  });
  const raw = await deps.generate(scopedDb, actorUserId, prompt); // throws => pg-boss retry
  const outcome = parseEmailJudgement(raw);
  if (!outcome) {
    deps.logger?.warn(
      { event: "commitments.email_judgement_malformed", threadRefHash: threadRef.slice(0, 8) },
      "email judgement answer did not parse"
    );
    await deps.repository.recordThreadJudgement(
      scopedDb as never,
      actorUserId,
      threadRef,
      newest.externalId,
      "no_item"
    );
    return "no_item";
  }
  if (!outcome.owed) {
    await deps.repository.recordThreadJudgement(
      scopedDb as never,
      actorUserId,
      threadRef,
      newest.externalId,
      "no_item"
    );
    return "no_item";
  }
  const hasTask = outcome.actions.some((a) => a.kind === "task");
  await deps.repository.upsertEmailCandidate(scopedDb as never, {
    ownerUserId: actorUserId,
    candidateSignature: buildCandidateSignature({
      kind: "obligation",
      counterpartyLabel: null,
      title: "email-thread",
      dueLocalDate: null,
      sourceKind: "email",
      sourceRef: threadRef
    }),
    kind: "obligation",
    title: outcome.title!,
    dueLocalDate: outcome.dueLocalDate,
    counterpartyLabel: outcome.counterpartyLabel ?? person?.displayName ?? sender,
    confidence: outcome.confidence,
    suggestedHandling: hasTask ? "create_task" : null,
    occurredAt: newest.receivedAt,
    counterpartyPersonId: person?.personId ?? null,
    counterpartyAddress: outcome.counterpartyAddress ?? sender,
    proposedActions: [...outcome.actions],
    whyLines: [...outcome.why],
    threadRef,
    lastJudgedExternalId: newest.externalId
  });
  await deps.repository.recordThreadJudgement(
    scopedDb as never,
    actorUserId,
    threadRef,
    newest.externalId,
    "item"
  );
  return "item";
}

export async function registerEmailThreadJudgementWorker(
  boss: PgBoss,
  dataContext: DataContextRunner,
  deps: EmailJudgementWorkerDeps
): Promise<string> {
  return registerDataContextWorker<EmailThreadJudgementJobPayload, void>(
    boss,
    COMMITMENT_EMAIL_JUDGEMENT_QUEUE,
    dataContext,
    async (job, scopedDb) => {
      await judgeEmailThread(scopedDb, job.data, deps);
    }
  );
}
```

Check `registerDataContextWorker`'s exact import path and return type in `workers.ts` and match it.

- [ ] **Step 4: Run** the test and `pnpm -s typecheck` — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/commitments/src/email-judgement-worker.ts packages/commitments/src/index.ts tests/unit/commitment-email-judgement-worker.test.ts
git commit -m "feat(commitments): reasoning-tier worker judges an email thread with the user's context"
```

### Task 9: Sync asks for a judgement after a maybe_owed message

**Files:**

- Modify: `packages/connectors/src/google-sync-phases.ts` (`PhaseContext.deps` type and the per-batch persist loop near line 422)
- Modify: `packages/connectors/src/imap-sync-jobs.ts` (line ~113)
- Test: `tests/unit/google-sync-thread-judgement-request.test.ts`

**Interfaces:**

- Produces: `PhaseContext.deps.threadJudgementRequester?: EmailThreadJudgementRequester` and the same optional field on the IMAP job deps. After `persistEmail(parsed, result)` where `result.gate === "maybe_owed"`, call `requester.requestThreadJudgement(actorUserId, parsed.threadId ?? parsed.externalId)`. IMAP has no thread id, so the message id is the thread reference; `listByThread` on the email side then matches nothing and the provider falls back to `getByConnectorAccountAndExternalId` for that single message (add that fallback to `createEmailThreadProvider`: if `listByThread` returns empty, try the message whose `external_id === threadRef`).
- Also: the known-sender set for Task 2 is built once per phase from `context.deps.knownSenderAddresses?.(scopedDb, actorUserId): Promise<ReadonlySet<string>>` (optional dep; the composition root supplies it from People identities plus the addresses of messages the user has sent in the sync window).

- [ ] **Step 1: Failing test**

Model it on `tests/unit/google-sync-email-sorting.test.ts` (the existing test that drives `runGoogleEmailPhase` with fakes). Add:

```ts
it("asks for a thread judgement once per maybe_owed thread and never for nothing", async () => {
  const requestThreadJudgement = vi.fn(async () => {});
  // arrange two messages on thread t1 answered maybe_owed, one message on t2 answered nothing
  // ... use the file's existing harness; set deps.threadJudgementRequester = { requestThreadJudgement }
  await runGoogleEmailPhase(context, "email");
  expect(requestThreadJudgement).toHaveBeenCalledTimes(2); // once per message; the queue's singleton key collapses them
  expect(requestThreadJudgement.mock.calls.every((c) => c[1] === "t1")).toBe(true);
});
it("passes known sender addresses into the batch options", async () => {
  // deps.knownSenderAddresses = async () => new Set(["sarah@kim.example"]);
  // assert extractEmailSignalsBatch (spied) received options.knownSenders containing that address
});
```

Write the arrange code by copying the harness from the sorting test; do not invent a new one.

- [ ] **Step 2: Run to verify it fails** — `pnpm vitest run tests/unit/google-sync-thread-judgement-request.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the two call sites:

```ts
// google-sync-phases.ts, inside the loop that re-persists extracted results
await persistEmail(parsed, result);
if (result.gate === "maybe_owed" && context.deps.threadJudgementRequester) {
  await context.deps.threadJudgementRequester.requestThreadJudgement(
    context.actorUserId,
    parsed.threadId ?? parsed.externalId
  );
}
```

and pass `{ ...existingOptions, knownSenders }` into `extractEmailSignalsBatch`, where `knownSenders = await context.deps.knownSenderAddresses?.(scopedDb, actorUserId) ?? new Set()` computed once before the batch loop. Same two lines in `imap-sync-jobs.ts` after `upsertCachedMessage`, with `parsed.externalId` as the thread reference and `knownSender: knownSenders.has(senderAddress(parsed.from))`.

- [ ] **Step 4: Run** the new test plus `tests/unit/google-sync-email-sorting.test.ts` and `pnpm -s typecheck` — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/connectors/src/google-sync-phases.ts packages/connectors/src/imap-sync-jobs.ts packages/email/src/thread-provider.ts tests/unit/google-sync-thread-judgement-request.test.ts
git commit -m "feat(connectors): request a thread judgement for maybe_owed mail; pass known senders to the gate"
```

### Task 10: Wire it all in the composition root

**Files:**

- Modify: `packages/module-registry/src/index.ts` (commitments entry near line 2296; the connectors deps where `emailExtractDeps` is built near line 1272)
- Test: `tests/unit/module-registry-email-judgement-wiring.test.ts` (asserts the worker registration function is called with a `generate` that requests `tierHint: "reasoning"` and the service key; fake `generateStructured`)

**Interfaces:**

- Consumes: everything above; `generateStructured` from `@moss/ai` (`packages/ai/src/structured/generate-structured.ts`, input `{ service, schema, tierHint, requireExplicitBinding, ... }`); `PersonContextService.resolve(scopedDb, ownerUserId, query)` from `packages/people/src/service.ts`; the `notes.search`, `tasks.list`, `calendar.listVisibleEvents` tool handlers executed directly the way `packages/briefings/src/compose-shared.ts:363` does.

- [ ] **Step 1: Failing test**: fake `generateStructured` and assert it is called with `service: "module.commitments.email-judgement"` and `tierHint: "reasoning"` when the built `generate` runs. Export a small factory `buildEmailJudgementGenerate({ aiRepository, cipher, generateStructured })` from the registry file (or a sibling `email-judgement-wiring.ts`) so the test can call it without booting the registry.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement**

```ts
// in packages/module-registry/src/index.ts (or ./email-judgement-wiring.ts)
export function buildEmailJudgementGenerate(deps: {
  aiRepository: AiRepository;
  cipher: AiSecretCipher;
  generateStructured: typeof generateStructured;
}) {
  return async (scopedDb: unknown, _actorUserId: string, prompt: string): Promise<unknown> => {
    const result = await deps.generateStructured(
      { repository: deps.aiRepository, cipher: deps.cipher },
      scopedDb as never,
      {
        service: EMAIL_JUDGEMENT_SERVICE,
        schema: EMAIL_JUDGEMENT_SCHEMA,
        tierHint: "reasoning",
        requireExplicitBinding: false,
        messages: [{ role: "user", content: prompt }]
      }
    );
    if (result.error) throw new Error(`email judgement model: ${result.error}`);
    return result.object;
  };
}
```

(Match `generateStructured`'s real argument order and result shape from `generate-structured.ts:82-130`; the test pins it.)

Providers:

```ts
const peopleService = new PersonContextService();
const contextProviders: CommitmentContextProviders = {
  people: {
    resolveByEmail: async (db, owner, address) => {
      const p = await peopleService.resolve(db, owner, address);
      return p
        ? {
            personId: p.id,
            displayName: p.displayName ?? null,
            relationshipSummary: p.summary ?? null,
            recentNoteLines: []
          }
        : null;
    }
  },
  notes: {
    searchLines: async (db, owner, query, limit) =>
      runToolLines(notesSearchTool, db, owner, { query, limit })
  },
  tasks: {
    listOpen: async (db, owner, limit) =>
      runToolTasks(tasksListTool, db, owner, { status: "open", limit })
  },
  calendar: {
    windowFromNow: async (db, owner, days) =>
      runToolCalendar(calendarListVisibleTool, db, owner, days)
  }
};
```

where `runTool*` are small adapters that execute the tool handler with a `ToolContext` for the owner (copy the shape from `compose-shared.ts:363`) and map the `data` rows into the provider types, taking only titles, dates and one-line summaries. Register:

```ts
registerWorkers: async (boss, deps) => {
  const ids = [await registerCommitmentExtractionWorker(/* unchanged */)];
  ids.push(
    await registerEmailThreadJudgementWorker(boss, deps.dataContext, {
      repository: new CommitmentsRepository(),
      threads: createEmailThreadProvider(new EmailRepository(), userAddressesFor),
      context: contextProviders,
      generate: buildEmailJudgementGenerate({
        aiRepository: new AiRepository(),
        cipher: createAiSecretCipher(),
        generateStructured
      }),
      timezoneFor: (db, owner) => preferences.timezoneFor(db, owner), // whatever briefings uses for the user's timezone
      logger: deps.logger ? createModuleLogger(deps.logger, "commitments") : undefined
    })
  );
  return ids.flat();
};
```

Add `queueDefinitions: [{ name: COMMITMENT_EXTRACTION_QUEUE, options: {} }, { name: COMMITMENT_EMAIL_JUDGEMENT_QUEUE, options: { retryLimit: 5, retryDelay: 120, retryBackoff: true } }]`. In the connectors deps (near line 1272), add `threadJudgementRequester: { requestThreadJudgement: (owner, thread) => enqueueEmailThreadJudgement(boss, owner, thread) }` and `knownSenderAddresses`.

- [ ] **Step 4: Run** the wiring test, `pnpm -s typecheck`, `pnpm exec eslint` on changed files, `pnpm -s build:app-map` — Expected: all exit 0. Then restart the dev API and worker (`pnpm dev:api`, one `pnpm dev:worker`) and confirm the API health answers on :3000 and the worker log shows the new queue registered.
- [ ] **Step 5: Commit**

```bash
git add packages/module-registry/src/index.ts tests/unit/module-registry-email-judgement-wiring.test.ts
git commit -m "feat(registry): wire the email judgement worker, providers and sync requester"
```

### Task 11: Live proof on dev (slice 1 deliverable)

**Files:** none in code. Output: a comment on the PR.

- [ ] **Step 1: Migrate dev.** Run the module reconcile the dev instance needs for new module SQL (see memory note "Installing a module on dev needs a manual reconcile"); confirm `\d app.commitment_candidates` shows `proposed_actions` and `app.commitment_email_thread_judgements` exists.
- [ ] **Step 2: Re-judge a window.** `pnpm email:rejudge <benUserId> --days 10` from the repo root against dev. Wait for the worker with a background `until` loop that counts rows in `app.commitment_email_thread_judgements`, never a foreground poll.
- [ ] **Step 3: Record before and after.** Before: the 2271 counts for the same window (`needs_action`, `needs_reply`, `time_sensitive`, `waiting`, `fyi`, `noise`). After: counts of `gate` outcomes in `signals` (`pendingJudgement`, `fyi`, `noise`), rows in the judgement table by outcome, and open email candidates.
- [ ] **Step 4: Spot checks, six threads:** a promotion (expect gate nothing, no judgement row), a ticket drop (nothing), a policy update (nothing), a sign-in notice (nothing or otp skip), a genuine obligation with an unsubscribe link (maybe_owed, then a candidate with a sensible owed-by date), and ordinary mail from a friend that asks nothing (nothing, no summary stored). Paste thread subjects, gate, judgement outcome and the candidate's title, counterparty, due date and why lines. Never paste bodies.
- [ ] **Step 5: Post** the table and the spot checks on the PR as "Slice 1 live proof". Revert the temporary 30d to 10d window edit in `google-sync-phases.ts` if it is still in place, and say so in the comment.

---

# Slice 2 and slice 3

Detailed tasks live in:

- `docs/superpowers/plans/2026-09-04-email-chief-of-staff-slice-2-today-card.md`: the "You owe people" card on Today (layout B, rows collapsed until tapped), the four actions and their sheets, the three closing triggers, the stale flag, the REST routes and app-map entries they need.
- `docs/superpowers/plans/2026-09-04-email-chief-of-staff-slice-3-moss-learning-settings.md`: Moss's tool changes, dismiss learning and the People toggle, the "judge with context" email setting, the settings' app-map entries and the release note.

Each slice is a session. Read this header and the spec before starting either.
