# Email as Chief of Staff, Slice 2: Today card, actions, closing the loop

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the email items slice 1 produces on Today as a "You owe people" card with four working actions, and close each item automatically when the user acts.

**Architecture:** Commitments gains a read route shaped for the card and four action routes. Draft reply and Make task call into email and tasks through injected services in the composition root (the same `emailWrite` service the email tools use, and the tasks REST create handler), never by importing those modules. Closing runs in three places: the action routes themselves, a small check in the judgement worker's sync path that looks for a newer user-sent message on each open thread, and a resolution verifier that asks tasks whether a linked task is done. The web card is a React component under `apps/web/src/today/` using existing `jds-*` classes.

**Tech Stack:** as the shared header (`2026-09-04-email-chief-of-staff.md`). Read that header and its Global Constraints first; they all apply here.

**Spec:** `docs/superpowers/specs/2026-09-04-email-chief-of-staff-design.md` sections 4, 5 and 6; mockup `assets/2026-09-04-email-chief-of-staff/02-row-expanded-and-actions.html`.

**Two spec deviations, decided in the plan, flag to Ben:** the web app has no Commitments page and no People screen (grep of `apps/web/src` finds neither; Commitments' manifest has empty `routes` and no `navigation`). So (a) stale items are reached through a "Show N older" link at the bottom of the card instead of a Commitments page, and (b) the "Open in People" link is omitted in this slice; slice 3 puts the per-sender rule in Email settings instead of a People entry. If Ben wants real pages, that is a separate spec.

## File Structure (this slice)

- Modify `packages/shared/src/commitments-api.ts` (create if absent): `OwedItemDto`, `OwedItemsResponse`, action request/response types and JSON schemas.
- Modify `packages/commitments/src/routes.ts`: `GET /api/commitments/owed`, `POST /api/commitments/owed/:id/reply`, `POST /api/commitments/owed/:id/task`, `POST /api/commitments/owed/:id/snooze`, `POST /api/commitments/owed/:id/dismiss`.
- Create `packages/commitments/src/email-actions.ts`: pure action logic behind those routes, given injected services.
- Create `packages/commitments/src/email-close.ts`: the "user replied in Gmail" sweep and the stale marker.
- Modify `packages/commitments/src/repository.ts`: `markResolved`, `markStale`, `setLinkedTask`, `listOpenEmailCandidates` already exists from slice 1.
- Modify `packages/commitments/src/manifest.ts`: routes, `features` metadata for the card.
- Modify `packages/module-sdk/src/index.ts`: `CommitmentActionServices` (email write, task create, task status lookup, calendar free slots).
- Modify `packages/module-registry/src/index.ts`: build and inject those services; register the reply-sweep after each email sync.
- Modify `packages/connectors/src/google-sync-phases.ts`: after a phase completes, call the injected `afterEmailSync?.(scopedDb, actorUserId)` hook.
- Create `apps/web/src/api/client-commitments.ts`, `apps/web/src/today/owed-card.tsx`, `owed-row.tsx`, `owed-reply-sheet.tsx`, `owed-dismiss-sheet.tsx`, `owed-snooze-menu.tsx`, `use-owed-items.ts`; modify `apps/web/src/today/today-page.tsx` and `apps/web/src/api/query-keys.ts`.
- Modify `packages/shared/src/app-map-core.ts`: Today description mentions the card.
- Tests: `tests/unit/commitment-owed-dto.test.ts`, `commitment-email-actions.test.ts`, `commitment-email-close.test.ts`, `commitment-owed-routes.test.ts`, `apps/web/src/today/owed-card.test.tsx` (vitest + testing-library, following the existing `apps/web/src/today/*.test.tsx` pattern if one exists; otherwise the tasks tests).

### Task 1: Shared contract for the card

**Files:**
- Create or modify: `packages/shared/src/commitments-api.ts`; export from `packages/shared/src/index.ts`
- Test: `tests/unit/commitment-owed-dto.test.ts`

**Interfaces (Produces):**

```ts
export type OwedActionKind = "reply" | "task" | "snooze" | "dismiss";
export interface OwedProposedAction {
  readonly kind: OwedActionKind;
  readonly label: string;            // "Draft reply with 3 free slots", "Task, due Wed", "Snooze", "Dismiss"
  readonly primary: boolean;         // exactly one primary per item
  readonly dueLocalDate?: string | null;
  readonly untilLocalDate?: string | null;
  readonly wantsFreeSlots?: boolean;
}
export interface OwedItemDto {
  readonly id: string;
  readonly title: string;
  readonly counterpartyLabel: string;
  readonly counterpartyPersonId: string | null;
  readonly dueLocalDate: string | null;
  readonly confidence: "high" | "medium" | "low";
  readonly whyLines: readonly string[];
  readonly sourceLine: string;       // "from email, 2 messages"
  readonly threadRef: string;
  readonly replyToCacheMessageId: string | null; // newest counterparty message; what reply/send take
  readonly actions: readonly OwedProposedAction[];
  readonly status: "pending_review" | "accepted" | "snoozed";
  readonly snoozedUntil: string | null;
  readonly stale: boolean;
  readonly linkedTaskId: string | null;
}
export interface OwedItemsResponse { readonly items: readonly OwedItemDto[]; readonly older: readonly OwedItemDto[]; }
export interface OwedReplyRequest { readonly mode: "send" | "draft"; readonly body: string; }
export interface OwedReplyDraftResponse { readonly body: string; readonly freeSlots: readonly { start: string; end: string }[]; }
export interface OwedTaskRequest { readonly title?: string; readonly dueLocalDate?: string | null; }
export interface OwedSnoozeRequest { readonly untilLocalDate: string; }
export interface OwedDismissRequest { readonly reason?: "not_owed" | "handled" | "not_now"; }
export interface OwedActionResponse { readonly item: OwedItemDto | null; readonly taskId?: string; readonly messageRef?: string; }
```

Plus JSON schemas `owedReplyRequestSchema`, `owedTaskRequestSchema`, `owedSnoozeRequestSchema`, `owedDismissRequestSchema` (TypeBox, like `statusUpdateSchema` in `routes.ts`), and the pure mapper `toOwedItemDto(candidate: CommitmentCandidate, opts: { messageCount: number; replyToCacheMessageId: string | null; today: string }): OwedItemDto` in `packages/commitments/src/owed-dto.ts`.

- [ ] **Step 1: Failing test**

```ts
// tests/unit/commitment-owed-dto.test.ts
import { describe, expect, it } from "vitest";
import { toOwedItemDto } from "../../packages/commitments/src/owed-dto.js";
const cand = (o: any = {}) => ({ id: "c1", ownerUserId: "u1", candidateSignature: "s", kind: "obligation", title: "Send Sarah the lease addendum", dueLocalDate: "2026-09-05", counterpartyLabel: "Sarah Kim", counterpartyPersonId: "p1", counterpartyAddress: "sarah@kim.example", confidence: "high", suggestedHandling: "create_task", status: "pending_review", resolutionRef: null, snoozedUntil: null, stale: false, threadRef: "t1", lastJudgedExternalId: "m2", whyLines: ["\"Could you send it back by Friday?\""], proposedActions: [{ kind: "reply", facts: [], wantsFreeSlots: true }, { kind: "task", title: "Send addendum", dueLocalDate: "2026-09-05" }, { kind: "dismiss" }], linkedTaskId: null, ...o });
describe("toOwedItemDto", () => {
  it("labels actions, always offers all four, marks the first proposed one primary", () => {
    const dto = toOwedItemDto(cand() as any, { messageCount: 2, replyToCacheMessageId: "cm1", today: "2026-09-04" });
    expect(dto.actions.map((a) => a.kind)).toEqual(["reply", "task", "snooze", "dismiss"]);
    expect(dto.actions[0]).toMatchObject({ label: "Draft reply with free slots", primary: true, wantsFreeSlots: true });
    expect(dto.actions[1]).toMatchObject({ label: "Task, due Fri", primary: false, dueLocalDate: "2026-09-05" });
    expect(dto.actions.filter((a) => a.primary)).toHaveLength(1);
    expect(dto.sourceLine).toBe("from email, 2 messages");
    expect(dto.replyToCacheMessageId).toBe("cm1");
  });
  it("a due date more than 6 days out is shown as a date", () => {
    const dto = toOwedItemDto(cand({ proposedActions: [{ kind: "task", title: "T", dueLocalDate: "2026-09-20" }] }) as any, { messageCount: 1, replyToCacheMessageId: null, today: "2026-09-04" });
    expect(dto.actions.find((a) => a.kind === "task")?.label).toBe("Task, due Sep 20");
  });
  it("never includes email addresses or bodies", () => {
    const s = JSON.stringify(toOwedItemDto(cand() as any, { messageCount: 1, replyToCacheMessageId: null, today: "2026-09-04" }));
    expect(s).not.toContain("sarah@kim.example");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm vitest run tests/unit/commitment-owed-dto.test.ts`
- [ ] **Step 3: Implement** `owed-dto.ts`:

```ts
import type { OwedItemDto, OwedProposedAction } from "@moss/shared";
import type { CommitmentCandidate } from "./types.js";
const ORDER = ["reply", "task", "snooze", "dismiss"] as const;
export function shortDue(due: string | null, today: string): string | null {
  if (!due) return null;
  const d = new Date(`${due}T00:00:00Z`), t = new Date(`${today}T00:00:00Z`);
  const days = Math.round((d.getTime() - t.getTime()) / 86_400_000);
  if (days === 0) return "today"; if (days === 1) return "tomorrow";
  if (days > 1 && days <= 6) return d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
export function toOwedItemDto(c: CommitmentCandidate, o: { messageCount: number; replyToCacheMessageId: string | null; today: string }): OwedItemDto {
  const proposed = c.proposedActions ?? [];
  const firstKind = proposed[0]?.kind ?? "reply";
  const actions: OwedProposedAction[] = ORDER.map((kind) => {
    const p = proposed.find((a) => a.kind === kind) as any;
    switch (kind) {
      case "reply": return { kind, primary: firstKind === kind, label: p?.wantsFreeSlots ? "Draft reply with free slots" : "Draft reply", wantsFreeSlots: p?.wantsFreeSlots === true };
      case "task": { const due = p?.dueLocalDate ?? c.dueLocalDate ?? null; const s = shortDue(due, o.today); return { kind, primary: firstKind === kind, label: s ? `Task, due ${s[0].toUpperCase()}${s.slice(1)}` : "Make task", dueLocalDate: due }; }
      case "snooze": return { kind, primary: firstKind === kind, label: "Snooze", untilLocalDate: p?.untilLocalDate ?? null };
      case "dismiss": return { kind, primary: false, label: "Dismiss" };
    }
  });
  return { id: c.id, title: c.title, counterpartyLabel: c.counterpartyLabel ?? "Someone", counterpartyPersonId: c.counterpartyPersonId ?? null, dueLocalDate: c.dueLocalDate, confidence: c.confidence,
    whyLines: c.whyLines ?? [], sourceLine: `from email, ${o.messageCount} message${o.messageCount === 1 ? "" : "s"}`, threadRef: c.threadRef!, replyToCacheMessageId: o.replyToCacheMessageId,
    actions, status: c.status as OwedItemDto["status"], snoozedUntil: c.snoozedUntil ? c.snoozedUntil.toISOString() : null, stale: c.stale ?? false, linkedTaskId: c.linkedTaskId ?? null };
}
```

`linkedTaskId` is a new column added in Task 3's migration; add `linkedTaskId?: string | null` to `CommitmentCandidate` now so this compiles.

- [ ] **Step 4: Run** the test and `pnpm -s typecheck` — PASS.
- [ ] **Step 5: Commit** `packages/shared/src/commitments-api.ts packages/shared/src/index.ts packages/commitments/src/owed-dto.ts packages/commitments/src/types.ts tests/unit/commitment-owed-dto.test.ts` with `feat(commitments): owed-item contract and DTO mapper for the Today card`.

### Task 2: Action services contract in module-sdk

**Files:**
- Modify: `packages/module-sdk/src/index.ts`
- Test: `tests/unit/module-sdk-email-judgement-types.test.ts` (extend)

**Interfaces (Produces):**

```ts
export interface CommitmentActionServices {
  email: {
    draftReply(scopedDb: unknown, actorUserId: string, cacheMessageId: string, body: string): Promise<{ messageRef: string }>;
    sendReply(scopedDb: unknown, actorUserId: string, cacheMessageId: string, body: string): Promise<{ messageRef: string }>;
  };
  tasks: {
    create(scopedDb: unknown, actorUserId: string, input: { title: string; dueLocalDate: string | null; sourceNote: string }): Promise<{ taskId: string }>;
    isDone(scopedDb: unknown, actorUserId: string, taskId: string): Promise<boolean | null>; // null = task gone
  };
  calendar: {
    freeSlots(scopedDb: unknown, actorUserId: string, opts: { days: number; count: number; minutes: number }): Promise<readonly { start: string; end: string }[]>;
  };
  composeReply?: (scopedDb: unknown, actorUserId: string, prompt: string) => Promise<string>; // interactive tier text generation; slice 2 Task 4
}
```

- [ ] **Step 1: Extend the compile test** with a `const s: CommitmentActionServices = {...}` literal of stubs. Run, FAIL. Add the interface. Run, PASS. Commit `feat(module-sdk): action services contract for commitment email items`.

### Task 3: Repository: linked task, resolved, stale

**Files:**
- Create: `packages/commitments/sql/0217_commitment_email_links.sql`
- Modify: `packages/commitments/src/manifest.ts` (migrations), `repository.ts`, `types.ts`
- Test: `tests/unit/commitment-email-repository-sql.test.ts` (extend)

```sql
-- packages/commitments/sql/0217_commitment_email_links.sql
ALTER TABLE app.commitment_candidates
  ADD COLUMN linked_task_id uuid,
  ADD COLUMN resolved_by text CHECK (resolved_by IN ('reply_sent','draft_saved','task_done','user_replied_in_mail','dismissed'));
CREATE INDEX IF NOT EXISTS idx_commitment_candidates_owner_open_email
  ON app.commitment_candidates (owner_user_id, status) WHERE thread_ref IS NOT NULL AND resolution_ref IS NULL;
```

**Interfaces (Produces):**
- `markResolved(scopedDb, ownerUserId, candidateId, by: ResolvedBy, resolutionRef: string): Promise<CommitmentCandidate>` sets `status='accepted'`, `resolution_ref`, `resolved_by`, `updated_at`.
- `setLinkedTask(scopedDb, ownerUserId, candidateId, taskId: string): Promise<CommitmentCandidate>`.
- `markStale(scopedDb, ownerUserId, olderThanLocalDate: string): Promise<number>` sets `stale=true` where `thread_ref IS NOT NULL AND resolution_ref IS NULL AND due_local_date < $olderThan AND stale=false`; returns count.
- `listOpenEmailCandidates` (slice 1) now also returns `linkedTaskId`, `resolvedBy`.

- [ ] **Step 1: Failing tests** using `makeRecordingDb` from `tests/unit/helpers/recording-db.ts` (created in slice 1 Task 5): the compiled SQL of each method contains `"resolved_by"`, `"linked_task_id"`, and `"due_local_date" <` respectively, and the parameters contain (`ownerUserId, candidateId, by, resolutionRef`), (`ownerUserId, candidateId, taskId`), (`ownerUserId, olderThan`). Pass `{ rows: [row] }` for the two methods that return a candidate.
- [ ] **Step 2: Run, FAIL. Step 3: Implement** the three methods with `UPDATE ... WHERE owner_user_id = $1 AND id = $2 RETURNING *` (and the stale one returning `Number(result.numUpdatedRows)`). Add the columns to the mapper. **Step 4: Run, PASS, typecheck.**
- [ ] **Step 5: Commit** with `feat(commitments): link tasks, record how an email item closed, mark stale`.

### Task 4: Action logic (pure, injected services)

**Files:**
- Create: `packages/commitments/src/email-actions.ts`
- Test: `tests/unit/commitment-email-actions.test.ts`

**Interfaces (Produces):**

```ts
export interface EmailActionDeps { repository: CommitmentsRepository; services: CommitmentActionServices; threads: EmailThreadProvider; today: (scopedDb: unknown, actorUserId: string) => Promise<string>; }
export async function prepareReply(scopedDb, actorUserId, candidateId, deps): Promise<OwedReplyDraftResponse>       // builds the editable body
export async function performReply(scopedDb, actorUserId, candidateId, req: OwedReplyRequest, deps): Promise<OwedActionResponse>
export async function performTask(scopedDb, actorUserId, candidateId, req: OwedTaskRequest, deps): Promise<OwedActionResponse>
export async function performSnooze(scopedDb, actorUserId, candidateId, req: OwedSnoozeRequest, deps): Promise<OwedActionResponse>
export async function performDismiss(scopedDb, actorUserId, candidateId, req: OwedDismissRequest, deps, onNotOwed?: (scopedDb, actorUserId, address: string) => Promise<void>): Promise<OwedActionResponse>
export class OwedActionError extends Error { constructor(public code: "not_found" | "no_message" | "already_closed", msg: string) }
```

Rules (from spec section 5):
- `prepareReply`: load candidate (owner-scoped; `not_found` if missing or not an email item; `already_closed` if `resolution_ref` set). Find the newest counterparty message via `threads.listThreadMessages`; `no_message` if none. If the proposed reply action `wantsFreeSlots`, fetch `services.calendar.freeSlots({days: 7, count: 3, minutes: 60})` now (not at judgement time). If `services.composeReply` exists, ask it for a plain-text reply using the candidate title, why lines, reply facts and the slots (prompt in code below); otherwise fall back to a template. Return `{ body, freeSlots }`.
- `performReply`: `mode: "send"` calls `services.email.sendReply`, `"draft"` calls `draftReply`; both then `markResolved(by: mode === "send" ? "reply_sent" : "draft_saved", resolutionRef: \`email:${messageRef}\`)` and return `{ item: null, messageRef }`.
- `performTask`: `services.tasks.create({ title: req.title ?? proposedTask.title ?? candidate.title, dueLocalDate: req.dueLocalDate ?? proposedTask.dueLocalDate ?? candidate.dueLocalDate, sourceNote: \`From email: ${candidate.title}\` })`, then `setLinkedTask` and `updateStatus(..., "accepted")`. Item stays open. Return `{ item: dto, taskId }`.
- `performSnooze`: `updateStatus(..., "snoozed", new Date(\`${untilLocalDate}T00:00:00Z\`))`.
- `performDismiss`: `updateStatus(..., req.reason === "not_owed" ? "explicit_non_action" : "rejected")`; if `not_owed` and `onNotOwed` given, call it with `candidate.counterpartyAddress` (slice 3 supplies the learner). Return `{ item: null }`.

Reply prompt (for `composeReply`):

```ts
export function buildReplyPrompt(i: { title: string; counterparty: string; why: readonly string[]; facts: readonly string[]; slots: readonly { start: string; end: string }[]; timezone: string; userName: string }): string {
  return [
    `Write a short, warm, plain-text email reply from ${i.userName} to ${i.counterparty}. No subject line, no markdown, no placeholders.`,
    `What the user owes: ${i.title}.`, i.why.length ? `Context: ${i.why.join(" ")}` : "",
    i.facts.length ? `Use these facts: ${i.facts.join("; ")}` : "",
    i.slots.length ? `Offer exactly these times (${i.timezone}), one per line: ${i.slots.map((s) => `${s.start} to ${s.end}`).join("; ")}` : "",
    "Three to six sentences. Sign off with the user's first name."
  ].filter(Boolean).join("\n");
}
```

Template fallback: `Hi ${firstName(counterparty)},\n\nThanks for your note about ${title.toLowerCase()}.` plus, if slots, `Any of these work for me:\n${slots as "Tue Sep 9, 2:00-3:00pm" lines}\n` plus `\n${userName}`.

- [ ] **Step 1: Failing tests** covering: prepareReply fetches slots only when `wantsFreeSlots`; prepareReply uses composeReply when present, template otherwise; performReply send resolves with `reply_sent` and `email:<ref>`; performReply draft resolves with `draft_saved`; performTask creates with the proposed title and due date, links the task, leaves the item open (status accepted, resolution_ref null); performSnooze sets snoozed with the date; performDismiss without reason sets rejected and does not call `onNotOwed`; with `not_owed` sets `explicit_non_action` and calls `onNotOwed` with the sender address; each function throws `OwedActionError("already_closed")` when `resolutionRef` is set; nothing in any returned object contains an email address. Use `vi.fn` stubs for repository, services and threads exactly as the slice 1 worker test does.
- [ ] **Step 2: Run, FAIL. Step 3: Implement as specified. Step 4: Run, PASS, typecheck.**
- [ ] **Step 5: Commit** with `feat(commitments): reply, task, snooze and dismiss actions for email items`.

### Task 5: Routes for the card and actions

**Files:**
- Modify: `packages/commitments/src/routes.ts`, `packages/commitments/src/manifest.ts` (`routes`), `packages/commitments/src/index.ts` (`CommitmentsRouteDependencies` gains `actionServices?: CommitmentActionServices`, `threads?: EmailThreadProvider`, `onNotOwed?`)
- Test: `tests/unit/commitment-owed-routes.test.ts` (Fastify `inject`, fake deps; model on the existing commitments route test if one exists, else on `tests/unit/*-routes.test.ts`)

Routes (all `permissionId: "commitments.view"` for GET, `"commitments.update"` for POST, declared in the manifest or the server refuses to start):

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/commitments/owed` | none | `OwedItemsResponse`: `items` = open, not stale, not snoozed-in-future, ordered by due then last seen; `older` = stale or snoozed |
| GET | `/api/commitments/owed/:id/reply` | none | `OwedReplyDraftResponse` from `prepareReply` |
| POST | `/api/commitments/owed/:id/reply` | `OwedReplyRequest` | `OwedActionResponse` |
| POST | `/api/commitments/owed/:id/task` | `OwedTaskRequest` | `OwedActionResponse` |
| POST | `/api/commitments/owed/:id/snooze` | `OwedSnoozeRequest` | `OwedActionResponse` |
| POST | `/api/commitments/owed/:id/dismiss` | `OwedDismissRequest` | `OwedActionResponse` |

Error mapping: `not_found` 404, `no_message` 409, `already_closed` 409, missing services 503 with `{ error: "Email actions unavailable" }`. The GET builds each DTO with `messageCount` and `replyToCacheMessageId` from `threads.listThreadMessages` (newest non-user message); if `threads` is absent, use `messageCount: 1` and `null`.

- [ ] **Step 1: Failing test**: GET returns items split into `items` and `older` (one stale candidate, one snoozed-until-tomorrow, one open); POST reply with `mode: "send"` calls the action and returns 200; POST on a closed candidate returns 409; GET without `actionServices` still works, POST reply without them returns 503; response JSON never contains `counterparty_address` or `@`.
- [ ] **Step 2: Run, FAIL. Step 3: Implement** the six handlers by delegating to Task 4 functions; wrap in `try/catch` mapping `OwedActionError.code`. **Step 4: Run, PASS, typecheck.**
- [ ] **Step 5: Commit** with `feat(commitments): owed-items read route and four action routes`.

### Task 6: Closing when the user replies in Gmail, and marking stale

**Files:**
- Create: `packages/commitments/src/email-close.ts`
- Modify: `packages/connectors/src/google-sync-phases.ts` (call `context.deps.afterEmailSync?.(scopedDb, actorUserId)` at the end of `runGoogleEmailPhase`), same in `imap-sync-jobs.ts`
- Test: `tests/unit/commitment-email-close.test.ts`

**Interfaces (Produces):**

```ts
export async function closeItemsAnsweredInMail(scopedDb, actorUserId, deps: { repository: CommitmentsRepository; threads: EmailThreadProvider; requestJudgement: (actorUserId: string, threadRef: string) => Promise<void> }): Promise<{ closed: number; rejudged: number }>
export async function markStaleItems(scopedDb, actorUserId, deps: { repository: CommitmentsRepository; today: string }): Promise<number>
```

Rules (spec section 6): for each open email candidate, ask `threads.listThreadsWithNewerMessages` with `{ threadRef, afterExternalId: lastJudgedExternalId }`. If the newest newer message `fromIsUser`, `markResolved(by: "user_replied_in_mail", resolutionRef: \`email:${externalId}\`)`. If it is from the counterparty, call `requestJudgement` so slice 1 re-judges the thread (the judgement upsert then refreshes the same row). `markStaleItems` calls `repository.markStale` with `today minus 14 days`.

- [ ] **Step 1: Failing tests**: user reply closes with the right `resolvedBy` and ref; counterparty reply requests a judgement and does not close; no newer message does nothing; a candidate due 15 days ago becomes stale, one due 13 days ago does not.
- [ ] **Step 2: Run, FAIL. Step 3: Implement**; wire `afterEmailSync` in the composition root (Task 8) to run both functions inside the sync's data context. **Step 4: Run, PASS.**
- [ ] **Step 5: Commit** with `feat(commitments): close email items the user answered in mail; mark stale after 14 days`.

### Task 7: Closing when the linked task is done

**Files:**
- Modify: `packages/commitments/src/email-close.ts` (add `closeItemsWithDoneTasks`)
- Modify: `packages/tasks/src/index.ts` (export a small `TaskStatusLookup` implementation: `isTaskDone(scopedDb, actorUserId, taskId): Promise<boolean | null>` built on the tasks repository's existing get-by-id, reading `status`)
- Test: extend `tests/unit/commitment-email-close.test.ts`

Tasks publishes no status-change event, so this is a poll folded into the same after-sync hook and into the GET owed route (cheap: one lookup per open item with a linked task). `closeItemsWithDoneTasks(scopedDb, actorUserId, { repository, services })`: for each open candidate with `linkedTaskId`, `services.tasks.isDone(...)`; `true` → `markResolved(by: "task_done", resolutionRef: \`task:${taskId}\`)`; `null` (task deleted) → clear the link with `setLinkedTask(..., null)` (allow null in Task 3's method) and leave the item open.

- [ ] **Step 1: Failing tests** for the three outcomes. **Step 2: Run, FAIL. Step 3: Implement. Step 4: Run, PASS, typecheck.**
- [ ] **Step 5: Commit** with `feat(commitments): close an email item when its linked task is done`.

### Task 8: Wire services in the composition root

**Files:**
- Modify: `packages/module-registry/src/index.ts`
- Test: `tests/unit/module-registry-email-actions-wiring.test.ts` (asserts the built `CommitmentActionServices.email.sendReply` calls the `emailWrite` service's `sendReply` with a `ToolContext` for the actor, and `tasks.create` posts `dueAt` as the local date at 17:00 in the user's timezone)

Build `CommitmentActionServices`:
- `email.*`: wrap the existing `EmailWriteService` instance the gateway builds (`packages/chat/src/gateway-services.ts:174` shows how it is constructed; construct one the same way here), calling `draftReply(scopedDb, ctx, { cacheMessageId, body })` with `ctx` built like briefings does in `compose-shared.ts:363`; return `{ messageRef: result.messageId ?? result.draftId }` (read `EmailWriteResult` in `packages/email/src/email-write-service.ts` for the exact field names).
- `tasks.create`: call the tasks module's create handler the way `taskCreateExecute` does (import the exported service function from `@moss/tasks`, not the route), with `{ title, dueAt: dueLocalDate ? toIsoAtLocalHour(dueLocalDate, 17, timezone) : null, description: sourceNote }`; return `{ taskId: task.id }`.
- `tasks.isDone`: the Task 7 lookup, `status === "done"` (confirm the done value in `TASK_STATUSES` in `packages/shared/src/tasks-api.ts`).
- `calendar.freeSlots`: list visible events for the next `days` via the calendar module's exported list function, compute gaps between 09:00 and 18:00 local on weekdays of at least `minutes`, return the first `count` as ISO strings.
- `composeReply`: `generateText`-style call through `@moss/ai` with `service: "module.commitments.email-reply"`, `tierHint: "interactive"`, `requireExplicitBinding: false` (find the plain-text generation entry point next to `generate-structured.ts`; if only structured exists, use it with a `{ body: string }` schema).
- Pass `actionServices`, `threads` (slice 1 provider) and `onNotOwed` (undefined until slice 3) into `registerCommitmentsRoutes`. Set connectors' `afterEmailSync` to run `closeItemsAnsweredInMail`, `closeItemsWithDoneTasks`, `markStaleItems`.

- [ ] **Steps:** failing wiring test; run; implement; `pnpm -s typecheck`, eslint on changed files, `pnpm -s build:app-map`; restart dev API; `curl -s http://localhost:3000/api/commitments/owed -H "cookie: ..."` returns JSON (use the dev login recipe from memory). Commit `feat(registry): wire email item actions, closing sweep and reply composer`.

### Task 9: Web client and query keys

**Files:**
- Create: `apps/web/src/api/client-commitments.ts`
- Modify: `apps/web/src/api/query-keys.ts` (add `commitments: { owed: ["commitments", "owed"] as const }`)
- Test: `apps/web/src/api/client-commitments.test.ts` (fetch mocked, following `client-proactive`'s test if present)

```ts
import type { OwedItemsResponse, OwedReplyDraftResponse, OwedReplyRequest, OwedTaskRequest, OwedSnoozeRequest, OwedDismissRequest, OwedActionResponse } from "@moss/shared";
import { apiFetch } from "./client"; // whatever helper client.ts uses for JSON requests with credentials
export const getOwedItems = () => apiFetch<OwedItemsResponse>("/api/commitments/owed");
export const getOwedReplyDraft = (id: string) => apiFetch<OwedReplyDraftResponse>(`/api/commitments/owed/${id}/reply`);
export const postOwedReply = (id: string, body: OwedReplyRequest) => apiFetch<OwedActionResponse>(`/api/commitments/owed/${id}/reply`, { method: "POST", body });
export const postOwedTask = (id: string, body: OwedTaskRequest) => apiFetch<OwedActionResponse>(`/api/commitments/owed/${id}/task`, { method: "POST", body });
export const postOwedSnooze = (id: string, body: OwedSnoozeRequest) => apiFetch<OwedActionResponse>(`/api/commitments/owed/${id}/snooze`, { method: "POST", body });
export const postOwedDismiss = (id: string, body: OwedDismissRequest) => apiFetch<OwedActionResponse>(`/api/commitments/owed/${id}/dismiss`, { method: "POST", body });
```

- [ ] Failing test (each function hits the right path and method); run; implement; run; commit `feat(web): api client for owed items`.

### Task 10: The Today card (layout B, rows collapsed until tapped)

**Files:**
- Create: `apps/web/src/today/owed-card.tsx`, `owed-row.tsx`, `owed-snooze-menu.tsx`, `use-owed-items.ts`
- Modify: `apps/web/src/today/today-page.tsx` (mount `<OwedCard />` directly above `<ProactiveCards />`), `apps/web/src/styles/kit-today-misc.css` (only if an existing `jds-*` class cannot express the row; run the design-system audit)
- Test: `apps/web/src/today/owed-card.test.tsx`

Run the `design-system` skill first. Use `jds-brief` / `jds-brief__head` / `jds-brief__kicker` / `jds-brief__title` for the card shell (as `proactive-cards.tsx:42-49`), `jds-task` / `jds-task__main` / `jds-task__title` / `jds-task__meta` for rows, and the existing chip/button primitives from `@moss/ui` for the four actions. Do not invent classes.

Behaviour:
- Header "You owe people", right side "N open". Card renders nothing while loading or when `items` and `older` are both empty.
- Each row collapsed: title, counterparty, short due (`shortDue` moved to `@moss/shared` so both sides use it). Tap toggles `expandedId` (one open at a time, none by default).
- Expanded: source line, "Why" block with the why lines, four chips in the DTO's order with the primary one styled primary, links row with "Open thread" (deep link `https://mail.google.com/mail/#all/${threadRef}`, opens new tab; hidden if the thread ref is an IMAP message id).
- Chip actions: reply opens the sheet (Task 11); task calls `postOwedTask` with the chip's `dueLocalDate`, then swaps the chip text to "Task made · open" (the item stays); snooze opens `OwedSnoozeMenu` with Moss's suggested date (if any), "Tomorrow", "Next week", and a date input; dismiss opens the sheet (Task 11).
- `older.length > 0` shows a bottom link "Show N older" that expands the older list inline with a "stale" or "snoozed until …" badge per row.
- Every mutation invalidates `queryKeys.commitments.owed` and `queryKeys.tasks.list`.

- [ ] **Step 1: Failing tests**: renders nothing when empty; renders three collapsed rows with no chips visible; clicking a row shows its why lines and four chips; clicking another row collapses the first; task chip posts and shows "Task made"; "Show 1 older" reveals the stale row. Mock the client module with `vi.mock("../api/client-commitments")`.
- [ ] **Step 2: Run** with the web test command (`pnpm --filter @moss/web test -- owed-card` or whatever `apps/web/package.json` names it), FAIL. **Step 3: Implement. Step 4: Run, PASS; run the design-system audit command from the skill.**
- [ ] **Step 5: Commit** with `feat(web): "You owe people" card on Today with collapsed rows and four actions`.

### Task 11: Draft reply and Dismiss sheets

**Files:**
- Create: `apps/web/src/today/owed-reply-sheet.tsx`, `owed-dismiss-sheet.tsx`
- Test: `apps/web/src/today/owed-sheets.test.tsx`

Reply sheet (mockup middle panel): title "Reply to {counterparty}"; on open, fetch `getOwedReplyDraft(id)` and show the body in an editable textarea (disabled with "Drafting…" until it arrives); hint text exactly: "Editable. Slots come from your calendar right now, so they are current when you send. Nothing is sent until you choose."; buttons Send (primary), Save as Gmail draft, Cancel; after either action, the second hint: "Send or save closes this item and links it to the sent message. If Moss later sees a reply from them, the thread is judged again." then close and invalidate. Send shows a confirm step ("Send to {counterparty}?") because email send is destructive-tier everywhere else in the app.

Dismiss sheet (right panel): title "Dismiss this?"; hint "Optional: tell Moss why, so it gets better."; three radio options with sublabels: "Not something I owe" / "Moss stops flagging mail like this from this sender."; "Already handled" / "Just clears it. Teaches nothing."; "Not now" / "Clears it; comes back if they write again."; buttons Dismiss (primary), Cancel; footer "Tapping Dismiss without a reason just clears it." Posts `{ reason }` or `{}`.

Use the dialog/sheet primitive already used by `task-details-dialog.tsx`.

- [ ] Failing tests (draft loads into textarea; Send asks to confirm then posts `mode: "send"`; Save posts `mode: "draft"`; Dismiss with no selection posts `{}`; with "Not something I owe" posts `{ reason: "not_owed" }`); run; implement; run; audit; commit `feat(web): reply and dismiss sheets for owed items`.

### Task 12: App map and manifest metadata

**Files:**
- Modify: `packages/shared/src/app-map-core.ts` (Today description: add "and a 'You owe people' card listing email threads Moss judged you owe a reply or step on, each with Draft reply, Make task, Snooze and Dismiss")
- Modify: `packages/commitments/src/manifest.ts` (`features` entry describing the owed items, their four actions, and the three ways an item closes; the `routes` from Task 5)
- Run: `pnpm -s build:app-map` and the app-map truthfulness check named in `docs/DEVELOPMENT_STANDARDS.md`.
- Commit `docs(app-map): declare the You owe people card and its actions`.

### Task 13: Live proof on dev (slice 2 deliverable)

- [ ] Reconcile dev modules (new migration 0217), restart API and web.
- [ ] Log in at the dev URL, open Today, confirm the card shows the slice 1 items with rows collapsed; tap one; screenshot to disk and view a cropped region only.
- [ ] Exercise each action once on real items: Draft reply → Save as Gmail draft (check the draft exists in Gmail and the item left the card); Make task (task appears in Tasks, item stays with "Task made"); complete that task in Tasks, run a sync, confirm the item closed with `resolved_by = 'task_done'`; Snooze to tomorrow (item moves to "older"); Dismiss with no reason (item gone, status rejected).
- [ ] Reply to one open thread from Gmail itself, trigger a sync, confirm the item closed with `user_replied_in_mail`.
- [ ] Post the results with cropped screenshots on the PR as "Slice 2 live proof".
