# Role-marker fencing follow-ups

**Date:** 2026-08-10

**Status:** Approved by Ben's Fable delegate on 2026-08-10; post-#1259/#1260 re-grounding remains mandatory

**Roll-up issue:** #1488

**Origin:** #1136 and merged PR #1484

**Draft grounded on:** `origin/main` = `ba1acd70a`, issue #1488, and PR #1484's original security QA,
ReDoS remediation, re-verification, and delegated sign-off

**Pre-build grounding gate:** after #1259/#1260 and every other prompt-safety PR merge, update this
field to the resulting `origin/main` commit and re-verify the owned files and caller inventory before
dispatch

## Decision summary

Strengthen the existing `neutralizeSeedFraming` choke point; do not add a second sanitizer or move
the policy into its callers. Recognition remains line-leading and case-insensitive, but expands in
three controlled ways:

1. recognize the exact canonical role set `user`, `assistant`, `system`, `human`, `ai`, `moss`,
   `developer`, `tool`, `function`, and `model`;
2. accept Unicode horizontal-space and a small explicit set of zero-width characters around or
   inside a candidate marker; and
3. normalize only the captured candidate role token and colon, never the full recalled text.

The successful replacement remains a bracketed literal such as `[Moss]:`. That output is not a
claim that prompt injection has become impossible: `[User]:` can still carry transcript semantics
for a model. The surrounding untrusted-data notices and seed blocks remain the primary trust
boundary; marker rewriting is defense in depth.

Security wins the syntax-fidelity fork. A line-leading `user: root` in YAML, `- user: alice` in a
list, `## AI` in Markdown, or `System:` inside a fenced code sample remains eligible for rewriting.
Those syntaxes are attacker-controlled content, not evidence of trust, and exempting them would
re-open the same bypass. The mutation is limited to the marker token and colon; all other bytes on
the line remain intact.

#1488 remains a roll-up and does not receive an implementation PR directly. After approval and the
pre-build grounding gate, create the single child `task` issue defined below. Its three focused files
form one prompt-safety surface and fit one build session.

## Current-state grounding

At the draft baseline, `origin/main` `ba1acd70a`, `neutralizeSeedFraming` first rewrites reserved
XML-style seed tags, then runs two line-anchored role-marker regexes. Both recognize only
`user|assistant|system|human|ai`, ASCII space/tab prefixes, and an ASCII colon. The ReDoS fix from
PR #1484 is present: decoration matches one character per repetition, so a decoration run has an
unambiguous, linear partition.

#1260 changes this same function and `tests/unit/chat-recall-seed.test.ts`, including an outer
module-control-token downgrade fixpoint. That work must be on `main` before this child is planned.
The post-merge re-grounding must preserve #1260's behavior and update any stale line-level
description here; this task does not redesign or linearize that inherited fixpoint.

The codebase graph found the shared function and its older inbound paths. An `origin/main` tree
search adds the newer Codex calls that the graph index has not yet captured. The complete production
caller inventory is:

| Caller                                           | Untrusted values neutralized before trusted framing is added |
| ------------------------------------------------ | ------------------------------------------------------------ |
| `packages/chat/src/live/recall-seed.ts`          | recalled chunk text and extracted fact content               |
| `packages/chat/src/live/chat-context-blocks.ts`  | replayed user/assistant bodies and rolling summary           |
| `packages/chat/src/live/codex-exec-session.ts`   | prior user/assistant bodies and the current user turn        |
| `packages/chat/src/live/cross-tool-reasoning.ts` | cross-tool item summary and source label                     |
| `packages/chat/src/live/passive-retrieval.ts`    | memory text and memory source label                          |

There is no caller-specific exception to preserve. All five paths cross an untrusted-text boundary,
and all already depend on the same exported function. No signature or import changes are needed.

`packages/chat/src/jobs.ts` deliberately persists embedded chat chunks as
`User: ...\nAssistant: ...`. Those labels are already present before recall and therefore are
correctly rewritten when the stored chunk later passes through `renderMemorySeedBlock`. The current
comment claiming all codebase-emitted framing is added after neutralization is false. The build
must correct the comment and pin the actual stored-chunk behavior; it must not change the job's
storage format, re-embed old chunks, or migrate data.

## Threat model

The attacker controls text that later enters a seed or the Codex transcript through chat history,
memory recall, summaries, notes, email, calendar, tasks, or another module. The attack succeeds
when a line resembles a new model/persona role strongly enough to be interpreted as trusted turn
framing.

This issue is defense in depth. Codex remains read-only with approvals and shell/apply-patch tools
disabled, and the seed/cross-tool wrappers continue to tell the model that enclosed content is data,
not instructions. This work reduces common framing ambiguity; it cannot make arbitrary natural
language non-instructional.

## Goals

- Close the verified NBSP, ZWSP, BOM, form-feed, vertical-tab, full-width-role, and Unicode-colon
  bypasses without normalizing unrelated recalled content.
- Cover Moss's actual default assistant name and the role words used by current model/tool
  transcript conventions.
- Preserve the linear-time, two-pass role-marker stage established by the PR #1484 ReDoS fix; do
  not broaden that claim to #1260's inherited outer fixpoint.
- Record and test the intentional fidelity tradeoff for YAML, Markdown, and fenced code.
- Correct the stored `User:`/`Assistant:` framing explanation without changing stored data.
- Add composed-path evidence for recalled-memory and cross-tool-summary rendering rather than
  relying only on a direct helper test.
- Keep the implementation dependency-free and private to the existing prompt-safety module.

## Non-goals

- No whole-string Unicode normalization, transliteration, or general confusable/homoglyph table.
- No mapping of Cyrillic, Greek, Armenian, or other script letters to Latin lookalikes. For example,
  Cyrillic `е` in `Usеr:` remains a named residual risk.
- No dynamic matching of every user-configured `assistantName`. `moss` is approved because it is
  the product default; arbitrary persona names would turn ordinary line-leading names into markers
  and require runtime policy plumbing through every caller.
- No ChatML `<|im_start|>`, Llama `[INST]`, or provider-specific token protocol filter. They are not
  role words, the supported prompts do not emit those protocols, and adding speculative protocol
  parsers would be a separate threat model.
- No Markdown, YAML, programming-language, or code-fence parser.
- No sanitizer API split, new package, dependency, feature flag, database change, re-embedding, or
  migration.
- No promise that a model will never infer instruction semantics from `[User]:` or prose.

## Locked matching contract

### Exact role vocabulary

After candidate-only canonicalization, the allowlist is exactly:

| Canonical token                              | Why it is included                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------------- |
| `user`, `assistant`, `system`, `human`, `ai` | existing supported transcript/persona markers                                 |
| `moss`                                       | the product's default `assistantName` in `packages/shared/src/persona-api.ts` |
| `developer`                                  | a first-class instruction role in the OpenAI/Codex model family               |
| `tool`, `function`, `model`                  | common tool/model transcript labels that can imitate a new trusted turn       |

Do not add synonyms such as `agent`, `bot`, `context`, arbitrary persona names, or provider names
without a new finding and spec ruling. A fixed module-level `Set` or equivalent literal check is
enough; there is no public role-policy abstraction.

### Candidate grammar

A candidate must begin at the start of the string or a line. Preserve the existing two forms:

- **colon form:** optional horizontal prefix/decoration, approved role token, optional horizontal
  gap, approved colon;
- **colon-less header form:** one or more existing Markdown/blockquote/list decoration characters,
  approved role token, optional horizontal gap, then end of line/string.

The existing decoration alphabet stays exactly `[>\-*#]`. It may repeat or nest. Each repetition
must consume exactly one decoration character; never restore an inner `+` or another ambiguous
quantifier beneath the repeating group.

Define these exact code-point sets for both regexes:

- **`Z` (zero width):** ZWSP (`U+200B`), ZWNJ (`U+200C`), ZWJ (`U+200D`), WORD JOINER
  (`U+2060`), and BOM/ZWNBSP (`U+FEFF`);
- **`HV` (visible horizontal):** ASCII space, tab, vertical tab (`U+000B`), form feed (`U+000C`),
  and Unicode `General_Category=Space_Separator` (`\p{Zs}`), including NBSP (`U+00A0`);
- **`H` (all horizontal):** `HV` or `Z`;
- **`D` (decoration):** exactly `[>\-*#]`;
- **`C` (colon):** exactly the six approved colon code points below; and
- **`V` (visible candidate-token code point):** any Unicode code point except CR, LF, a member of
  `H`, `D`, or `C`.

Use Unicode mode. The raw candidate role-token grammar is exactly `V (Z* V)*`: it starts and ends
with a visible code point, and zero-width characters may occur only between visible token code
points. A zero-width run before the first `V` belongs to the prefix; a run after the last `V`
belongs to the gap. No `HV` character may occur inside a token, so `U ser:` stays unchanged.

Express the two line-leading forms in terms of those sets:

- **colon form:** `H* (D H*)*`, then the raw token, then `H* C`;
- **colon-less header form:** `H* (D H*)+`, then the raw token, then `H*`, then end of line/string.

For the header form, do not consume CR or LF; preserve either LF or CRLF byte-for-byte. Because `V`
is disjoint from `H`, `D`, and `C`, and `Z` is disjoint from `V`, every repeated run has one
partition. Do not widen `V` or move `Z` to a leading/trailing token position without a new security
and complexity review.

On a successful allowlist match, remove `Z` characters from the matched prefix, gap, and token. On a
syntactic candidate whose canonical token is not approved, return the complete original match
byte-for-byte.

The colon alphabet is exactly ASCII COLON (`U+003A`), MODIFIER LETTER TRIANGULAR COLON (`U+02D0`),
RATIO (`U+2236`), MODIFIER LETTER COLON (`U+A789`), SMALL COLON (`U+FE55`), and FULLWIDTH COLON
(`U+FF1A`). A successful replacement emits ASCII `:`. Other colon-like punctuation remains a named
residual rather than opening the matcher to every Unicode punctuation character.

The colon gap must be horizontal only. Do not use `\s*` where it can consume a newline and join a
role on one line to a colon on another.

### Scoped canonicalization

For a syntactic candidate only:

1. remove the explicit zero-width characters from the captured role token;
2. apply JavaScript's built-in `String.prototype.normalize("NFKC")` to that token;
3. compare its lowercase form with the exact allowlist; and
4. normalize an approved captured colon to ASCII `:` in the successful replacement.

NFKC is deliberately scoped to the short candidate token. It closes full-width and other
compatibility-form spellings such as `Ｕser` without changing quotes, units, ligatures, identifiers,
or prose elsewhere in recalled content. Do not call `.normalize()` on `text`, a full line, a seed
block, or a caller's source value.

Preserve the candidate's NFKC-normalized visible casing inside brackets (`Ｕser` becomes `[User]`,
`MOSS` becomes `[MOSS]`). Preserve all non-zero-width prefix decoration and spacing and all text
after the colon byte-for-byte. Already neutralized `[User]:` is unchanged and remains idempotent.

### Fidelity ruling

Do not exempt syntactically valid YAML, Markdown, or fenced code. Specifically, these remain
intentional rewrites:

```text
user: root       -> [user]: root
- user: alice    -> - [user]: alice
## AI            -> ## [AI]
```

The same applies between triple backticks. A code fence or YAML key can be supplied by an attacker,
and models routinely follow instructions presented as examples. Parsing surface syntax would add
state and dependencies without producing a trustworthy exemption. Tests must record this cost so a
future fidelity change requires an explicit security decision rather than an accidental regex edit.

### Stored chat framing and residual risk

When a chat embedding chunk containing `User: hello\nAssistant: hi` is recalled, the expected seed
contains `[User]: hello\n[Assistant]: hi`. This is intentional: once persisted inside a memory
chunk, those labels are data, not the fresh trusted framing added by `renderReplayBlock` or
`CodexExecSession.buildPrompt` after neutralization.

`[User]:` remains semantically recognizable to some models. Keep it for consistency with reserved
tag rewriting and because replacing it with another readable label only moves the ambiguity. The
security claim is therefore: **raw approved role markers in the covered line-leading forms are
consistently converted to bracketed data literals before trusted framing is assembled.** It is not:
**the bracketed literal can never influence a model.**

## Implementation shape

Keep all production changes in `packages/chat/src/live/prompt-safety.ts`:

- retain the reserved-tag pass and exported `neutralizeSeedFraming(text: string): string` signature;
- extend the two existing role-marker passes with one private candidate-canonicalization callback
  and the fixed allowlist;
- use built-in regex Unicode property escapes and `String.prototype.normalize`; and
- replace the inaccurate emitted-framing comment with the stored-versus-fresh distinction and the
  residual-risk statement above.

Do not touch any caller. The existing choke point is already correctly placed, and caller-specific
guards would duplicate policy and leave sibling paths inconsistent.

The role-marker stage must remain exactly two `O(n)` passes over input code units. Candidate
normalization may allocate only for syntactic candidate matches. The disjoint grammar above must be
visible in the regex/control flow, and no repeated group may contain an ambiguous repeated
decoration run. `neutralizeSeedFraming` also inherits #1260's outer module-control-token downgrade
fixpoint; its input-dependent pass count and complexity are outside this child. Do not modify it or
claim that the full function is constant-pass as part of this work.

## Required verification matrix

The core test must prove all of the following through `neutralizeSeedFraming`:

| Class                  | Required fixtures                                                                                                                                                                                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing roles         | table-driven coverage of all `User`, `Assistant`, `System`, `Human`, `AI`                                                                                                                                                                                                                                             |
| New roles              | table-driven coverage of all `Moss`, `Developer`, `Tool`, `Function`, `Model`                                                                                                                                                                                                                                         |
| Horizontal prefix      | table-driven coverage of tab, vertical tab, form feed, NBSP, a non-NBSP `\p{Zs}` such as EM SPACE (`U+2003`), and every member of `Z` before a role                                                                                                                                                                   |
| Zero-width token       | table-driven coverage of every member of `Z` between visible letters of an approved role                                                                                                                                                                                                                              |
| Horizontal colon gap   | table-driven coverage of NBSP, EM SPACE, and every member of `Z` between an approved role and colon                                                                                                                                                                                                                   |
| Successful removal     | for every member of `Z`, successful prefix/token/gap fixtures contain no copy of that code point while preserving all `HV`, decoration, and payload bytes                                                                                                                                                             |
| Colon compatibility    | table-driven coverage of each of `:`, `ː`, `∶`, `꞉`, `﹕`, `：`                                                                                                                                                                                                                                                       |
| Header form            | decorated colon-less `### Ｓystem`, a nested blockquote form, zero-width header gaps, and byte-identical LF/CRLF endings                                                                                                                                                                                              |
| Non-matches            | inline `ask the user:`, inline new-vocabulary case `the tool: X`, `customer:`, `U ser:`, Cyrillic-homoglyph `Usеr:`, unrelated Unicode prose, and `User\n:` plus `User\r\n:` proving that a colon cannot be joined across a line and that the original newline bytes survive                                          |
| Idempotence            | `[User]:` stays byte-identical on one and repeated calls                                                                                                                                                                                                                                                              |
| Fidelity ruling        | YAML, Markdown heading/list, and fenced-code examples are intentionally rewritten                                                                                                                                                                                                                                     |
| Stored framing         | a rendered recalled chunk rewrites its persisted `User:`/`Assistant:` labels while retaining exactly one trusted `<memory>` opening and closing tag                                                                                                                                                                   |
| Known ReDoS regression | long decoration, Unicode-space, zero-width, and near-miss runs—including a failed role after a long prefix—finish within the existing wide non-flaky budget and preserve expected output; this is a regression guard, not standalone proof of asymptotic complexity, which remains a structural-review responsibility |

The composed cross-tool test must construct a real `CrossToolEvidenceItem`, place a disguised marker
in both `summary` and `sourceLabel`, call `renderCrossToolContextBlock`, and assert that the item line
contains only bracketed canonical markers while the renderer's one trusted opening and closing
`<cross_tool_context>` tags remain intact. A test that calls `neutralizeSeedFraming` directly does not
satisfy this criterion.

Run the narrow files with root Vitest commands; do not use the nonexistent `@moss/chat` package
`test` script that produced a false green in PR #1484. The build plan must discover the current
repo-prescribed lint/typecheck commands rather than copying stale counts from this spec.

## Child task

### Unicode-safe role vocabulary and composed renderer contracts

**Type/tier:** `task`, security

**Depends on:** approved spec; #1259/#1260 merged; every other prompt-safety PR merged; this spec
re-grounded on the resulting `origin/main` commit

**Owned files:**

- `packages/chat/src/live/prompt-safety.ts`
- `tests/unit/chat-recall-seed.test.ts`
- `tests/unit/chat-cross-tool-reasoning.test.ts`

**Build scope:** implement the locked matching contract, correct the source comment, add the direct
matrix, and add the composed recalled-memory/stored-framing and cross-tool renderer assertions. The
cross-tool test must construct a real `CrossToolEvidenceItem` with Unicode-disguised markers in both
`summary` and `sourceLabel`, call `renderCrossToolContextBlock`, and inspect the rendered item line.
Do not edit callers or add a new helper module.

**Acceptance:** every required core fixture passes; non-matches are byte-identical; the persisted
`User:`/`Assistant:` example is bracketed through `renderMemorySeedBlock`; existing delimiter tests
remain green; the cross-tool item line contains only bracketed canonical markers while exactly one
trusted opening and closing `<cross_tool_context>` tag remain; and the long-run fixtures guard the
known catastrophic-backtracking regression within a wide, non-flaky budget.

**Independent adversarial QA:**

- inspect the actual regex/control flow against the locked disjoint grammar and confirm the two
  role-marker passes are linear, without attributing #1260's outer fixpoint complexity to this child;
- time long decoration, Unicode-space, zero-width, and almost-role inputs, including a failed role
  after a long prefix;
- verify full-width compatibility forms close while Cyrillic `е` and unapproved roles do not;
- verify arbitrary non-matching Unicode is byte-identical and repeated neutralization is
  idempotent; and
- run the cross-tool composed test against the pre-change implementation in an isolated worktree and
  observe the expected Unicode-marker failure, then run it against the child result and observe
  green; verify the assertion examines the rendered item line rather than passing because of the
  trusted footer; and
- confirm no dependency, public API, caller, #1260 behavior, job storage, or data format changed.

## Dependency, batching, and roll-up closure

The coordinator may dispatch the child in the first follow-up wave that has a security QA slot after
all dependencies and the pre-build grounding gate clear. #1488 closes only when the child is merged,
its independent QA is green, and the roll-up links the child PR and its verification evidence.

## Parent acceptance criteria

- [ ] #1488 remains the roll-up; one child `task` issue links back to it and owns the three focused
      files named above.
- [ ] The exact ten-role vocabulary and candidate-scoped Unicode contract are implemented at the
      existing choke point with no new dependency or public abstraction.
- [ ] The verified Unicode prefix/token/colon bypasses are closed, and explicit non-goals remain
      byte-identical.
- [ ] The two role-marker passes retain their linear structure and the known catastrophic-backtracking
      regression remains closed under adversarial long-run and near-miss inputs.
- [ ] YAML/Markdown/code mutation, persisted chat framing, and `[User]:` residual semantics match
      the rulings in this spec.
- [ ] Recalled-memory and cross-tool-summary paths have composed tests through their public
      renderers.
- [ ] Every pre-existing caller continues to use `neutralizeSeedFraming`; no caller-specific policy
      forks are introduced.

## Hard invariants and process gates

- **Secrets/private data:** this is an in-memory pure-string transform; no content may be logged,
  persisted anew, placed in a job payload, or included in verification output beyond synthetic
  fixtures.
- **Provider-agnostic AI:** the role vocabulary is a shared prompt-safety policy, not a provider or
  model-name branch.
- **Module isolation:** all production work remains internal to `packages/chat` and uses its existing
  public renderers in tests.
- **Database, RLS, VaultContext, migrations, AccessContext:** untouched.
- **Live-Path Gate:** no user-facing surface changes. Record this as not applicable on each PR, with
  unit and adversarial prompt-construction evidence instead.
- **Security review:** the child requires independent adversarial security QA, including composed-path
  review and evidence that the cross-tool test red-fails before the matcher change.
- **Documentation paths:** any build handoff uses `~/Jarv1s`, never a machine-specific absolute path.
