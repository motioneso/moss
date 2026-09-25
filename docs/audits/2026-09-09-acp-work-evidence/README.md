# ACP Work audit evidence

Main report: [2026-09-09-acp-work-audit.md](../2026-09-09-acp-work-audit.md).

The fixed interval is 2026-09-06 15:55:00 UTC through 2026-09-10 05:05:15.981 UTC. No live settings or product files were changed.

**Automation revision:** the main report now incorporates the Opus conversations and deployment timeline. The original three-provider accounting remains reproducible below; newly recovered Gemini usage is added in `revised-token-totals.json`. Read statuses previously interpreted as failed reads are corrected by native batch evidence. Original report versions and added private inputs are retained in the archive’s `automation-revision/` directory.

| File | Purpose |
|---|---|
| `transcripts.csv` | All 94 room transcript files, session identities, byte sizes, line counts, time bounds, and SHA-256 |
| `summary.json` | ACP turn/tool/message counts; **usage here is adapter-response accounting, not the corrected native total** |
| `native-token-totals.json` | Original Claude/Codex/OpenCode accounting, preserved for reproduction; add the Gemini revision for all-provider totals |
| `native-tokens-by-session.csv` | Original session/child inventory before Gemini recovery |
| `revised-native-tokens-by-session.csv` | Session/child inventory including newly recovered Gemini usage |
| `revised-token-totals.json` | Revised total 1,330,822,205, cached-input and silent-turn totals |
| [gemini-accounting.md](gemini-accounting.md) | Native Gemini recovery and correction of failed-read status interpretation |
| `gemini-native-summary.json` / `gemini-recompute.py` | Sanitized usage/batch evidence and standalone recomputation |
| [automation-deployments.md](automation-deployments.md) | Deployment timeline, actual outcomes, current-versus-staged settings, and remaining gaps |
| `automation-conversation-manifest.json` | Exact Opus and related session paths, verified models, source hashes |
| `automation-phase-metrics.json` | Before/after pure-silent rates by prompt start; descriptive, not causal |
| `automation-input-manifest.json` | Private script/config/log input fingerprints |
| `automation-deployment-current-state.json` | Read-only runtime/config snapshot from the revision |
| [native-token-validation.md](native-token-validation.md) | Provider accounting rules, exact native evidence citations, limitations |
| [workflow-findings.md](workflow-findings.md) | Detailed history sequence citations, review value, correction loops, qualified timing findings |
| `metrics.json` | Command classifications, gate receipt totals, CI statistics |
| `command-counts.csv` | Every command selected by the published count rules, with original transcript file and line; categories overlap |
| `gate-receipts.json` | 14 detached gate runs, start/end/exit code and runtime |
| `ci-job-ledger.json` | 583 GitHub job records across 53 CI runs, including 159 skipped jobs; timestamps, steps, SHA and source URLs |
| `analyze.py` | Regenerate room/ACP normalized ledgers and summaries |
| `metrics.py` | Regenerate command, gate and CI metrics from retained inputs |
| `verify_native.py` | Independently recompute and assert the native direct/child totals from retained native source copies and OpenCode usage rows |

Raw data and working extraction ledgers are private at `~/.local/share/acp-work-audits/2026-09-09/`. The directory includes the original room snapshot (`room/`), original room configuration, native copies (`native-inputs/`), sanitized OpenCode usage rows and detailed accounting (`token-native-summary.json`), gate log copies, PR/CI API responses, and the cutoff. Raw protocol/session logs contain private prompts and session configuration, so they are not duplicated into this repository.

The 74 native source copies were taken after the room snapshot. Of these, 73 matched their validation fingerprints exactly; one had appended later activity. Its prefix of the original byte length exactly matched the original SHA-256. Native calculations filter events by the fixed cutoff, and recomputation from these copies passed. The private `native-copy-manifest.json` records copy-time hashes; the native-token summary preserves the original validation fingerprints.

Run from `~/Jarv1s`:

```bash
python3 docs/audits/2026-09-09-acp-work-evidence/analyze.py ~/.local/share/acp-work-audits/2026-09-09
python3 docs/audits/2026-09-09-acp-work-evidence/metrics.py ~/.local/share/acp-work-audits/2026-09-09
python3 docs/audits/2026-09-09-acp-work-evidence/verify_native.py ~/.local/share/acp-work-audits/2026-09-09
python3 docs/audits/2026-09-09-acp-work-evidence/gemini-recompute.py
```

The first two scripts regenerate derived files inside that private archive. They do not run product tests or gates. The native verifier reads retained inputs and prints/asserts totals; it does not call providers or billing APIs.

Interpretation rules:

- `H:N` refers to original history sequence N, which equals the original source line in this snapshot. ACP file/line references resolve under `~/.viberoom/rooms/moss-work/transcripts/` or the retained `room/transcripts/` copy.
- Deduplicate protocol tool updates; do not count every update as another invocation.
- Classify command **attempts**, not successful test processes; do not add overlapping category counts.
- Do not interpret pending-check exit codes as tool defects.
- Native cumulative counters and usage detail categories must not be added together blindly; each provider's formula differs.
- Tool timestamps may be emitted together by adapters. Gate receipts and GitHub job start/end timestamps provide stronger runtime evidence.
- All percentages are descriptive for this census of available records. Model benchmarking, dollar savings, and causal critical-path totals remain outside what these records establish. Gemini native consumption has now been recovered; live context-gauge deployment remains a separate question.

The revision additionally retains seven conversation inputs, 23 automation script/config/log sources, and three Gemini native logs privately. Gemini log copies matched their original fingerprint prefixes. Its all-provider totals can be recomputed entirely from sanitized usage events; native copies preserve the underlying batch/status evidence.

## Omitted from the repository

`ci-job-ledger.json` and `gemini-native-summary.json` are over 1 MB each and were not committed. References to them above point to files that exist only in the original working copy.
