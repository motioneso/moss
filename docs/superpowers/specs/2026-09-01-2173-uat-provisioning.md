# Issue 2173 - UAT provisioning readiness

## Problem

Production-shaped UAT containers crash before readiness because `writeUatEnvFile` omits the
required integrations encryption key. When provisioning fails, teardown also discards the bounded
container evidence needed to diagnose startup failures.

Root-cause proof: issue #2173 comment `5497146980`.
Approved security ruling: issue #2173 comment `5497191033`.
Approved implementation plan: issue #2173 comment `5497222473`.

## Locked scope

1. Write the existing fixed, obviously-fake 32-byte integrations test key only into the private
   per-run UAT settings file.
2. Before terminal-failure teardown, preserve only a bounded app log tail and formatted health
   status, scoped through the run's Compose project/service.
3. Add the smallest regression coverage at the existing UAT provisioner test seam.

## Security invariants

- Never read an ambient or production credential.
- Never weaken production startup checks or change the UAT environment mode.
- Never print the settings file, container environment, or a full container inspection.
- Do not change deployment configuration or add a new secret-management abstraction.

## Exit criteria

- The focused provisioner test is red before the key and green after it.
- The existing cached-image repro first proves bounded failure evidence, then becomes healthy after
  the key fix.
- The full repository gate is green, and a security-tier pull request is open for Opus QA and Ben's
  merge sign-off.

## Non-goals

Container-name concurrency, automatic required-key discovery, and any additional missing key are
separate findings, not scope for this fix.
