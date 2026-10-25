# Computer prelaunch runner contract

Plan, with a small code slice that no production path calls. No Computer runtime, image, Docker,
deployment or production operation. `unavailableAdmission` stays the only admission. Parents #3577,
#3616, #3617, #3618 and #3619 stay open. Settles open items 1, 2 and 3 of the
[prelaunch handover handoff](../handoffs/2026-10-25-moss-computer-prelaunch-handover.md).

## Problem

The [handover plan](2026-10-24-moss-computer-prelaunch-handover.md) has a root launcher spawn a
lifetime-free `hold` watchdog and a one-shot `prelaunch` sampler before any container exists. The
pinned loader cannot load either one today.

| Source                                       | Fact                                                                                                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/computer-watchdog/trust.ts:60-75`   | `parseSupervisorConfiguration` requires an exact key set that includes `runner`, a pinned live process identity.                                |
| `scripts/computer-watchdog/trust.ts:322-340` | The loader reads `/proc` for that runner, requires its stdout and stderr to be `/dev/null`, and for non-collectors requires the heartbeat pipe. |
| `scripts/computer-watchdog.ts:23-24,34-36`   | Only `observe`, `fence`, `manage` and `collect` exist. `hold` and `prelaunch` have no entry.                                                    |
| `scripts/computer-watchdog.ts:12-17,78-81`   | The 5s startup timer is cleared only by `acknowledgeStartup()`, and only the manage and supervise paths call it.                                |
| `scripts/computer-watchdog/trust.ts:272-276` | Node path is `process.execPath`, artifact path is `argv[1]`, config path is `argv[2]`. Only the artifact hash is pinned, inside the config.     |

Before launch no runner exists. A runner is the process that will later start the pair. So the
prelaunch phase has no process to pin.

## Fork: what does the loader check before launch

| Option                    | Mechanism                                                                                                     | Cost                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| A. Launcher is the runner | The launcher puts its own identity in the config. Loader unchanged.                                           | The check no longer proves anything independent, because the checked process is the one that wrote the file. |
| B. Stub runner process    | The launcher spawns a do-nothing process and pins that.                                                       | One more process to start, pin and clean up. It proves nothing either.                                       |
| C. New runner-less kind   | A `prelaunch` configuration with no `runner`, no lifetime, no capture. A separate loader function accepts it. | Edits security-critical loader code. The runner-dependent checks are skipped only for this kind.             |

Recommendation: C. A and B keep the loader as is but pin a process that vouches for itself, which
is the weakest form of the check. C removes a check that has nothing to check. It must be built so
the existing loader path stays byte-for-byte as strict. This is a security decision, so it is taken
only after independent Security acceptance of this plan.

## Contract (option C)

### 1. Configuration kind

- The prelaunch configuration carries the existing keys minus `runner`, `lifetime` and `capture`,
  plus a literal `kind: "prelaunch"`. Exact key set, same private-file rules as today
  (mode 0600, parent 0700, size cap 16384, root-owned trusted chain).
- `parseSupervisorConfiguration` keeps its exact key set and rejects `kind`. A new
  `parsePrelaunchConfiguration` is exact on its own set and rejects `runner`, `lifetime` and
  `capture`. Each parser refuses the other's shape on keys alone.
- The configuration pins the run ID, artifact hash and boot ID, as today (trust.ts:27-35).

### 2. Loader

- The checks that do not depend on a runner move into one internal function, unchanged in order
  and content: runtime assertion, config file trust, node and artifact trust, artifact hash,
  namespace anchors, host roots, Docker socket, data, Docker data and monitor roots, overlap
  rules, and the identity marker (trust.ts:262-320).
- `loadSupervisorDeployment` calls it, then runs its runner checks as now (null outputs for the
  runner, `readComputerProcess`, heartbeat pipe).
- New `loadPrelaunchDeployment(configPath, artifactPath)` calls it and nothing runner-related.
  It additionally asserts its own stdout and stderr are `/dev/null`, since `hold` and
  `prelaunch` write nothing to a terminal. The sampler writes its one record through a pipe on a
  different descriptor chosen by the launcher, as in the handover plan, so the sampler checks
  fd 1 and 2 only.
- Existing loader tests run unchanged. A new test removes the shared function's guard and shows
  every loader refuses, so the extraction cannot silently drop a check.

### 3. Pinned node, artifact and config paths

- Node is `process.execPath` and artifact is `argv[1]`, as today, both checked by
  `assertTrustedPath` (root-owned chain, no group or world write, single-link regular file).
- The launcher chooses the three paths for the children it spawns. It derives them from its own
  trusted location, never from a request, the host config or the environment. The host config has
  no path fields (config.ts) and gets none.
- The artifact hash in the root-owned config binds the artifact. The config is root-owned
  0600 in a 0700 directory. A non-root actor cannot change any of the three.
- The exact installed locations belong to installed delivery (item 5 of the handoff). This plan
  fixes only the rule that they are derived by the root launcher from its own trusted location.

### 4. `hold` mode

- `hold <config>` loads the prelaunch deployment, acknowledges startup, and idles.
- `acknowledgeStartup()` runs once the load succeeds and the process has re-read its own identity
  with `processIdentity(process.pid)`. A load that takes 5s or more refuses, as today.
- `hold` has no heartbeat, no lifetime and no output. It exits 0 at 1800s of monotonic age, the
  existing run limit. Item 4 of the handoff may shorten this. It exits 2 on any refusal.
- Hold does not exit when the launcher dies. The orphan is bounded by the 1800s cap and cleaned by
  installed delivery (item 5).
- Proof of acknowledgement: `hold` exits at 5s unless it acknowledged. The launcher therefore
  treats a hold identity that is still alive and unchanged (pid, start ticks, group) 5s after
  spawn as acknowledged. This adds up to 5s to each enable and is the stated cost.
- `hold` and `prelaunch` refuse a runner pid or process-group equal to their own, with the same
  code path as today (computer-watchdog.ts:74-75), applied to the launcher's group.

### 5. `prelaunch` mode (config rule only)

- `prelaunch` accepts a prelaunch configuration only, like `collect` it reads one bounded stdin
  record, and the sample body, nonce and output rules are those of the handover plan.
- This slice defines which configuration kind each mode accepts. It does not build the sampler.

## Mode and kind matrix

| Mode        | `runner` config | `prelaunch` config |
| ----------- | --------------- | ------------------ |
| `observe`   | accepted        | refused            |
| `fence`     | accepted        | refused            |
| `manage`    | accepted        | refused            |
| `collect`   | accepted        | refused            |
| `hold`      | refused         | accepted           |
| `prelaunch` | refused         | accepted           |

## Code in this slice

1. `parsePrelaunchConfiguration` and the type.
2. The shared-checks extraction and `loadPrelaunchDeployment`.
3. `hold` mode with the acknowledgement above, and the matrix check in `computer-watchdog.ts`.
4. Tests, each seen failing with its protection removed.

Nothing in production code calls these. The launcher, the sampler, admission and delivery are
later slices, so `unavailableAdmission` is unchanged.

## Tests (removed-protection)

- A config with `runner` is refused by the prelaunch parser, and one with `kind` by the old parser.
- A prelaunch config with a lifetime or capture key is refused.
- Every shared check refuses on its own: bad hash, wrong boot ID, wrong namespace, untrusted node,
  untrusted artifact, loose config mode, wrong identity marker, overlapping roots.
- Matrix: `hold` with a runner config and `observe` with a prelaunch config both refuse.
- `hold` with stdout not `/dev/null` refuses.
- `hold` exits 2 when unacknowledged at 5s, and a slow load refuses.
- `hold` does not call the heartbeat check, and `loadSupervisorDeployment` still does.

## Out of scope

The launcher, the prelaunch sampler body, admission, bounded second phase and first healthy sample
(item 4), installed delivery, orphan cleanup and the runtime packet (item 5), any launch.

## Gates

Independent Security and Standards/Spec acceptance of this plan, then of the exact final head.
Removed-protection failures observed and restored. Full local gate through the verify-gate skill.
Green CI on the exact final head. No change to `unavailableAdmission`.
