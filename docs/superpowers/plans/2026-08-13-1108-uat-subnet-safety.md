# Plan — #1108 UAT subnet safety

**Spec:** `docs/superpowers/specs/2026-08-13-1108-uat-subnet-safety.md` (read it first; decisions
D1–D6 are locked there and not restated).

**Issue:** #1108. **Grounded on:** `origin/main` = `1e8df0257`.

**Pre-build gate:** rebase on current `main`, re-read `tests/uat/provisioner.ts` and
`tests/unit/uat-provisioner.test.ts`, refresh every line reference, and re-run the read-only
`docker network inspect` sweep. If `provisioner.ts` has structurally changed (the #1121/#1557 chat
lanes touch it), re-ground before writing a line.

## Seams (each verified at `1e8df0257`)

| Assumed capability                                            | Citation                                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Per-attempt retry loop with candidate exhaustion              | `tests/uat/provisioner.ts:717-825`                                                    |
| Conflict-signature error class + stderr sniffing precedent    | `PortBindConflictError`, `tests/uat/provisioner.ts:553-584`                           |
| Injectable-probe test pattern                                 | `findAvailablePort(candidates, probe)`, `tests/uat/provisioner.ts:152`                |
| Read-only docker capture helper                               | `runCapture`, `tests/uat/provisioner.ts:503-519`                                      |
| Idempotent never-throw teardown helper precedent              | `removeJobSearchFixtureContainer`, `tests/uat/provisioner.ts:118-122`                 |
| Positive leak assertion (containers+volumes today)            | `assertNoLeakedResources`, `tests/uat/provisioner.ts:527-548`                         |
| Subnet consumed at exactly two seams                          | env file `tests/uat/provisioner.ts:207`, interpolation `tests/uat/provisioner.ts:271` |
| Compose IPAM interpolation with prod default                  | `infra/docker-compose.prod.yml:222`                                                   |
| Compose stamps `com.docker.compose.project` label on networks | verified live 2026-08-13, compose v2.24.6 and v5.1.4                                  |
| Unit tests pinning today's literal/signatures                 | `tests/unit/uat-provisioner.test.ts:14,38,77,137,159`                                 |

Open questions: none. No new dependency; no migration; no user-facing UI.

## Task 1 — subnet-selection module + unit tests

**Files:** new `tests/uat/subnet-selection.ts`, new `tests/unit/uat-subnet-selection.test.ts`.

Exports exactly the D6 signatures (`UAT_SUBNET_CANDIDATES`, `UAT_FORBIDDEN_SUBNETS`,
`UatSubnetSelectionError`, `parseIpv4Cidr`, `cidrsOverlap`, `listLiveDockerSubnets`,
`selectUatSubnet`). `listLiveDockerSubnets` shells `docker network ls -q` then
`docker network inspect` via the injected capture (default: `runCapture` re-exported or duplicated
minimally — implementer's call, but `provisioner.ts` must not import from the test file).

Test cases — each stated with why it fails against a broken implementation:

1. `cidrsOverlap("10.252.0.0/24", "10.252.0.0/24")` → true; `("10.0.0.0/8", "10.252.0.0/24")` →
   true both orders; `("10.254.0.0/24", "10.255.0.0/24")` → false; `("172.17.0.0/16",
"10.254.0.0/24")` → false. String-equality or prefix-string-compare fakes fail the /8⊃/24 case.
2. `parseIpv4Cidr` throws on `"10.252.0.0"`, `"10.252.0.0/33"`, `"fd00::/64"`, `""` — a
   guard that ignores what it cannot parse is not fail-closed (spec D4).
3. `selectUatSubnet({requested: undefined, live: []})` → `{subnet: "10.254.0.0/24", source: "auto"}`
   — continuity with today's default.
4. Auto-pick skips occupied: with `10.254.0.0/24` and `10.255.0.0/24` live, returns
   `10.240.0.0/24`. Fails if the picker ignores live state (today's behaviour).
5. Auto-pick never returns forbidden even with an empty `live` list and a candidates override that
   sneaks `10.252.0.0/24` in — fails if forbidden is enforced only via pool membership.
6. Requested overlap refused, colliding network **named** in the message
   (`requested: "10.251.0.0/24"` with live `infra_jarv1s` at same) — fails on silent re-pick.
7. Requested forbidden refused **when absent from `live`** (`requested: "10.252.0.0/24"`, `live:
[]`) with the reason string — the prod-down squat case, spec D2.
8. Requested valid+free accepted verbatim with `source: "requested"`.
9. Pool shape: every `UAT_FORBIDDEN_SUBNETS.cidr` overlaps no `UAT_SUBNET_CANDIDATES` entry;
   `UAT_SUBNET_CANDIDATES[0] === "10.254.0.0/24"`; pool length 13.
10. `listLiveDockerSubnets` with a canned capture: skips IPv6 entries and no-IPAM networks, throws
    `UatSubnetSelectionError` on a malformed IPv4-looking subnet from docker.

## Task 2 — wire selection into the provisioner

**Files:** `tests/uat/provisioner.ts`, `tests/unit/uat-provisioner.test.ts`.

- Delete `UAT_DOCKER_SUBNET` const (line 36). Add required `subnet` input to `writeUatEnvFile`
  and `uatComposeInterpolationEnv` (spec D6).
- In `provisionForUat`: per attempt, `selectUatSubnet({requested: process.env.UAT_DOCKER_SUBNET,
live: await listLiveDockerSubnets()})` **before** any compose invocation; thread the result into
  the env file, interpolation env, and the attempt log line
  (`[uat] provisioning <project> on port <port> subnet <cidr> (<source>)`).
- New `SubnetOverlapConflictError` matched in `runCommand` on
  `/pool overlaps with other one on this address space/i`, alongside the port pattern. Retry
  branch: only when `source === "auto"` — drop the collided candidate (thread a
  `remainingSubnetCandidates` array mirroring `remainingCandidates` for ports), re-select next
  iteration. `source === "requested"` → rethrow terminal (spec D3/D4).
- Warning log naming any skipped live network whose name starts with `uat-` (spec D5 visibility).
- Update `tests/unit/uat-provisioner.test.ts`: replace line 38's literal pin with pool-shape
  assertions (or delete in favour of Task 1 case 9); adapt lines 14/77/137/159 to the new
  signatures by passing an explicit `subnet` fixture value. A test passing a fixed
  `"10.254.0.0/24"` here is asserting the plumbing, not the selection — selection is Task 1's job.

## Task 3 — owned-network teardown + leak assertion

**Files:** `tests/uat/provisioner.ts` (+ `tests/unit/uat-provisioner.test.ts` if a pure helper is
extracted).

- `teardownCompose` (inside `provisionForUat`, lines 740-747): after `down -v`, list networks with
  `--filter label=com.docker.compose.project=<projectName>`; `docker network rm` each (idempotent,
  `.catch(() => {})`, never throws — teardown-helper contract).
- `assertNoLeakedResources`: add a third capture,
  `docker network ls --filter label=com.docker.compose.project=<projectName> --format {{.Name}}`,
  and include leaked network names in the thrown message. Label filter, not name filter — the label
  is the ownership marker (spec D5); a name-prefix filter could match another run's
  `uat-<pid>_<hex>` only if names collided, but the label is exact and is what compose itself wrote.
- **No cross-run deletion anywhere.** Grep the diff for `network rm` and confirm every call site is
  scoped by the current run's `projectName` label.

## Task 4 — live acceptance proofs, recorded on the PR

No screenshots; bounded textual evidence only (exit codes + grep'd log lines). Run on the dev box.
Pre-step: `docker build` the `uat-smoke` image once, then run proofs with `JARVIS_UAT_BUILD=0` so
two concurrent runs don't race one image build. Stagger the concurrent starts by ~5s
(multi-agent PG contention memory).

1. **Forbidden refusal (prod untouched):**
   `UAT_DOCKER_SUBNET=10.252.0.0/24 JARVIS_UAT_BUILD=0 pnpm exec tsx tests/uat/provisioner.ts > /tmp/uat1108-refuse.log 2>&1; echo "EXIT=$?"`
   → expected `EXIT=1`, log contains the reserved-for-production refusal, log contains **zero**
   `docker compose` invocations, and `docker network inspect jarv1s-prod_jarv1s` before/after shows
   an identical `Containers` set (read-only proof prod was never touched).
2. **Live-overlap refusal:** `docker network create --subnet 10.249.0.0/24 uat1108-proof`, then
   `UAT_DOCKER_SUBNET=10.249.0.0/24 … tsx tests/uat/provisioner.ts > /tmp/uat1108-refuse2.log 2>&1; echo "EXIT=$?"`
   → `EXIT=1`, message names `uat1108-proof`. Cleanup: `docker network rm uat1108-proof` — created
   by this proof, the only network the proof ever deletes.
3. **Concurrency:** two staggered
   `JARVIS_UAT_BUILD=0 pnpm exec tsx tests/uat/provisioner.ts > /tmp/uat1108-c{1,2}.log 2>&1; echo "EXIT=$?"`
   → both `EXIT=0`; the two `subnet <cidr> (auto)` log lines differ;
   `docker network ls --format '{{.Name}}'` afterwards contains no `uat-` entry. If the loser hits
   the TOCTOU retry, its log shows the subnet-conflict retry warning — paste it; that line is the
   D4 mechanism working, not a flake.

Evidence bound per proof: exit line + ≤10 grep'd log lines. All verification commands above keep
the `; echo "EXIT=$?"` shape — never piped.

## Static gates

`pnpm test:unit > /tmp/uat1108-unit.log 2>&1; echo "EXIT=$?"` → `EXIT=0` (no DB touched by unit
suite). `pnpm lint`, `pnpm format:check`, `pnpm check:file-size`, `pnpm typecheck` — each
`> /tmp/…​.log 2>&1; echo "EXIT=$?"` → `EXIT=0`. Root typecheck, not a package filter
(TS6059 false-red memory). Full `verify:foundation` only via the `verify-gate` skill.

## Kill gate

After Tasks 1–2 (selection logic, unit-proven) the line pauses for the Task 4 proofs. If proof 3
fails for reasons **outside** the subnet guard (ufw, daemon limits — the guard's own logs clean),
stop, report to the Coordinator; Ben owns the call on whether concurrent UAT on this box stays a
goal. Tasks 1–3 are still shippable as the fail-closed guard alone; say "code-complete, unverified
for concurrency" plainly if so.

## Rulings ledger (facts uncovered while grounding)

- The two stranded `uat-*` networks cited in #1108 (10.254/10.255) were already gone on 2026-08-13;
  both /24s free. Issue's bullet 3 is prevention-only now.
- Compose v2.24.6 **and** v5.1.4 both stamp `com.docker.compose.project` on networks (live
  inspect) — the ownership marker is version-stable on this box.
- Live box carries ~28 non-jarv1s compose networks across `172.16–31/16` and `192.168.x/20` —
  string-equality overlap checks would pass everything; real CIDR math is mandatory.
- `assertNoLeakedResources` checks containers+volumes only (`tests/uat/provisioner.ts:527-548`) —
  network leak-blindness is the root cause of the strays, not a `down -v` bug (`down -v` does
  remove the network when nothing external is attached; the fixture-container ordering comment at
  lines 112-117 documents the one attach-blocked case already handled).
