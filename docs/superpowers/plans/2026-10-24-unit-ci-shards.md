# Preserve complete unit coverage within the CI phase budget

Task #3668 / PR #3669 continuation; pinned candidate
`2e80e5269f9368069857e6586162099993fe3773`. This is an internal CI correction under
the accepted [capture binding plan](2026-10-24-moss-computer-capture-binding.md).
All Computer runtime and owner-delivery gates remain unchanged. No product surface,
app-map declaration, database, Computer image/runtime or deployment operation changes.

## Evidence and seams

Two complete workflow attempts stopped the unit command at its existing 15-minute
budget: runs40129465819/job120977890529 and40130553399/job120981187176. They had
1453 and1450 passing files respectively, all32 Computer suites, and continued
reporting passing files until TERM. The new54-case capture-binding suite passed
in both (about125s on the latter runner). This establishes incomplete suite
execution due to budget, not a proven cleanup hang or a precise attribution of
total cost between added fixtures and runner throughput. Keep both failed receipts.

- `.github/workflows/ci.yml:132–190`: one unit job, two-worker script,15m timeout,
  complete Chromium/ACL setup and exit-preserving timeout annotation.
- `scripts/test-unit.ts:10–31`: the canonical eight default path filters and
  worker settings; ANY CLI argument currently replaces those paths. Bare
  `pnpm test:unit --shard=1/2` would widen selection into unintended suites.
- `tests/unit/test-unit-plan.test.ts:5–42`: existing noargs/explicit-path regressions.
- `.github/workflows/ci.yml:258–267`: browser job already uses a two-shard matrix
  with fail-fast disabled. `:455–487`: required CI gate depends on unit job ID;
  `:493–498`: push image builds also depend on unit. Preserve both dependencies.
- Installed Vitest4.1.8 BaseSequencer.shard hashes root-relative paths, sorts and
  assigns disjoint ranges covering all selected files; shard selection precedes
  duration sorting. Use this existing mechanism, no custom scheduler/filter list.

## Bounded change

Add optional `shard?: string` to `resolveVitestArgs(cliArgs, shard)` in
`scripts/test-unit.ts`. Keep its current noargs/default and explicit CLI path
semantics; append a single `--shard=<value>` only when shard is supplied. Main
passes `process.env.MOSS_UNIT_TEST_SHARD`. When present, require exactly two
positive decimal integers separated by one slash, both safe integers and
index<=count. Empty, signed, fractional, suffixed, zero, unsafe, out-of-range
or extra-component input throws before spawn. Undefined stays unsharded.
Do not build a general CLI parser or duplicate the default paths.

Change only the unit job in `.github/workflows/ci.yml` to matrix shard `[1,2]`,
display the shard, disable fail-fast so one failure cannot hide the sibling,
and provide `MOSS_UNIT_TEST_SHARD: ${{ matrix.shard }}/2` to the existing
`pnpm test:unit` command. Keep45m outer timeout,15m phase timeout, Node24,
frozen install, Chromium/ACL preparation, two workers, all other jobs and both
unit dependencies. Annotate timeouts with shard identity. No continue-on-error,
timeout extension, test exclusion, retry-until-green or successful skip is added.

## Verification and release

Before implementation commit this exact plan and obtain independent read-only
Security and Standards/Spec acceptance. Extend the existing resolver tests with
default-filter, explicit-path and invalid-input sharding regressions. Extend
`tests/unit/ci-phase-deadlines.test.ts` with unit matrix/env/15m/aggregate assertions
without weakening any prior assertion. Observe the new default
shard case fail with shard forwarding removed, retain patch/log, restore bytes.
Use a private child-process Vitest stub to check real wrapper env forwarding,
unchanged defaults and child failure propagation; malformed dedicated shard must
refuse before that child starts. Audit workflow YAML and replay actual
aggregate shell with unit success/failure/cancelled and docs-only skipped values.
Compare actual Vitest selection for unsharded and both shards: disjoint union
must equal every original selected file, including package-local/UAT fixtures.

Expected0, unpiped private logs: focused wrapper regressions, root/tests tsc,
zero-warning scoped ESLint, changed-file Prettier, file-size and diff checks.
Retain existing checked Computer source/control evidence as that exact source's
evidence; this correction does not claim those checks ran at a later HEAD.
Required exact final-HEAD CI must execute both complete unit shards and every
other required job. Independent source/local and final CI supplemental acceptance
precede protected actual merge; retain ordered-parent/tree/concurrent-main and
native successor gates. No new security or installed/runtime acceptance claim.

Kill owner computer-closure-delivery: if the partition drops/duplicates a file,
the aggregate permits a failed/cancelled matrix, or either complete shard still
exceeds15m, stop this correction and diagnose the evidence before choosing a
different bounded fix. Do not relax the budget or silently accept partial tests.

## Review ledger

Security exact-plan R1 rejected delegation of strict grammar to Vitest4.1.8.
Its `coverage.DM_a_rWm.js:208–218` uses truthiness, parseInt and Math.abs;
negative, fractional, suffixed and extra-component values can normalize rather
than refuse. Standards/Spec independently found the same normalization while
considering delegated vendor semantics acceptable only with narrower claims.
Retain both R1 reports. The corrected contract above validates only the new
dedicated input before spawn; existing ordinary CLI forwarding is unchanged.
