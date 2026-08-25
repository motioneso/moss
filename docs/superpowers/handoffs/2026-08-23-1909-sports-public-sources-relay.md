# #1909 Sports public sources relay

## Authority

- Issue: #1909, open and In Progress.
- Approved spec: `docs/superpowers/specs/2026-08-23-1909-sports-public-source-completion.md`.
- Approved plan: `docs/superpowers/plans/2026-08-23-1909-sports-public-source-completion.md`.
- Branch: `build/1909-sports-public-sources`.
- Worktree: `/tmp/issue-1909-sports` (reuse it; `[ -d node_modules ] || pnpm install`).
- Ponytail full mode remains active. This is relay depth 1; do not relay again. If another context
  warning fires, push the green checkpoint and report that the next unit needs re-scoping.

## Shipped checkpoints

- `f429f6edb` — isolated no-egress Playwright renderer and release boundary.
- `7d6665d62` — closed declarative recipe schema, extraction, fingerprints, and slot encoding.
- `69a546cbe` — migration 0191, persistence/contracts, assignment cap, and worker export grants.
- `8bfb1f812` — feed-first/static/browser-fallback recipe discovery and production broker wiring.
- `bdb920667` — generic team/league target mappings, exact pasted-target fallback, actor-bound
  preview artifacts, owner-locked new-source confirmation, verified target health persistence, and
  settings preview/acknowledgement flow.

The shared checkout was never used. `STATE-1909.md` is local-only and must never be committed.

## Verified state

- 65 focused discovery/routes/settings/client tests pass.
- Root, test, web, and external-module TypeScript pass.
- Scoped ESLint, Prettier, and `git diff --check` pass.
- Full isolated `pnpm test:integration` passed with `rc=0`:
  `/tmp/jarv1s-gate/issue_1909_sports-20260823-215558.log`.
- Branch is pushed through `bdb920667`; worktree is clean except `STATE-1909.md` before this
  handoff commit.

## Start here

Continue the approved plan at Slice 2's remaining assignment-replacement and recipe-rebuild
artifacts/services/routes, then Slice 3's runtime reader. The production symptom is **not fixed**
until the reader consumes saved assignments and transactionally advances target/source
`last_checked_at`, `last_success_at`, health reason, and message.

Use Codebase Memory MCP before code discovery. Read only the relevant plan sections (Slice 2
declarative discovery/service checks and Slice 3), not the full plan. Preserve these invariants:

- Public unauthenticated publishers only; credentials remain #1682.
- No FotMob/domain adapters or allowlists; FotMob is only a generic fixture/acceptance example.
- Runtime refresh never launches a browser and every external byte uses pinned safe fetch.
- Application expands validated recipe slots; AI never supplies executable scraper code.
- Confirmation artifacts are actor-scoped, one-use, baseline-bound, and the only recipe/target
  authority. REST/settings/Moss share the same service.
- Assignment replacement reuses unchanged verified targets, makes no request for removals-only,
  previews every added/changed target, takes the owner advisory lock, then atomically replaces.
- Reader results carry recipe fingerprint plus persisted assignment identity; stale in-flight
  results cannot overwrite a rebuild/replacement.
- Custom article links are output-only. ESPN article-body enrichment must remain trusted-origin
  only. One target failure must not block siblings or ESPN.
- Never run DB tests directly. Use `scripts/run-gate.sh start`, `wait`, and `status`.
- Use explicit path staging; never add `STATE-1909.md`.

First concrete step: add the typed assignment-replacement artifact and repository baseline/read
surface, replace the direct assignment `PATCH` with preview/confirm service routes, and prove
removals-only zero-fetch plus unchanged-target health retention. Commit and push that green unit
before beginning the reader.
