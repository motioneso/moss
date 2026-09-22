# Sorting model fit audit

Date: 2026-09-22. Read-only survey of every place Moss calls a language model, graded for
whether a small, fast, non-reasoning "sorting model" (TypeSafe Jev, Cactus Needle) could do the
job. Embeddings are out of scope.

## Grades at a glance

| Grade   | Count |
| ------- | ----- |
| Strong  | 7     |
| Partial | 6     |
| Poor    | 10    |

Strong means the model answers a closed question (category, yes/no, fields, filters) and Moss's
own code makes the decision. Partial means the job splits: part is a sorting job, part needs
judgment or free text. Poor means prose, world knowledge, multi-step reasoning or open chat.

## How calls reach a model today

- Two roads exist. The structured road (`packages/ai/src/structured/generate-structured.ts:122`)
  picks a model per service with a tier hint (default "economy") and validates a JSON schema.
  The raw road calls a provider adapter's `generateChat` directly and parses text by hand.
- On the structured road: news, sports, story relevance, email triage, external modules.
- On the raw road: commitments, task search, memory distillation, briefings, persona preview.
  These would need moving to the structured road (or given their own model lookup) before a
  sorting model setting reaches them.
- Task search uses the user's main chat model; commitments, memory and briefings ask for the
  "summarization" capability at economy tier.
- External modules reach the structured road through `packages/module-sdk/src/worker.ts:126`
  with an optional tier hint (reasoning / interactive / economy). A fourth "sorting" hint would
  let modules opt in without naming a model.

## Inventory

| Feature                                           | File:line                                                                                                  | What the model is asked                                                                                 | Answer shape                                                          | Fit     | Reason                                                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------- |
| Email triage: category and sign-in code           | packages/connectors/src/email-extract.ts:319 (prompt), packages/connectors/src/extract-deps.ts:93 (call)   | Which of 7 buckets is this email; does it hand over a sign-in code                                      | enum + confidence + boolean                                           | Strong  | Fixed categories and a yes/no; code stores and acts on the label                                   |
| Email triage: due date, action, reason            | same as above                                                                                              | When is the user's reply owed; one-line action and reason                                               | ISO date + two short strings                                          | Partial | Field pull fits, but the due-date rule needs reasoning about relative dates and what is owed       |
| Story relevance matcher (News and Sports)         | packages/usefulness-feedback/src/relevance/evaluator.ts:85                                                 | For each story, does it match a saved "more/less like this" rule, and which closed evidence codes apply | per story: boolean, rule id, two enum lists                           | Strong  | Match against a saved rule; the file says outright the model never decides, code does              |
| News source safety check                          | packages/news/src/discovery/policy-validation.ts:71                                                        | Is this domain a legitimate, lawful news publisher                                                      | boolean + 2-value enum                                                | Strong  | Yes/no on short data; see caveat below                                                             |
| News topic safety check                           | packages/news/src/discovery/policy-validation.ts:103                                                       | Is this topic a legitimate, lawful news topic                                                           | boolean + 2-value enum                                                | Strong  | Yes/no on a label and a sentence; same caveat                                                      |
| Commitment finder                                 | packages/commitments/src/extractor.ts:35 (prompt), packages/commitments/src/workers.ts:93 (call)           | List promises, deadlines, obligations in a text excerpt                                                 | array of kind enum, title, date, counterparty, quote, confidence enum | Strong  | Pull typed fields out of text; runs only after a phrase filter says yes                            |
| Task search to filters                            | packages/tasks/src/search-interpret.ts:17 (prompt), packages/tasks/src/search-interpret-route.ts:88 (call) | Turn "overdue work tasks tagged urgent" into a filter object                                            | fixed JSON of enums, list ids, tag names, date range                  | Strong  | Request to search filters; code checks ids and tags against real ones                              |
| Finance transaction categories (external module)  | external-modules/finance/src/worker/ai-port.ts:14                                                          | Map each transaction id to one of the user's category ids                                               | object of id to enum                                                  | Strong  | Pick-one from a short list; omissions are allowed and code validates ids                           |
| News story ranking                                | packages/news/src/compilation/rank.ts:97                                                                   | Score up to 300 candidates 0-100 for relevance and newsworthiness, mark eligible                        | array of id, integer, boolean                                         | Partial | Per-item score against topics fits; "newsworthiness" across many items needs world knowledge       |
| Sports source: map targets to a known recipe      | packages/sports/src/source/discovery.ts:393 (fixed-recipe branch)                                          | Fill each team or league's URL parameters from page evidence                                            | array of key + parameters                                             | Partial | Argument filling suits Needle, but evidence is large raw page data                                 |
| Memory from a chat turn                           | packages/chat/src/jobs.ts:251, packages/chat/src/memory-distillation.ts:97                                 | Pull durable facts from one exchange; flag which old facts they replace                                 | array of typed memory candidates                                      | Partial | Field pull fits; deciding what is durable and what it supersedes is judgment                       |
| Job postings from a custom page (external module) | external-modules/job-search/src/adapters/custom.ts:303                                                     | Extract every posting on a fetched job-board page                                                       | array of title, company, location, url, body, date                    | Partial | Field pull, but pages are long and the body field is long copied text                              |
| Workshop draft-change check                       | packages/ai/src/module-build/classify-draft-change.ts:32                                                   | Rewrites the whole plan, then code compares "what it reaches" lists                                     | (reuses plan writer)                                                  | Partial | The real question is yes/no ("does this reach a new outside service?"); no production caller found |
| Sports source: derive a new recipe                | packages/sports/src/source/discovery.ts:393 (no-recipe branch)                                             | Work out how to scrape a publisher's listing from evidence                                              | nested recipe object                                                  | Poor    | Multi-step inference over page structure                                                           |
| Morning briefing                                  | packages/briefings/src/compose.ts:474 -> compose-shared.ts:579                                             | Write the morning briefing                                                                              | prose                                                                 | Poor    | Writes prose                                                                                       |
| Evening briefing                                  | packages/briefings/src/compose-evening.ts:487 -> compose-shared.ts:579                                     | Write the evening briefing                                                                              | prose                                                                 | Poor    | Writes prose                                                                                       |
| Persona preview                                   | packages/module-registry/src/built-in-module-helpers.ts:157                                                | Sample two-sentence check-in in the chosen persona                                                      | prose                                                                 | Poor    | Writes prose, and must show the main model's voice                                                 |
| Web search through the model                      | packages/module-registry/src/index.ts:921, packages/web-research/src/providers.ts:154                      | Search the web with the provider's search tool                                                          | results list with citations                                           | Poor    | Needs the main model's built-in search tool                                                        |
| Workshop build plan                               | packages/ai/src/module-build/write-plan.ts:60                                                              | Describe a module plan in five plain lines                                                              | five short prose fields                                               | Poor    | Writes prose and estimates cost                                                                    |
| Workshop build agent                              | apps/worker/src/worker.ts:255                                                                              | Build a module in a live coding session                                                                 | agent session                                                         | Poor    | Multi-step agent work                                                                              |
| Main chat (and Workshop chat)                     | packages/chat/src/live/persistence.ts:156                                                                  | Converse and call tools                                                                                 | open chat                                                             | Poor    | Open-ended chat                                                                                    |
| Job fit and want scores (external module)         | external-modules/job-search/src/domain/score.ts:79, worker/stages/score.ts:328                             | Judge a resume against a posting; two scores with reasons                                               | 2 integers, 4-value enum, 2 prose reasons                             | Poor    | Judgment plus written reasons; the dealbreaker part alone would fit (see new uses)                 |
| Meal nutrition estimate (external module)         | external-modules/food/src/estimator/run.ts:78                                                              | Break a meal into foods and estimate nutrients                                                          | items with numeric fields, or a question                              | Poor    | Needs food knowledge, not sorting                                                                  |

Not model calls, despite the names: the email reply approval text (`packages/email/src/tools.ts:226`,
`:233`), the calendar delete and reschedule approval text (`packages/calendar/src/tools.ts:289`,
`:339`), the calendar flags (`packages/connectors/src/source-context/calendar.ts:88`, plain time
math), and the live-email summary (`packages/connectors/src/live-tools.ts:57`, field copying). All
are fixed strings or code.

### Caveat on the news safety checks

Both prompts ask whether use is "permitted by the ACTIVE provider's content and safety policy",
and the saved verdict is keyed to a fingerprint of the model
(`packages/module-registry/src/index.ts:770`). If a sorting model answers, the question should
change to a plain legitimacy check, or the fingerprint must still name the main model. Otherwise
the verdict describes the wrong provider.

## Hand-written rules a sorting model could replace or back up

| Rule                                   | File                                                             | What it does                                                                           | Suggestion                                                                                                            |
| -------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Sign-in code detector                  | packages/connectors/src/email-otp-rule.ts:324                    | About 30 patterns sort mail into "hands over a code", "unclear", "ordinary"            | Keep the rule for the clear cases; the sorting model takes "unclear" (today the main model does, via the triage call) |
| Bulk mail hint                         | packages/connectors/src/email-bulk-rule.ts:35                    | Unsubscribe header or word means "sent to a list"                                      | Keep as a hint; a sorting model could add a real marketing / newsletter / personal label                              |
| Commitment phrase filter               | packages/commitments/src/prefilter.ts:66                         | Runs the finder only if text contains one of ~60 phrases like "by friday", "i'll send" | A yes/no "does this contain a commitment?" catches phrasing the list misses                                           |
| Memory turn gate                       | packages/chat/src/memory-distillation.ts:88                      | Regexes decide whether a chat turn is worth mining for memory                          | Yes/no "does this turn state a durable fact or preference?"                                                           |
| Explicit memory command and correction | packages/chat/src/jobs.ts:616 and the correction check beside it | Regexes spot "remember this" and "that's wrong"                                        | Two yes/no questions, as a backup to the regexes                                                                      |
| Secret-text filter                     | packages/chat/src/memory-distillation.ts:138                     | Regex blocks tokens, passwords, keys from memory                                       | Keep as a hard rule; a model may add a second check but must never replace it                                         |

Leave alone: the News and Sports story weighting (`packages/news/src/ranking.ts:27`,
`packages/sports/src/news-ranking.ts:60`) and the calendar flags. They are exact, cheap and have
no language judgment in them.

## New uses that would be natural

- Marketing and newsletter filter. One cheap question per email ("personal, transactional,
  marketing, newsletter, social?") before full triage, so noise never costs a main-model call.
- Workshop draft-change check as a direct yes/no ("does this request reach an outside service
  the plan does not name?") instead of rewriting the whole plan.
- Job dealbreaker check. Split out of the fit score: "does this posting break any of these
  dealbreakers?" as yes/no plus which one.
- Job search criteria from conversation. The schema already exists
  (`external-modules/job-search/src/domain/criteria.ts:36`) but nothing calls it. This is field
  pulling.
- Chat tool pre-routing. Needle picks which module's tools apply to a request, so the main model
  sees a short tool list instead of about 100. Ties to the tool-call discipline work (#2175).
- News topic assignment. Which followed topic a story belongs to, as pick-one, feeding the
  existing ranking.
- Same-story detection. "Are these two headlines about the same event?" as yes/no, which would
  feed the existing cross-publisher evidence code.
- Calendar event labels such as work / personal / travel / health, as pick-one.
- Commitment follow-through. "Does this later message fulfil this open commitment?" as yes/no.

## Strong fits: prompts and answer schemas for the Jev cross-check

Quotes are trimmed; each file:line has the full text.

### 1. Email triage category and sign-in code

File: packages/connectors/src/email-extract.ts:319-367, schema packages/connectors/src/extract-deps.ts:25

Prompt (opening and category rules):

> You are an email triage assistant. Read the email and reply with one JSON object only ...
> Only a real obligation justifies needs_reply, needs_action or time_sensitive_info ... Urgent
> wording is not evidence on its own ... needs_reply: a real person is waiting on the user's
> answer. NEVER use it for marketing, newsletters, receipts, or automated notifications ...
> noise: sales and promotions, ticket releases ..., newsletters and digests ... Mail marked
> "Bulk mail: yes" went to a list ... deliversSignInCode: true only when this message hands the
> recipient a fresh sign-in, verification or two-step code to type in.

Input: Subject, From, Received date, Today, optional "Bulk mail: yes", then body.

Schema:

```json
{ "category": "needs_reply|needs_action|time_sensitive_info|waiting_on_someone|fyi|noise|unknown",
  "confidence": 0.0-1.0, "reason": "string?", "action": "string?", "dueDate": "string?",
  "deliversSignInCode": "boolean?" }
```

For Jev, send only category and deliversSignInCode; due date and action are the Partial half.

### 2. Story relevance matcher

File: packages/usefulness-feedback/src/relevance/evaluator.ts:45, schema packages/shared/src/story-relevance.ts:120-153

Prompt:

> You are matching news or sports stories against a person's saved preferences. For every
> candidate, say whether it matches one of the rules, name the rule by its storyRef, and list
> only evidence codes from the two closed lists in the schema. An event code means something
> consequential genuinely happened. An editorial code means an independent publisher treated it
> as important. Claim nothing you cannot see in the given fields.

Input: rules (storyRef, direction more/less, terms, reason) and candidates (headline, source,
date, feed position, topic/team/competition refs).

Schema per story:

```json
{
  "storyRef": "string",
  "matched": "boolean",
  "ruleStoryRef": "string|null",
  "eventEvidence": [
    "public_safety_threat",
    "terrorism_or_mass_casualty",
    "major_natural_disaster",
    "war_escalation",
    "consequential_civic_event",
    "championship_outcome",
    "historic_record",
    "sports_death_or_crisis"
  ],
  "editorialEvidence": ["source_lead_position", "event_stage_metadata", "cross_publisher_coverage"]
}
```

### 3. News source safety check

File: packages/news/src/discovery/policy-validation.ts:71

> Approve only if this is a legitimate news publisher whose public-news use is lawful,
> appropriate, and permitted by the ACTIVE provider's content and safety policy. Illegal,
> inappropriate, refused, or uncertain content must set allowed=false.

Input: domain, description (300 chars), up to 10 sample headlines.
Schema: `{ "allowed": boolean, "category": "news_publisher" | "other" }`

### 4. News topic safety check

File: packages/news/src/discovery/policy-validation.ts:103

> Approve only if this is a legitimate news TOPIC whose public-news use is lawful, appropriate,
> and permitted by the ACTIVE provider's content and safety policy. Illegal, inappropriate,
> refused, or uncertain content must set allowed=false.

Input: label (80 chars), guidance (1000 chars).
Schema: `{ "allowed": boolean, "category": "news_topic" | "other" }`

### 5. Commitment finder

File: packages/commitments/src/extractor.ts:35

> You are a commitment extraction assistant. Given a text excerpt, identify all explicit
> commitments, deadlines, promises, and obligations. Return a JSON object with a "candidates"
> array ... Return {"candidates":[]} if no commitments found.

Input: source kind, timestamp, text (4000 chars).
Schema per candidate:

```json
{
  "kind": "deadline|promise|obligation|intent",
  "title": "<=100 chars",
  "dueLocalDate": "YYYY-MM-DD|null",
  "counterpartyLabel": "string|null",
  "evidenceExcerpt": "verbatim, <=500 chars",
  "confidence": "high|medium|low"
}
```

### 6. Task search to filters

File: packages/tasks/src/search-interpret.ts:17

> Convert the user's task search phrase into JSON only. ... Known lists: [...] Known tags: [...]
> Today in the user's locale: ... User phrase: "..." Return JSON only. Do not invent task data.

Schema:

```json
{ "text": "string|null", "status": "todo|done|archived|null", "effort": "quick|medium|large|null",
  "priority": "1-5|null", "listIds": ["known id"], "tagNames": ["known tag"],
  "quadrant": "do|schedule|delegate|eliminate|null",
  "due": { "kind": "none|overdue|today|this_week" } | { "kind": "range", "dueAfter": "string|null", "dueBefore": "string|null" } | null }
```

### 7. Finance transaction categories

File: external-modules/finance/src/worker/ai-port.ts:14

> Assign a budget category to each personal bank transaction below. Valid category ids: ...
> Respond with a JSON object mapping each transaction id to one category id. Omit any
> transaction you are not confident about.

Input: transactions as id, payee, amount, date only.
Schema: `{ "<txId>": "<one of the category ids>" }`, extra keys allowed, values limited to the ids.

## Jev cross-check (2026-09-22)

Each inventory row's feature, question and answer shape went to `jev-latest` (TypeSafe System One)
with a strong/partial/poor choice and a yes/no "could a small model do this well?". The audit's own
grade and reason were withheld. 23 calls, 11,444 input tokens, $0.0005.

| Result              | Count                              |
| ------------------- | ---------------------------------- |
| Agreed              | 18 of 23                           |
| Poor fits agreed    | 10 of 10, most at 0.94+ confidence |
| Strong fits agreed  | 6 of 7, confidence 0.15 to 0.98    |
| Partial fits agreed | 2 of 6                             |

Disagreements:

| Feature                            | Audit   | Jev            | Why                                                          |
| ---------------------------------- | ------- | -------------- | ------------------------------------------------------------ |
| News source safety check           | Strong  | Partial (0.15) | Low confidence; near the line                                |
| News story ranking                 | Partial | Poor           | Defensible either way                                        |
| Sports source: map to known recipe | Partial | Strong         | Jev never saw that the input is large raw page data          |
| Job postings from a custom page    | Partial | Strong         | Same; Jev never saw that pages are long                      |
| Workshop draft-change check        | Partial | Poor           | Jev graded the current prompt, which rewrites the whole plan |

Findings:

- Jev separates clear fits from clear misfits reliably. It pushes middle cases to an extreme, and
  it misses anything not stated in the short description it is given.
- The yes/no answer never rose above 0.51 even for rows Jev itself graded strong. The wording
  ("no reasoning or writing ability") likely biased it; do not use that question as a gate.
- Script: `/tmp/jev-audit/crosscheck.py` (reuses `~/jev-referee-trial/jev.py`). Raw answers:
  `/tmp/jev-audit/results.json`.
