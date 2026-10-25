# Computer prelaunch handover: plan merged, next contract named

PR 3686 merged the [handover plan](../plans/2026-10-24-moss-computer-prelaunch-handover.md).
Accepted by fresh Security and Standards/Spec reviewers at head 1170863e0. No code exists.
`unavailableAdmission` is unchanged. Parents #3577, #3616, #3617, #3618 and #3619 stay open.

## Settled in shape (prelaunch phase only)

- Launcher starts a lifetime-free `hold` watchdog and reads its identity itself.
- A one-shot `prelaunch` sampler returns a nonce-bound sample over a pipe only the launcher holds.
- The used-sample mark lives in launcher memory and is consumed at the first (gateway) create.
- Boot ID comes from the pinned configuration.

## Open prerequisites (nothing is buildable until the first is settled)

1. The prelaunch runner. The pinned loader (trust.ts:331-334) needs a live runner with null
   stdout and stderr, and a heartbeat pipe for non-collectors, before any configuration loads.
   Nothing says what that runner is before launch.
2. The `hold` startup acknowledgement (the watchdog exits after 5s, computer-watchdog.ts:12-17).
3. Where the node, artifact and config paths are pinned for the launcher.
4. The bound second phase and the first complete healthy sample from the watchdog's journal.
5. Installed delivery, orphan `hold` cleanup, and any runtime packet.

## Next

Write and review a contract for open item 1 (and 2, 3 with it). It may need a decision from Ben
about what the pinned runner is before launch. Then build the host-only prelaunch sample.
