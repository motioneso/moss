# Gemini accounting revision: recovered native usage

**Gemini usage was unavailable in the original ACP-based audit but is now recovered from the driver's retained native logs.** This is an explicit revision overlay adopted by the revised main report; the original three-provider accounting artifacts remain available for reproduction.

The exact original interval is **2026-09-06 15:55:00 UTC through 2026-09-10 05:05:15.981 UTC**. All three prompted Gemini session IDs match native `usageUpdate.agents[].trajectoryId`. Their **14 ACP prompts** contain **1,336 native usage updates**. Every update maps to exactly one prompt window. No prompt-window overlaps or usage outside the windows were found.

| Exact Gemini session ID | ACP prompts | Native updates | Recovered tokens, including cached input |
|---|---:|---:|---:|
| `99386afd-a2cf-4292-80bb-2d22bea07749` | 2 | 2 | 43,110 |
| `0717446d-30ac-4fd0-8532-9f4aff6e66e7` | 2 | 7 | 124,996 |
| `3c5b5eb9-1907-45fd-b0fd-d03e7688f27c` | 10 | 1,327 | 132,518,629 |
| **Total newly recovered** | **14** | **1,336** | **132,686,735** |

Adding this explicitly labeled revision to the original measured **1,198,135,470** produces **1,330,822,205 recorded tokens**. This is model consumption, not billing or productive output. Native accounting cannot recover requests for which no usage was emitted, but Gemini is no longer wholly unmetered in this interval.

## Why the cache arithmetic matters

The driver's observed fields differ from a generic Gemini API usage object. In **every one of the 1,336 records**:

`totalTokenCount = promptTokenCount + candidatesTokenCount + thoughtsTokenCount`

The separate `cachedContentTokenCount` is **excluded** from that total; it can exceed both `promptTokenCount` and `totalTokenCount`. To compare with the original audit's processed-token accounting, add it once. Do not sum cumulative snapshots or add candidate/thought counters on top of `totalTokenCount`.

| Cumulative native component, summed across three sessions | Tokens |
|---|---:|
| `promptTokenCount` | 9,936,277 |
| `cachedContentTokenCount` | 122,211,722 |
| `candidatesTokenCount` | 319,788 |
| `thoughtsTokenCount` | 218,948 |
| Native `totalTokenCount`, excluding cache | 10,475,013 |
| **Comparable total: native total plus cache** | **132,686,735** |

Counters are monotonic, with no repeated or decreasing vectors. All three sessions were created inside the original interval, so the pre-interval cumulative baseline is zero. We take each final in-window vector once. The last main-session update is **2026-09-10 03:27:59.084364 UTC**, before cutoff and immediately before its last ACP prompt completes.

Native evidence, with line numbers:

- Session `99386…`: `/tmp/agy_acp_server.par.xbmx.ben.log.INFO.20260908-113406.2010276:196` and `:317`.
- Session `071744…`: `/tmp/agy_acp_server.par.xbmx.ben.log.INFO.20260909-115625.3379601:200` and `:357`.
- Session `3c5b…`: `/tmp/agy_acp_server.par.xbmx.ben.log.INFO.20260909-174327.629548:196` and `:111704`. The final vector is prompt **9,796,418**, cached **122,187,233**, candidate **319,400**, thought **215,578**, native total **10,331,396**.
- Exact room session/file mappings and ACP prompt/end lines are retained in `gemini-native-summary.json`; the original main ACP source is `room/transcripts/Gemini-Builder-2026-09-10T00-43-25-035Z.jsonl`.

All observed aggregate `usageUpdate.total` vectors exactly match the single matching trajectory vector; no additional native descendant trajectory was present in these usage updates. The `/tmp/agy_acp_server.par.INFO` symlink was resolved and deduplicated, avoiding counting the main log twice.

## Context shim is a different measurement

The recovery above reads the original native cumulative events directly. It does **not** sum the usage shim's `used` values or infer consumption from its context gauge.

The inspected `~/.local/share/agy-acp/usage-shim.mjs` reports `usage_update` with `used` and a configured window at lines **58–63**. Lines **91**, **126–132** extract cumulative prompt/cache counters and emit their positive difference as a proxy for the latest prompt's context size. That context proxy omits output/thought tokens, skips its initial baseline, and is not a cumulative billing/consumption total. Its window is configured as **1,048,576** at line **23**; the native usage events themselves do not supply that context limit.

The Opus source conversation documents the distinction: `~/.claude/projects/-home-ben/c75f2856-2a1f-45d4-8ba0-dfdbbbdf537a.jsonl:2538` contains the live raw cumulative vector; `:2541` describes the derived context curve; `:2561` records a stand-in-driver test; `:2566` explicitly calls the gauge derived. These establish discovery and implementation, not proof the live room had restarted onto the shim by cutoff. Native recovery does not depend on that deployment question.

## Revised silent-turn and cache figures

All three formerly unmetered silent Gemini turns also have zero ACP tool calls:

| Session / prompt | Unique native usage | Tokens |
|---|---|---:|
| `99386…` / 5 | One native delta | 17,288 |
| `99386…` / 6 | One native delta | 25,822 |
| `3c5b…` / 6 | One native delta | 13,639 |
| **Gemini addition** | **Three turns** | **56,749** |

- Original pure-silent known count **25,158,243** becomes **25,214,992 tokens across 222 turns**, now including Gemini.
- Original all-silent known count **27,847,202** becomes **27,903,951 tokens across 228 turns**.
- Recorded cache reads rise from **1,149,239,084** to **1,271,450,806**, or **95.5387%** of the revised measured total. This is cache reads alone, without cache-write tokens.

These are uniquely assigned usage deltas inside matching prompt windows, not sums that duplicate overlapping windows. They are observed consumption, not guaranteed avoidable spend.

## Correction to Gemini read-failure interpretation

The two specifically cited batches are confirmed. At **00:46:32 UTC**, a failed directory search makes the adapter flush **25** still-open `view_file` calls as failed; at **00:48:51 UTC**, another failed directory search flushes **30**. **All 55 calls already have prior nonempty `postToolArgs.result` with empty `error`, and all 55 subsequently acquire ACP `failed` records.**

Concrete example: main native log line **808** has `call_630855`'s successful nonempty read result with empty error. Line **5064** reports that a directory-search path does not exist; line **5065** says `Step error encountered; flushing open tool calls` and includes that earlier read. Another example is `call_133662`: successful result at line **5285**, then included in the second flush at line **9758**. The failure flags cannot be interpreted as independent failed underlying file reads.

The bounded full-log check strengthens this finding: **10 adapter flush batches contain 452 `view_file` occurrences but 451 unique call IDs**; `call_404771` occurs in two batches. Every listed read occurrence has a prior nonempty post-tool result with empty error and a corresponding ACP failure record. These are transport/bookkeeping failure statuses for previously returned reads. The triggering errors remain real and should be assessed separately.

| Trigger time, UTC | Native flush line | Reads flushed | Trigger recorded immediately before flush |
|---|---:|---:|---|
| 00:46:32 | 5065 | 25 | Search path absent |
| 00:48:51 | 9758 | 30 | Search path absent |
| 01:11:24 | 27563 | 73 | Command timed out after 600 seconds |
| 01:29:22 | 40460 | 68 | Internal grep error |
| 01:40:52 | 60748 | 121 | Invalid model tool call |
| 01:43:35 | 64062 | 17 | Internal grep error |
| 01:44:32 | 65816 | 15 | Search path absent |
| 01:44:40 | 66026 | 0 | Find-file directory absent |
| 01:47:06 | 69599 | 22 | Internal grep error |
| 02:08:29 | 94414 | 81 | Command timed out after 600 seconds |

Every line in this table refers to `/tmp/agy_acp_server.par.xbmx.ben.log.INFO.20260909-174327.629548`. Thus failures did continue later in the run, with different triggers. This follow-up does not independently locate the human guidance timestamp or attribute each later failure to compliance with that guidance. Use the exact table times when comparing phases; do not count the 451 IDs as 451 independent bad read decisions.

## Retained evidence and recomputation

- `gemini-native-summary.json`: sanitized native usage events, exact session and prompt mappings, cumulative vectors, timestamps, line citations, input SHA-256/size/mtime, and sanitized adapter-flush evidence. It contains no file contents from the reads.
- `gemini-recompute.py`: standalone standard-library recomputation from that JSON. Run `python3 gemini-recompute.py /path/to/gemini-native-summary.json`.

The script verifies the field equation, monotonic counters, exactly one prompt assignment per usage event, all 14 prompts, per-turn sums, and revised totals. It passed. Three real native log paths are fingerprinted; the symlink is excluded. Retain those raw files privately for original-source reproduction. This overlay preserves the original three-provider accounting artifacts and supplies the Gemini addition used by the revised main report.
