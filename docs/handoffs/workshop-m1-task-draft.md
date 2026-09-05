# Workshop M1 — planning configuration (#2295)

Authorized by the limited R1a–R1d/M1/M2 approval. Reuse the current AI settings ServiceRow for
`module.workshop.plan`, default/require reasoning plus JSON, retain pin precedence and concrete
model selection. Return the existing settings recovery path on unavailable planning. Keep execution
disabled and provider-global CLI credentials unavailable for Workshop planning.

Migrate legacy `module.moss.workshop-build-plan` through the AI-owned repository/API: read-through
uses the old choice until an admin's bindings GET atomically moves it, preserving any explicit new
key. Deleting the new key removes the old alias too, preventing resurrection. Do not weaken
installed-module checks or create a second settings repository. No DDL or applied migration edits.

Verify parser precedence, strict post-resolution reasoning checks/no provider dispatch on conflict,
existing-control save/default/recovery text, API migration/idempotence and delete behavior. Use the
repository-local verify-gate for DB checks after staggering other lanes. Same-project retry through
the new project UI remains downstream of the separately gated project/lifecycle work; do not claim
that installed path from settings/unit proof. No deployment, install, merge or enabling execution.
