# Complete unit CI coverage within the existing phase budget

Task #3668 / PR #3669; [exact manifest](2026-10-24-unit-ci-shards.json),
[accepted correction plan](../../superpowers/plans/2026-10-24-unit-ci-shards.md).
This supplements the existing [Computer evidence](2026-10-24-capture-binding.md);
its original checked source6db03b5c and all disclosed fixture/runtime limits remain.
The CI correction changes no Computer production or fixture source.

## Failed execution and corrected plan

Candidate4ccf3801 and candidate2e80e5269 hit the unchanged15m unit deadline in
CI40129465819/job120977890529 and CI40130553399/job120981187176. They had1453
and1450 passing files, including every32 Computer suite, and continued passing
until TERM. Neither is an accepted complete unit result. The new54-case binding
suite passed in both; its latter runner duration was125328ms. This establishes
budget exhaustion with work remaining, without attributing all cost to fixtures
or claiming a proven hang. Both raw logs and failed receipts remain retained.

The canonical wrapper has eight default path filters, and ANY ordinary CLI input
replaces them. Adding bare --shard would select unintended non-unit tests.
The dedicated MOSS_UNIT_TEST_SHARD environment input appends a shard independently
of existing default/explicit-path selection. It validates canonical positive safe
integers index/count and index<=count before spawn. Undefined remains unsharded;
configured empty or malformed input refuses. Main forwards the actual environment.

Security rejected exact-plan R1's reliance on Vitest grammar refusal: installed
Vitest4.1.8 uses abs(parseInt) and normalizes negative/fractional/suffixed input.
Standards/Spec accepted R1 only under narrower actual vendor semantics. Both
reports remain. Both independently accepted corrected plan7d0f529ac before
implementation. Checked CI source is82637b1e890a9651f1864e8cbab7c6a31745a069.
Both independent Security and Standards/Spec reviews accept that exact source
and bounded local evidence. Their report hashes and the parent-observed native
TypeScript completion receipt are in the manifest.

## Executed local correction checks

Both CI unit shards keep all canonical filters, maxWorkers2, file parallelism,
Node24, frozen installation, Chromium/ACL setup,45m job backstop and15m phase
deadline. Fail-fast is disabled. CI gate and push image builds keep their unit
dependencies. No test exclusions, deadline extension, continue-on-error, retry or
successful partial run is introduced.

All eight correction checks exit0:36 focused runner/workflow cases, root and test
TypeScript, zero-warning scoped ESLint, changed-file formatting, file-size, diff
and private native audit. The audit executes the actual wrapper with a disclosed
Vitest argv/exit stub, checking defaults for absent/first/second shard input,
nonzero propagation and eight invalid-input cases refusing before child spawn.
It parses actual workflow YAML and replays the actual aggregate shell for unit
success/failure/cancelled/missing and existing docs-only skipped outcomes.

Actual file discovery returns the same1576 selected files as the unmodified
baseline. An initial audit failed because Vitest list --filesOnly ignores shard;
that failed script/log is retained. The corrected audit executes exported native
BaseSequencer.shard on those actual discovered module paths:788+788 files,
disjoint and complete. This is native sequencer fixture proof; actual complete
CI executions and their combined file population remain mandatory release evidence.

Seven removed-protection controls observe intended failures: shard forwarding,
strict dedicated input validation, actual environment wiring, both matrix shards,
15m budget, aggregate unit dependency and aggregate failure refusal. Exact
patches/logs remain private. Source bytes are restored after each control; final
focused/native/lint/format/size/diff checks pass on restored bytes. Original
Computer checks and35 controls remain bound to their original source, rather
than being described as executions at this later commit.

## Remaining release and runtime gates

Exact final public evidence acceptance, exact final-HEAD CI with both complete
unit shards and every other required job, supplemental acceptance, protected
actual merge/tree/concurrent-main verification and a verified fresh native
successor remain distinct gates. CI belongs to final PR HEAD, not the merge SHA.
No Computer image/runtime, Docker mutation, DB, browser/server or deployment
operation occurred. All inherited owner/runtime/resource/time/storage/trust/
isolation/identity gates remain; unavailableAdmission and owner parents stay
unchanged. This internal prerequisite never establishes actual owner delivery.
