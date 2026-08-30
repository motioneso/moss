# Issue audit handoff — 2026-08-26

GitHub is the source of truth. Skip issues already in the **Ready** lane.

## Decisions

- **Issue sizing rule:** implementation issues must fit approximately one agent session. Oversized
  work becomes a parent tracker with session-sized child issues so one session can hold the full task
  in memory.
- **Tracker lane rule:** when a parent tracker has active Ready or In progress child work, keep the
  tracker in Ready so the work remains visible; do not leave an active tracker in Backlog.

- Closed: **#1084, #827, #871**.
- Kept: **#819** (already Ready).
- Moved **#901** to `RFA` after accepting its approved self-hosted TLS spec; its four child issues
  remain the implementation scope.
- Closed **#869** after its implementation slices landed; #871 was explicitly not planned and #872
  was superseded.
- Closed **#951** after confirming the cross-owner module-KV purge landed in the boot supervisor via
  the #964/#980 module-distribution work.
- Closed **#926** after Phase 1; split remaining Food work into **#2001–#2004**.
- Closed oversized roll-up **#2000**.
- Closed **#1069** as not planned: personal export already ships; an instance-wide private-data
  export has no agreed bounded scope and cannot create an admin private-data bypass.
- Closed **#1070** as not planned: scheduled DB/vault backups and restore safeguards already exist;
  in-app status and true point-in-time recovery are not currently product requirements.
- **#2001** has an approved photo-logging spec and is RFA/Ready for agent.
- **#2002–#2004** still need individual briefs/specs.

## Repo-wide open-issue audit update

- Repo-wide audit covered the 120 open GitHub issues visible at the start of this pass. The live
  GitHub snapshot on 2026-08-27 contains **129 open issues**: the population changed as the audit
  created session-sized child issues and closed stale items. Keep the historical audit count and
  current open count distinct in progress reports. **#1710** and **#1791** were closed as completed
  because their fixes are already on main.
- The last reliable Project 2 snapshot contained 11 Ready issues: **#819, #901, #906, #950,
  #1106, #1421, #1424, #1488, #1508, #1558, and #1559**. The current GitHub issue bodies and
  timeline events still show these issues open; GraphQL board reads are currently unavailable from
  the CLI.
- Promoted to Ready during this pass: **#1424, #1558, #1559**. Already Ready: **#819, #901, #906,
  #950, #1106, #1421, #1488/#1508**.
- Additional evidence-backed Ready candidates were recorded on GitHub but their Project 2 field
  updates were blocked by a temporary GitHub GraphQL rate limit: **#1502, #1638, #1652, #1673,
  #1685, #1719, #1738, #1784, #1835, #1860, #1876, #1898, #1900, #1902, #1920, #1928, #1979,
  #1999, #2005, #2010**. Apply the tracker rule to **#1427** after #1502 and to **#1003** after
  #2010; parent trackers with active Ready children belong in Ready.
- Remaining open issues were left in Backlog when they were missing a spec/design decision,
  oversized, dependency-blocked, explicitly deferred, host-dependent, or already active in a PR.

### Ready-lane sizing verification

The 11 Ready issues satisfy the session-sizing rule as follows:

- Tracker parents with session-sized children: **#819 → #2012–#2015**, **#901 → #1504–#1507**,
  **#906 → #2016–#2019**, **#950 → #2005–#2008**, **#1424 → #2020–#2022**, and
  **#1488 → #1508**. Each child issue states its owned scope, dependencies, and exclusions.
- Bounded one-session implementation/UAT issues: **#1106, #1421, #1508, #1558, and #1559**.
- Parent-level slice indexes for **#819, #906, and #1424** were added as audit comments on
  2026-08-27; the child issue bodies already carry the parent links.

## #950 audit update

- Draft spec: `docs/superpowers/specs/2026-08-26-950-news-credentialed-publisher-sources.md`.
- Arbitrary URLs remain available for public-source discovery; credentials are accepted only for
  exact, reviewed, code-owned publisher connections.
- NYT-like subscription login, cookies, OAuth, paywall scraping, and arbitrary authenticated
  endpoints remain out of scope for this release.
- Created and natively linked four session-sized child issues, all in Project 2 / Backlog:
  - **#2005** — credential storage and owner-scoped lifecycle.
  - **#2007** — reviewed API-key publisher connection runtime.
  - **#2008** — News Settings connection flow.
  - **#2006** — compilation, health, and live-path hardening.
- **NewsAPI** is now the approved first connection: fixed `X-Api-Key` header and bounded
  `/v2/top-headlines` request. It is an upstream aggregator, not an NYT-like subscription.
- **#950** is ready for implementation planning; the parent and children remain session-sized.

## #1003 disposition

Continue with **#1003** as an Apple Calendar protocol/authentication feasibility parent. iCloud Mail
is already shipped through generic IMAP. The focused spike spec is
`docs/superpowers/specs/2026-08-26-1003-apple-calendar-feasibility-spike.md`.

- **#2010** is the one-session feasibility-spike child; it is the only current implementation scope.
- Do not create Calendar implementation children until the spike records a Supported decision or Ben
  explicitly accepts a Conditional/experimental path.
- The default outcome is Deferred if the only evidence is an undocumented or reverse-engineered
  CalDAV endpoint/authentication flow.

## #1061 follow-up

- #1061 is reduced to removing the disabled GitHub promise from Settings → Connected accounts.
- Close #1061 when that cleanup merges; do not build a GitHub connector from the current issue.

## Current next

- The #1061 settings cleanup is complete in the working tree and awaits merge before #1061 closes.
- After #1061 closes, continue with the earliest remaining open Backlog issue; #1069 and #1070 are
  closed as not planned.
