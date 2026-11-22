# Connectors package

## 0.7.2

- Calendar's day-plan apply can add a planned block under a stable plan identity: the event id comes from the operation, not the content, and a retried insert collides instead of duplicating. A new lookup call reads one provider event back with the identity it was created with and its guest count, so a retry can prove the event is its own. Ordinary focus blocks keep today's behaviour.
- The apply create takes `provenance: { jarvisPlanId, jarvisBlockId, jarvisPlanRevision, jarvisOperationId }` — the jarvis names the provider tags use, because the host refuses to carry a bare `actorUserId` through any port call. The actor is never sent: the host names the signed-in person, and the provider event records that identity. Calendar's cache row records it too, under the same jarvis names with the revision as text (the TypeScript cache used plain names; a bare `actorUserId` cannot cross a port call, so this is the one shape every caller can send). A reserved addition is pinned to its start and never shifts; the caller should look the event up before creating, as the TypeScript apply loop does.
- The lookup answers `found:false` only for a clean miss or a cancelled event. Every error from it — a refused scope, a sign-in problem, an unreachable Google — means the outcome is unknown, never that the event is gone, exactly as the TypeScript apply records an unknown outcome on a failed readback.

## 0.7.1

- Offer validated chat tools and code-built approval fields. Normal writes show their returned result; sending asks first. Moving an event refuses missing or invalid guest counts before contacting the provider.

## 0.1.0

- Add the Connectors package: the list of connection providers, the signed-in person's connection accounts, and the Email and Calendar switches for each account.
- Read and write the same tables as the original server. Secrets are sealed in the original format and never returned, logged or sent through jobs.
- Add the connection health labels for mail and for Outlook calendar, and the Settings, Connections screen.
- Google, IMAP and Outlook sign-in and sync are not included. Revoking an account does not stop any sync job, because this package starts none.

## 0.4.0

- Add Refresh email. A signed-in person can ask all their connected Google and IMAP accounts to sync recent mail now, and see each account finish as succeeded, partial or failed.
- Today shows a Refresh email button when mail is more than a day old.
