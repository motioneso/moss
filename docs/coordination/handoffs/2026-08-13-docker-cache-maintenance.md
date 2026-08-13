# Docker cache maintenance housekeeping

## Scope

Add one small, safe maintenance script for the host's Docker BuildKit cache. This is
housekeeping, not product work: do not create or update a GitHub issue, project-board item,
feature spec, or PR. Keep the change isolated to the script and its focused documentation or
shell check if needed.

## Confirmed incident

On 2026-08-13 the host reached 98% disk usage during a full verification gate. Docker reported
approximately 99.8 GB of BuildKit cache, 97.68 GB reclaimable. A one-time coordinator cleanup
removed only BuildKit cache older than 24 hours (after an initial seven-day pass) and restored
approximately 95 GB. Containers, images, and volumes were intentionally left untouched.

## Requirements

- Target BuildKit cache only; never run `docker system prune`, image prune, or volume prune.
- Work with the existing builders (`default`, `jarvisbuilder`, and `multiarch`) when present,
  without failing if one is absent.
- Use a conservative age/space policy suitable for recurring host maintenance. Make thresholds
  configurable through clearly named environment variables with safe defaults.
- Serialize runs with a lock so a timer cannot overlap a gate or another maintenance run.
- Be explicit and bounded in output: identify each builder and report the prune result.
- Exit nonzero on an actual Docker/prune error, but tolerate an absent builder.
- Add the smallest useful shell validation or documentation. Do not add a scheduler in this slice;
  leave the script ready for a later systemd timer/cron invocation.

## Guardrails

- Do not touch application code, Docker volumes, active containers, or production data.
- Do not generate screenshots or UAT evidence; this is not a user-facing feature.
- Do not run a broad destructive prune during implementation.
- Keep the working tree clean except for intentional housekeeping paths.

## Start

1. Read this handoff in full.
2. Inspect existing shell conventions and Docker tooling.
3. Implement the smallest script satisfying the requirements.
4. Run shell syntax/static checks and a safe dry-run or mocked command path if available.
5. Commit the explicit housekeeping path and report the commit plus verification to the
   Coordinator. Do not open a PR or update the project board.
