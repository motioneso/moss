# Original native token-accounting validation

**Revision note:** this preserves the first three-provider calculation. Gemini’s original “unavailable” status below is superseded by [recovered native usage](gemini-accounting.md); the revised main report totals 1,330,822,205. The formulas and original subtotals remain valid.

Interval: **2026-09-06 15:55:00 UTC through 2026-09-10 05:05:15.981 UTC**, inclusive. These are recorded model tokens, **not dollars, unique information, productive work, or an invoice**. Cache reads count every time the model processes cached context.

## Corrected measured totals

| Provider | ACP response usage sum | Direct room-associated native sessions | Traceable descendants | Native combined |
|---|---:|---:|---:|---:|
| Claude | 379,746,102 | 410,715,157 | 51,631,833 | **462,346,990** |
| Codex | 17,252,088 | 470,022,005 | 7,728,370 | **477,750,375** |
| OpenCode / Muse and Builder | 23,577,112 | 258,038,105 | 0 found | **258,038,105** |
| Gemini / Antigravity | unavailable | unavailable | unavailable | **unavailable** |
| **Measured total** | **420,575,302** | **1,138,775,267** | **59,360,203** | **1,198,135,470** |

The response-only sum misses most Codex and OpenCode multi-call work. Native direct-session consumption is **2.71 times** that ACP sum; including identified descendants gives **2.85 times**. The measured combined total is a lower bound on complete room-associated consumption because Gemini usage is missing and unrecorded requests cannot be recovered. It is not an exact measure of work initiated exclusively through room prompts: native sessions can also respond to task-completion and cross-session messages.

## Coverage and accounting rules

- Exact session IDs came from the 94-file ACP transcript manifest. Native files match **39/39 prompted Claude sessions**, **20/20 prompted Codex sessions**, and **2/2 prompted OpenCode sessions**. Another Claude session with zero ACP prompts recorded cross-session-triggered work. Unmatched Claude/Codex/OpenCode session IDs all had zero ACP prompts. Three prompted Gemini sessions remain unmetered.
- Claude: retain the latest timestamped usage record per native `message.id` within the interval; sum `input_tokens + output_tokens + cache_read_input_tokens + cache_creation_input_tokens`. Direct logs contain **5,944 assistant records but only 3,529 distinct message IDs**. Their 2,415 duplicates carry identical usage; summing every content-block record would overcount. Child logs have streaming updates whose usage changes, so their final in-window record matters. Do not add nested `iterations`, `cache_creation`, or thinking-detail counters again.
- Codex: use the final in-window `total_token_usage` snapshot per session minus any pre-window baseline. All matched sessions begin inside this interval, so every baseline is zero. **3,460 direct token events contain only 3,395 changed cumulative snapshots**; all counters are monotonic. As an independent check, summing `last_token_usage` only when the cumulative snapshot changes equals the final cumulative vector in every direct session and descendant. Never sum cumulative snapshots. Cached input is a subset of native input, and reasoning output is a subset of output: `total_tokens = input_tokens + output_tokens`.
- OpenCode: read SQLite using `mode=ro`; select exact session IDs from `message`; retain assistant rows completed within the interval; sum native `tokens.total` once per message ID. **871 assistant messages**, all with totals and completion/finish values, were recovered. Native totals exactly equal `input + cache.read + cache.write + output + reasoning`; unlike Codex, this provider stores reasoning separately from output. Do not add token fields to `total` again.
- Descendants: recursively follow Claude's matched parent-session `subagents/` paths, Codex `session_meta.source.subagent.thread_spawn.parent_thread_id`, and OpenCode `session.parent_id`. Found **8 Claude child logs**, **6 Codex child sessions**, **0 OpenCode descendants**. Claude child message IDs were deduplicated globally against parent and other child IDs; no overlaps were found. No unrelated session bodies were read.
- Timestamp filtering applies to usage events, not the eventual completion of the entire room turn. The pending Luna turn beginning **05:04:50.987 UTC** already recorded **214,332 tokens across three calls** by cutoff and is included. Later native events are excluded. Token usage not yet emitted at cutoff is unavailable.

## Evidence that ACP usage is the last call

**Codex:** 192 of 195 prompt windows have a native final-call total exactly equal to ACP response `totalTokens`; the other three comprise two windows without a recorded native usage event and one pending turn without an ACP response. All direct native usage falls within these prompt windows.

A Luna turn starting **2026-09-09 01:07:54.674 UTC** made **413 recorded model calls totaling 66,837,197 tokens**. Its ACP response reports only **238,728**, exactly the native final call: input 237,710 (including cached 234,240), output 1,018 (including reasoning 862).

- ACP prompt/response: `room/transcripts/Luna-Builder-2026-09-08T21-52-11-671Z.jsonl:6907` and `:11267`.
- Native first/final usage events for that turn: `~/.codex/sessions/2026/09/08/rollout-2026-09-08T14-52-12-01a08301-db36-7110-be75-2e73e6a2b6af.jsonl:4841` and `:7680`.
- The same session's final cumulative event at native line **9656** reports **224,432,785 tokens**, while all its ACP responses sum to **2,644,824**.
- Pending-turn usage evidence: `~/.codex/sessions/2026/09/09/rollout-2026-09-09T17-34-27-01a088bc-c52f-7a50-b087-0eef5febb18e.jsonl:3050` and `:3064`; pending ACP prompt at `room/transcripts/Luna-Builder-2026-09-10T00-34-27-246Z.jsonl:6599`.

**OpenCode:** all **119/119 ACP prompt responses** match the final native assistant message's token total. All native assistant usage falls within these prompt windows. Builder turn 37 contains **96 native assistant calls totaling 43,891,417 tokens**; ACP reports only the last call's **480,378**.

- ACP prompt/response: `room/transcripts/Builder-2026-09-07T20-36-55-650Z.jsonl:3620` and `:4139`.
- Native database: `~/.local/share/opencode/opencode.db`, `message.session_id = ses_f82696543ffeLPAkavjVcgCe1t`; final message primary key **msg_07f32476f001iRRUF8pLYqZZ7n**. Its native components are input 476, output 173, cache read 479,729, reasoning 0. SQLite rows have primary-key citations rather than invented line numbers.

## Claude discrepancies and scope

Claude ACP usage usually aggregates its completed prompt work correctly, unlike the other two adapters. Native totals nevertheless exceed the ACP sum by **30,969,055** before descendants. **143 native assistant messages totaling 17,288,497** occurred outside ACP prompt windows; the remaining **13,680,558** difference is inside prompt windows, including cancellation and overlapping asynchronous work. These are directly observed differences; do not attribute the entire gap to one mechanism.

- A cancelled Scout prompt reports zero ACP tokens, but one native assistant message records **93,209**: `room/transcripts/Scout-2026-09-08T21-50-53-313Z.jsonl:9` and `:20`; native evidence is `~/.claude/projects/-home-ben-Jarv1s/0ae210c8-62ba-4247-b8a6-6a454f000758.jsonl:22`. The exact ACP filename/lines are also stored in the structured session entry.
- Sonnet session **0bd6a2a7-295a-4907-91d6-50f3524831aa** records **8,382,693 tokens across 64 messages outside ACP prompt windows**. Native line **810** is a task-completion notification; lines **812** and **821** are ensuing assistant tool calls. Source: `~/.claude/projects/-home-ben-Jarv1s/0bd6a2a7-295a-4907-91d6-50f3524831aa.jsonl`.
- Fitz session **f87bdde3-be5b-4cf6-a28c-84b1238a3278** receives an explicit cross-session message at native line **6**, followed by assistant usage at line **15**. Source: `~/.claude/projects/-home-ben-Jarv1s/f87bdde3-be5b-4cf6-a28c-84b1238a3278.jsonl`. This supports labeling the total session-associated, not exclusively room-prompt initiated.
- Descendant provenance examples: `~/.claude/projects/-home-ben-Jarv1s/6725525a-3913-4bbc-bec5-5fcf0c84bcb6/subagents/agent-aac04969281bea95e.jsonl:5` carries the parent's exact session ID and child agent ID; `~/.codex/sessions/2026/09/09/rollout-2026-09-09T19-32-07-01a08928-7ee9-7e81-8e4c-72da77774fa1.jsonl:1` names the exact room parent thread.

## Silent-turn comparison

These figures use **direct native usage emitted within the same ACP prompt window**, without descendants or background messages outside the window. They measure observed consumption, not guaranteed savings from suppressing a turn.

| Provider | Silent turns | Native tokens | Silent turns with zero ACP tool calls | Native tokens for those turns |
|---|---:|---:|---:|---:|
| Claude | 138 | 14,804,845 | 135 | 14,034,023 |
| Codex | 27 | 2,092,460 | 26 | 2,054,542 |
| OpenCode | 60 | 10,949,897 | 58 | 9,069,678 |
| Gemini | 3 | unavailable | 3 | unavailable |
| **Known-metered total** | **225** | **27,847,202** | **219** | **25,158,243** |

The zero-tool silent total is close to the corresponding ACP figure; it does not suffer the massive multi-call undercount seen in productive build turns. Gemini's additional three turns must not be treated as zero-cost.

## Reproducibility and limits

`token-native-summary.json` contains per-session totals, final/first usage event citations, per-turn Codex/OpenCode comparisons, Claude mismatch records, descendant provenance, and all **871 sanitized OpenCode usage rows** (tokens and IDs only). Its `input_fingerprints` record SHA-256, byte size, and modification time for **74 native JSONL inputs**, with a UTC fingerprint time. `opencode_input_snapshot` records the read-only query, exact session IDs, and a SHA-256 of canonically serialized source rows per session. Native JSONL hashes cover the files as read during validation; records after the fixed cutoff are filtered out of totals. At initial validation inputs were fingerprinted; closeout subsequently retained all 74 source files in the private audit archive. Of these, 73 matched exactly and one had appended later events; its original-length prefix matched the original fingerprint. The separate `verify_native.py` recomputed the reported totals from those copies with the same cutoff. The sanitized SQLite usage snapshot permits recomputing reported OpenCode totals without exposing message contents.

No billing records were available or used. Provider token categories and pricing differ; cached input is the overwhelming bulk of the count. Tokens cannot establish task quality, active engineering time, latency, or financial waste by themselves. A claim about dollars needs the actual account/model rate and billing data. Raw ACP tool timestamps may be emitted together and do not reliably measure native tool wall time.
