# UAT subnet safety — auto-select, fail-closed overlap guard, owned-network cleanup

**Date:** 2026-08-13

**Status:** Draft — awaiting review

**Issue:** #1108 (task/bug, part of #1000 UAT harness)

**Grounded on:** `origin/main` = `1e8df0257`, read directly in this tree: `tests/uat/provisioner.ts`,
`tests/uat/run-uat.ts`, `tests/unit/uat-provisioner.test.ts`, `infra/docker-compose.prod.yml`,
`scripts/smoke-compose.ts`, `docs/DEVELOPMENT_STANDARDS.md`, issue #1108 — plus a live read-only
`docker network inspect` sweep of the dev box on 2026-08-13 (findings below).

**Pre-build grounding gate:** rebase on the then-current `main`, re-read `tests/uat/provisioner.ts`,
and re-run the live network sweep before implementation. Line references below are to
`origin/main = 1e8df0257` and rot.

## Problem

`tests/uat/provisioner.ts:36` reads `UAT_DOCKER_SUBNET` from the environment **once at module
import** and defaults it to a fixed `10.254.0.0/24`. That value flows into the stack's env file
(`tests/uat/provisioner.ts:207`) and compose interpolation (`tests/uat/provisioner.ts:271`), and
ends up as the compose network's IPAM subnet (`infra/docker-compose.prod.yml:222`,
`${JARVIS_DOCKER_SUBNET:-10.251.0.0/24}`). There is **no overlap check of any kind**:

- Two concurrent UAT runs get unique compose project names (`generateUatRunId`,
  `tests/uat/provisioner.ts:26-29`) but the **same subnet**, so the second run's first `up` dies on
  Docker's `Pool overlaps with other one on this address space`. Concurrency today requires
  hand-assigning distinct subnets via the env var.
- Nothing stops a hand assignment from targeting a **live** network. On 2026-07-16 a lane was
  hand-assigned `10.252.0.0/24` — production's subnet. Docker failed closed and prod was untouched,
  but the harness itself has no guard; the only defence is Docker's own pool check plus luck.
- Teardown (`down -v` + `assertNoLeakedResources`, `tests/uat/provisioner.ts:527-548`) positively
  verifies **containers and volumes only** — networks are never checked, so a crashed run can strand
  a `uat-*_jarv1s` network that silently squats its /24 forever.

### Live network map (dev box, verified read-only 2026-08-13)

| Network              | Subnet                                   | Note                                                                                        |
| -------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| `jarv1s-prod_jarv1s` | `10.252.0.0/24`                          | **LIVE PRODUCTION — never target**                                                          |
| `infra_jarv1s`       | `10.251.0.0/24`                          | dev/infra stack (also the compose-file default)                                             |
| _smoke reservation_  | `10.253.0.0/24`                          | `scripts/smoke-compose.ts:121` (no network exists until a smoke run)                        |
| Docker auto-pools    | `172.17–172.31.0.0/16`, `192.168.x.0/20` | ~28 unrelated compose stacks on this box                                                    |
| `uat-*` strays       | —                                        | the two strays cited in #1108 (10.254/10.255) **no longer exist**; both /24s are free today |

Two consequences the design must honour: existing networks include **/16 and /20** pools, so the
overlap guard needs true CIDR-overlap math, not string equality; and every compose-created network
on this box already carries a `com.docker.compose.project=<project>` label — that label is the
ownership marker this spec builds cleanup on.

## Decision summary

One implementation PR against #1108. It makes the provisioner:

1. **Auto-select a free `/24` per provisioning attempt** from a static reserved candidate pool,
   skipping any candidate that overlaps a live Docker network.
2. **Refuse, fail-closed and before any `docker compose` invocation**, an explicitly requested
   `UAT_DOCKER_SUBNET` that overlaps a live network or a statically forbidden subnet. An explicit
   request is never silently re-picked — refusal only.
3. **Support concurrent subnet allocation** by combining per-attempt selection with a bounded retry
   on Docker's own pool-overlap failure (mirroring the existing port-bind TOCTOU retry). Scope note
   (review finding B1): this makes concurrent runs _allocate_ safely — full concurrent UAT stacks
   remain blocked by the fixed `container_name: moss` in the compose file itself
   (`infra/docker-compose.prod.yml:133`, provisioned by every UAT run via
   `tests/uat/provisioner.ts:437`), which mutually excludes any two live stacks at the second `up`
   regardless of subnets. That is a prod-facing compose change tracked separately in #1618 and
   deliberately not made here.
4. **Clean up only networks demonstrably owned by the current run** — matched by the run's unique
   compose-project label — and extend the leak assertion so a surviving network is loud. **No
   cross-run reaping, ever.**

No production network is read-modified in any way; the guard's only interaction with live networks
is read-only `docker network ls` / `docker network inspect`.

## Locked design decisions

### D1 — Selection happens per attempt, not at import

The module-level `export const UAT_DOCKER_SUBNET = process.env.UAT_DOCKER_SUBNET ?? "10.254.0.0/24"`
(`tests/uat/provisioner.ts:36`) is **removed**. Subnet selection runs inside `provisionForUat`'s
retry loop, once per attempt, alongside the existing per-attempt port probe
(`tests/uat/provisioner.ts:719`). Import-time env reads are the exact flag-read-once-at-boot trap
adjudicated against in #1557; a per-attempt read is also what lets a retry pick a different subnet.

`UAT_DOCKER_SUBNET` (env var) keeps its name and meaning — an explicit operator request — but is now
validated instead of trusted.

### D2 — Static reserved candidate pool, static forbidden list

- **Candidates** (deterministic order): `10.254.0.0/24`, `10.255.0.0/24`, then `10.240.0.0/24`
  through `10.250.0.0/24` — 13 total. `10.254` stays first for continuity with today's default.
  The pool lives in the `10.240–10.255` neighbourhood already established by this repo's
  reservations and far from Docker's own `172.16–31/16` and `192.168/20` auto-pools.
- **Forbidden** (never selectable, never acceptable as an explicit request, each with a reason
  string used in the refusal message):
  - `10.251.0.0/24` — infra/dev stack, and the compose-file default
  - `10.252.0.0/24` — live production
  - `10.253.0.0/24` — smoke reservation (`scripts/smoke-compose.ts:121`)

  Forbidden subnets are refused **even when the corresponding network is currently absent**: a UAT
  stack squatting prod's /24 while prod happens to be down would make production's next `up` fail —
  that is a UAT run breaking a prod deploy, the exact hazard this issue exists to close.

### D3 — Fail-closed validation of an explicit request, before compose

When `UAT_DOCKER_SUBNET` is set, before any `docker compose` invocation (including
`config --quiet`): it must parse as an IPv4 CIDR, must not overlap the forbidden list, and must not
overlap any live network's IPv4 subnet (true CIDR overlap). Any violation throws a terminal error
naming the requested CIDR and the colliding network name + subnet (or the forbidden reason). No
fallback, no auto-repick, no retry — the operator asked for that subnet specifically, so the only
safe answer to "no" is "no, and here is why".

### D4 — Auto-pick + bounded conflict retry for concurrency

With no explicit request: enumerate live IPv4 subnets (read-only), pick the first candidate that
overlaps neither live subnets nor the forbidden list. Two concurrent runs that scan simultaneously
can still both pick the same free /24 (TOCTOU); Docker then fails the loser's first `up` closed with
`Pool overlaps with other one on this address space`. That stderr signature becomes a
`SubnetOverlapConflictError`, handled exactly like the existing `PortBindConflictError`
(`tests/uat/provisioner.ts:553-555`, `800-810`): tear the attempt down, drop the candidate, re-select
on the next iteration. Bounded by the pool size (13), never unbounded. The retry applies **only** to
auto-picked subnets — an overlap conflict under an explicit request is terminal (D3).

Non-IPv4 IPAM entries (IPv6) and networks with no IPAM config (`host`, `none`) are skipped by the
enumerator; an IPv4 /24 cannot overlap them. A malformed subnet string coming back from Docker
itself fails the run loudly rather than being skipped — a guard that ignores what it cannot parse is
not fail-closed.

The retry keys on Docker's exact stderr signature by design: if a future Docker release rewords the
message, the conflict degrades to a terminal fail-closed error rather than a silent retry — that is
the intended safe direction. Do not "fix" this into a broader fuzzy match.

### D5 — Ownership marker and cleanup scope

The ownership marker is the run's unique compose project name (`uat-<pid>_<hex8>`,
`tests/uat/provisioner.ts:26-29`), which Compose stamps on the network as the
`com.docker.compose.project` label (verified live on this box for both installed Compose binaries:
the `docker compose` plugin v2.24.6 and the standalone `docker-compose` reporting v5.1.4).

- **Current-run teardown:** after `down -v`, any network still carrying **this exact run's** label
  is removed explicitly (idempotent, never throws — same contract as
  `removeJobSearchFixtureContainer`, `tests/uat/provisioner.ts:118-122`).
- **Leak assertion:** `assertNoLeakedResources` (`tests/uat/provisioner.ts:527`) gains networks as a
  third checked resource class, filtered by this run's label, so a survivor fails the run loudly.
- **No cross-run reaping.** Stranded `uat-*` networks from other or dead runs are never auto-deleted
  — liveness of another run is not decidable safely from here (a mid-provision network legitimately
  has zero containers). The auto-picker routes around their subnets, and the provisioner logs a
  warning naming any `uat-*`-labelled network it had to skip, so stranding is visible without being
  destructive. Removing a stray is a deliberate operator action
  (`docker network rm <name>` after confirming the owning run is dead).
- Issue #1108's "reap the two strays at 10.254/10.255" bullet is already satisfied: they no longer
  exist (verified 2026-08-13). What this PR owes is prevention (own-network removal + loud leak
  assertion) — not retroactive deletion of anything.
- This narrows the issue's "reap leftover `uat-*` networks" wording to own-run cleanup only. The
  deviation is deliberate (cross-run auto-delete on a multi-agent box is the dangerous choice) and
  is surfaced on #1108 itself in the acceptance-amendment comment, not just recorded here.

### D6 — Surface and signature changes

New file `tests/uat/subnet-selection.ts` (keeps `provisioner.ts`, already 841 lines, clear of the
1000-line gate) exporting:

```ts
export const UAT_SUBNET_CANDIDATES: readonly string[];
export const UAT_FORBIDDEN_SUBNETS: ReadonlyArray<{
  readonly cidr: string;
  readonly reason: string;
}>;
export class UatSubnetSelectionError extends Error {}
/** throws on anything that is not a valid IPv4 CIDR */
export function parseIpv4Cidr(cidr: string): {
  readonly base: number;
  readonly prefixLength: number;
};
export function cidrsOverlap(a: string, b: string): boolean;
/** read-only enumeration; capture injectable for unit tests, same shape as findAvailablePort's probe */
export function listLiveDockerSubnets(
  capture?: (command: string, args: readonly string[]) => Promise<string>
): Promise<ReadonlyArray<{ readonly networkName: string; readonly subnet: string }>>;
/** pure; throws UatSubnetSelectionError per D2–D4 */
export function selectUatSubnet(input: {
  readonly requested: string | undefined;
  readonly live: ReadonlyArray<{ readonly networkName: string; readonly subnet: string }>;
  readonly candidates?: readonly string[];
}): { readonly subnet: string; readonly source: "requested" | "auto" };
```

In `tests/uat/provisioner.ts`: `writeUatEnvFile` and `uatComposeInterpolationEnv` each gain a
required `readonly subnet: string` input field (the const they read today is gone);
`provisionForUat` threads the per-attempt selection into both and into the retry loop. CIDR math is
plain 32-bit integer arithmetic — **no new dependency**.

The pinned-literal unit test `expect(UAT_DOCKER_SUBNET).toBe("10.254.0.0/24")`
(`tests/unit/uat-provisioner.test.ts:38`) is replaced by pool-shape assertions (candidates exclude
every forbidden subnet; `10.254.0.0/24` is first) — the literal pin is the version-literal-test rot
this repo has already catalogued. Companion updates at lines 14, 77, 137, 159 of the same file
follow the signature change.

## Determinism boundary

No AI surface anywhere in this change. The model has zero jobs; every decision (candidate order,
overlap verdict, refusal message) is deterministic code over `docker network` output.

## Out of scope — named so silence is not absence

- `scripts/smoke-compose.ts`'s fixed `10.253.0.0/24` has the same no-guard shape. Not owned by
  #1108; the forbidden list here protects UAT from smoke, not smoke from anything.
- CI e2e wiring and host firewall (ufw) behaviour are untouched.
- **The fixed `container_name: moss` (`infra/docker-compose.prod.yml:133`) — tracked as #1618.**
  Every UAT stack provisions from that compose file (`tests/uat/provisioner.ts:437`), so the fixed
  name mutually excludes any two live UAT stacks: the second run's `up` dies on
  `Conflict. The container name "/moss" is already in use`, whatever its subnet. This is not merely
  an orphaned-stack hazard — it deterministically caps this box at one live UAT stack. Removing or
  project-scoping the name is a prod-facing change (Portainer stack and Watchtower track the prod
  container) requiring Ben's sign-off, hence the separate issue rather than a scope creep here.
- No compose-file change: `infra/docker-compose.prod.yml:222` keeps its `10.251.0.0/24` default —
  prod deploys rely on it; the provisioner always interpolates an explicit value.

## Acceptance (non-destructive, no screenshots)

1. **Unit:** overlap math (containment /16⊃/24, adjacency, identity, invalid input throws) and
   selection behaviour (skips occupied, refuses forbidden-even-when-free, refuses requested overlap
   with the colliding network named, tags `source`) pass in `pnpm test:unit`.
2. **Refusal proof (prod never touched):** `UAT_DOCKER_SUBNET=10.252.0.0/24` provisioner invocation
   exits non-zero with the reserved-for-production refusal **before any compose invocation**.
   Second refusal proof against a live overlap uses a **throwaway network created by the proof
   itself** (e.g. `10.249.0.0/24`) and removes only that self-created network afterwards.
3. **Concurrent-allocation proof:** two concurrent bare-level provisioner runs, no subnet env vars.
   Asserted: both logs show a `subnet <cidr> (auto)` line and the two CIDRs are **distinct** (the
   allocation guard worked); the losing run fails on the **container-name** conflict
   (`Conflict. The container name "/moss" is already in use`, #1618) and **never** on subnet
   overlap; afterwards `docker network ls` shows zero `uat-*` networks (both runs — including the
   name-collision loser — cleaned their own networks). Both-runs-fully-up is **not** asserted: full
   concurrent stacks are blocked by #1618 and that half of issue #1108's original acceptance is
   deferred to #1618 (amendment recorded on the issue).

Exact commands, expected exits, and evidence bounds live in the companion plan.

## Kill gate

The loser failing on the `container_name` conflict is the **expected** outcome (#1618), not a kill
signal. The kill trigger is the subnet guard itself misbehaving in the concurrent-allocation proof:
identical auto-selected subnets, a subnet-overlap failure surviving the bounded retry, or a leaked
`uat-*` network after teardown. On that observation, stop after Task 1+2 land their unit-tested
selection logic, report to the Coordinator, and let Ben decide the next step. Owner of the call:
Ben.
