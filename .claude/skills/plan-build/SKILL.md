---
name: plan-build
description: How to write an implementation plan in this repo — seams check before planning, ranking design forks, decisions not implementation code, determinism boundary, kill gates, and unpiped verification. Use when writing or reviewing any implementation plan, build plan, or phased delivery plan, when ranking the options on a design fork, and before starting a milestone or module build. Overrides superpowers:writing-plans, whose "complete code in every step" rule is wrong here.
---

# Writing a build plan

This overrides `superpowers:writing-plans`. That skill mandates complete implementation code in
every step; in this repo that rule produced a review loop with no floor. User instruction beats
skill.

Every rule below is here because it cost a real build. The evidence is cited — keep it, because a
rule without its scar gets argued away.

## 0. Gates before you write anything

- An approved design spec in `docs/superpowers/specs/`. Hard process gate.
- A GitHub `task` issue (`Part of #N`). Hard rule — both gates, not either.
- **For a new module: agreed front-end mockups of every screen, in that spec.** Settled with Ben
  before the plan, naming which `jds-*` primitives each screen is built from and what it shows when
  empty, loading and broken. Food shipped Phase 1 applying zero host classes and rendered as
  unstyled text; the code was correct, nobody had ever decided what the screen should look like.

## 1. Seams check — do this BEFORE the plan, not during review

Enumerate every platform capability the plan assumes exists, and prove each one with a
`file:line` citation from the current tree. Anything you cannot cite is an assumption, and it goes
in the plan as an open question with a named owner, not as a step.

**Why:** the `external-module-platform-seams` memory — a worker handler cannot enqueue anything,
external modules cannot contribute to briefings at all, the manifest validator silently drops
unknown top-level keys, there is no notification port — is dated 2026-07-26. It was produced while
adversarially reviewing the *rebuild* plan, which is to say **after** nineteen UAT rounds had
already run into those walls. The facts took one review pass to establish. Getting them one build
earlier is the highest-leverage thing in this document.

Start from the existing memories (`external-module-platform-seams`, `manifest-hash-kills-module-queues`,
`module-ui-needs-tool-result-allowlist`) rather than re-deriving them, then verify anything they
don't cover. Use the `codebase-memory` skill for structure queries.

Grep for existing machinery before calling anything net-new — "big changes" here are routinely
already half-built.

### Ranking a design fork

Verify before you rank. Read the files each option touches — give the one you lean *against* equal
depth — and steelman the option you'd reject. On milestone-level forks an adversarial second
opinion is valuable but never a gate: `/grill-me-codex`, else an independent critic subagent.

## 2. Plans carry decisions, not implementations

**Keep** — these are decisions, cheap to review, and they stay true:

- task boundaries, numbering, and ordering
- exact file paths
- exported **type and function signatures**
- manifest JSON
- SQL DDL (migrations are hash-checked — the DDL is a decision, not an implementation)
- test cases stated as **behaviour plus why they would fail against a broken implementation**
- verification commands with expected exit codes

**Cut** — function bodies, and any illustrative code that is not a contract. The code gets written
against a real compiler.

**Why:** the Job Search plan pre-wrote roughly 6,000 lines of real implementation. Six adversarial
review rounds ran 5 → 4 → 4 → 6 blockers and never converged. The findings were genuine each time
and mostly *new* surface, not regressions — every wholesale rewrite of a task created fresh code
for the next round to attack. A reviewer cannot retire surface faster than a rewrite creates it, so
the loop has no floor.

Length is not the metric; kind is. A long plan made of contracts is fine. A short plan made of
function bodies is not.

## 3. The determinism boundary

State it explicitly in every plan that touches a user-facing surface:

- Every piece of UI feedback — greeting, save acknowledgement, apply confirmation, progress —
  renders **from the record**, never from model output.
- A module never injects turns into the host chat.
- The model gets exactly two jobs, named in the plan. Guidance over **150 words** means the design
  is wrong; fix the design, do not extend the prompt.
- Model-authored values crossing into user data need all four guards: schema field descriptions,
  a prompt contract with a worked example, a boundary validator, and per-item before/after diff
  acceptance.

**Why:** nineteen UAT rounds were one architectural mistake in different clothes — deterministic
feedback routed through a non-deterministic model turn. The proof: a résumé apply succeeded in the
database at 03:53:58 with three revisions, then chat said nothing for 66 seconds until Ben asked
"What is next?". Second symptom: `assistantOnboarding.guidance` grew from 29 words to 620, one
sentence per UAT round, until the manifest test was ~15 substring assertions against an English
paragraph. Patching the prompt each round hid the design defect instead of fixing it.

## 4. Every phase ships with an e2e test executed and observed to pass

Written is not shipped. Run it, watch it pass, record the output. For any UI/UX feature this means
a Playwright test on a real dev instance — that is an exit criterion, not a nice-to-have.

A new prop can pass its own unit test while no production caller ever passes it. Assert through the
wiring and grep for a real caller. See the `wired-not-just-defined` memory.

## 5. Verification commands are never piped

Every verification command in a plan is written so the exit code survives:

```bash
pnpm verify:foundation > /tmp/vf.log 2>&1; echo "EXIT=$?"
```

Never `| tail`, `| head`, or `| tee` — a pipeline reports the last command's status, so the gate
exits 0 even when it failed. Measured over three weeks: 682 of 1,560 gate runs in this repo (44%)
could not have reported a failure. `.claude/hooks/check-gate-pipe.sh` now blocks these, but a plan
that *specifies* a piped command teaches the wrong habit before the hook ever fires.

State the expected exit code next to each command.

## 6. Kill gate after phase 1

Name, in the plan, the observation that would end the line — and who makes the call. Phase 1 ships
alone and is evaluated before phase 2 is planned in detail.

**Why:** Job Search reached `main` across 23 PRs and 79,961 lines before being cancelled outright —
roughly a quarter of everything changed in that three-week window, deleted. Planning further ahead
than the first shipped phase is how that much work accumulates before anyone can judge it.

## 7. Rulings ledger

Keep every review round's output, even after the code it critiqued is deleted. Extract each finding
that is a **fact about the tree** or a **decision taken** into a ledger with `file:line` evidence —
including findings judged invalid, so nobody re-derives them. Plans die; the facts they uncovered
should not.

## Review checklist

Before calling a plan ready:

- [ ] Spec approved and task issue open
- [ ] Every assumed platform capability cited `file:line`, or listed as an open question
- [ ] No function bodies — signatures, DDL, manifest JSON and test cases only
- [ ] Determinism boundary stated; guidance budget under 150 words
- [ ] Each phase names its e2e test
- [ ] Every verification command unpiped, with an expected exit code
- [ ] Kill gate named, with an owner
- [ ] Steelmanned the option you rejected; for a milestone fork, got an adversarial second opinion
