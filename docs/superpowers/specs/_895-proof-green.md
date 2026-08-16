# 895 proof — correctly formatted docs-only PR (green)

This file exists only to exercise #895 exit criterion 2's deadlock check: a docs-only PR (every
changed path under `docs/` or `.md`) should classify `docs_only=true`, so `verify`,
`compose-smoke`, and `prod-compose-smoke` all report `skipped` rather than running. `CI gate`
should still resolve `success`, proving its `success|skipped` allowlist doesn't wait forever on
the three legitimately-skipped jobs.

This PR will be closed without merging once the check-run conclusion is recorded on #895.
