# Rust port, Phase 2 part 1: safety core

- Task: JS-38, card 185. Part of [issue 4027](https://github.com/motioneso/moss/issues/4027).
- Plan: `docs/superpowers/specs/2026-11-06-rust-port-plan.md`, Phase 2 and section 3.
- Phase 2 part 2 (queue, modules, routing): `docs/superpowers/specs/2026-11-07-rust-phase2b-report.md`.
- Code: `rust-spike/safety-core/`, `rust-spike/access-context/`, `rust-spike/vault/`, the safety
  cases in `rust-spike/parity/cases/20-safety-1.json` and `20-safety-2.json`, and
  `rust-spike/tools/`. `rust-spike/README.md` says how to run them.
- Run on 2026-11-07 at commit `f7a0055ad` with cargo 1.95.0, Node 22.22.2 and Postgres 17.11
  (pgvector image), each database run inside its own throwaway gate. Later commits change only
  this report.

## Summary

The Rust server now signs people in, keeps each person's data private from everyone else,
admins included, and keeps secrets out of replies, logs and job payloads. It does this the same
way the TypeScript server does, and Tasks runs on it.

- Both servers pass the same nine privacy and secrecy cases, and all 77 side-by-side cases match.
  Two of the nine test only the database rules both servers share.
- Each of the 17 protections was removed in turn, and its check caught the removal every time.
- That meets this part's share of the Phase 2 kill gate.
- One database rule lets an admin's blanket update change an AI key row that admin cannot see.
  The rule is live in the TypeScript app's database, but the app never sends such an update. A
  new migration should close it. An issue for it is drafted and not yet filed.
- The Rust server has no rate limits yet. TypeScript allows 10 sign-in, sign-up and password
  requests a minute from one address.
- Phase 2b built its own workspace in `rust-spike/platform/`, the folder this crate used. This
  crate moved to `rust-spike/safety-core/`, and the branch is merged with main.

## What was built

| Part                   | What it does                                                                                                                                                   | Code                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Sign-in and sessions   | Sign-up, sign-in, sign-out and `/api/me` with the TypeScript cookies, password hashes, validation messages and 7-day sessions, renewed after a day             | `safety-core/src/auth.rs`              |
| Origin check           | Refuses a sign-in posted from a page the server does not trust                                                                                                 | `safety-core/src/origin.rs`            |
| Data context and roles | Each query runs in a transaction as a no-bypass role with the actor set, so row-level security applies to admins too. Start-up refuses a role that can skip it | `safety-core/src/db.rs`                |
| Admin routes           | List, approve, reactivate, deactivate (ends sessions), end sessions, promote, demote. Reject and delete check every guard, then answer 501                     | `safety-core/src/admin.rs`             |
| Connector accounts     | List and add. The secret is sealed before it is stored, and replies only say whether one exists                                                                | `safety-core/src/views.rs`             |
| Secret cipher          | The TypeScript AES-256-GCM envelope and keys. The secret type cannot be printed                                                                                | `safety-core/src/secret.rs`            |
| Log redaction          | One log writer, start-up errors included. Every line passes the TypeScript sanitizer's secret-name rules, and the request log drops query strings              | `safety-core/src/redact.rs`, `http.rs` |
| Job payloads           | Ids, fixed choices, small numbers, flags and hashed keys only. There is no free-text field                                                                     | `safety-core/src/payload.rs`           |
| Module SQL refusal     | Refuses module SQL that touches another module's tables or the shared migrations folder                                                                        | `safety-core/src/module_sql.rs`        |
| Vault                  | Opens only the acting user's folder, from their access context. Refuses `..`, links and malformed names                                                        | `vault/src/lib.rs`                     |
| Rules check            | Five rules the compiler cannot see: file access, file serving, secret reads, privileged database addresses and prints                                          | `tools/check-safety-rules.sh`          |
| Removal run            | Removes each protection in a copy and checks that a test fails                                                                                                 | `tools/remove-protections.sh`          |
| Side-by-side additions | Cookies by name, field comparisons, absent fields, SQL probes as any role and actor, a log scan for planted secrets, recorded observations                     | `parity/`                              |

- Tasks now uses this crate for sign-in, data access, errors and its one job.
- Sizes: `safety-core` is 4,087 lines including 44 unit tests. `vault` is 385 lines with 4 tests.
  `access-context` is 37 lines with 1 test.
- The job queue in `safety-core/src/queue.rs` is a stand-in for Tasks' one job. Phase 2b's
  `jobs` crate should replace it.

## Evidence

All logs and reports are kept outside the repo in the task's scratch folder.

### Unit tests

167 tests pass on `f7a0055ad` with no warnings.

| Crate                                      | Tests |
| ------------------------------------------ | ----- |
| `safety-core`                              | 44    |
| `access-context`                           | 1     |
| `vault`                                    | 4     |
| `tasks`                                    | 14    |
| `parity`                                   | 9     |
| Phase 0 crates (`portability`, `keystore`) | 53    |
| Phase 1 crate (`bundled-db`)               | 42    |

### Side-by-side run

Gate log for run 6, commit `f7a0055ad`, clean tree, `### FINAL rc=0`:

```text
PASS safety: member isolation, another member's task reads as missing
PASS safety: admin cannot read a member's private data
PASS safety: the app and worker roles cannot read sign-in secrets
PASS safety: account lifecycle, pending to approved to deactivated and back
PASS safety: account guardrails hold for admins
PASS safety: the bootstrap owner cannot be deactivated, demoted or deleted
PASS safety: connectors are private and never return the secret
PASS safety: AI credentials stay with their owner
     recorded {"step":"admin edits AI keys with no filter (observed, not asserted)","side":"TypeScript","output":{"rows":[],"affected":[1]}}
     recorded {"step":"admin edits AI keys with no filter (observed, not asserted)","side":"Rust","output":{"rows":[],"affected":[1]}}
PASS safety: passwords never come back or reach a log
PASS server logs hold no MOSS-SENTINEL- value
PARITY 77/77 cases match
```

| Case                              | What both sides showed                                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Member isolation                  | B gets 404 on A's task and lists only B's own. SQL run as B counts none of A's rows. A's task is unchanged                                                                            |
| Admin cannot read private data    | The admin gets 404 on A's task and empty lists. SQL run as the admin counts none of A's tasks, connectors or AI keys                                                                  |
| Roles cannot read sign-in secrets | Database rules only, with no web request. The app and worker roles are refused on the sign-in tables. The sign-in role may query them, so the refusal comes from the role             |
| Account lifecycle                 | A pending member is held and approval lets them in. Deactivation ends the session, and a new sign-in is held. Reactivation does not revive the ended session. The audit trail matches |
| Admin guardrails                  | Members get 403 and strangers 401. An admin cannot delete or deactivate their own account, and the last admin cannot step down. The audit trail matches                               |
| Bootstrap owner                   | An admin gets 409 trying to deactivate, demote or delete the bootstrap owner, and the account is unchanged                                                                            |
| Connectors                        | Replies carry no secret, other members and the admin see nothing, and the stored secret is a sealed envelope                                                                          |
| AI credentials                    | Database rules only, with no web request. SQL run as B, as the admin and as a job for B counts none of A's keys. Edits by B and the admin change nothing. A sees the key              |
| Passwords                         | A wrong password and an unknown email both get 401, and the stored value is a hash. The planted password never reaches either server's log                                            |

- The roles case and the AI case send no web request. They run SQL straight against each side's
  database copy, so they test the database rules both servers share, not Rust code. Rust has no
  AI routes yet.
- Each server's log is scanned after the last case for any `MOSS-SENTINEL-` value. None was found.
- All 546 lines of the Rust server's log in run 6 are JSON from the one log writer.

### The first run found real differences

Run 1 (`1a260ce3f`) matched 71 of 76 cases. The rest were real differences or wrong expectations.

| Difference                                                                                            | Outcome                                                                            |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Rust's `/api/me` lacked `profilePrefs` and `hasPasswordCredential`                                    | Added                                                                              |
| Sign-out cleared one cookie, TypeScript clears three                                                  | Rust clears the same three                                                         |
| A bad sign-up email gave `INVALID_EMAIL` in Rust, `VALIDATION_ERROR` with zod's message in TypeScript | Rust checks bodies the way TypeScript's request layer does, with the same messages |
| Reading another member's task activity answers 200 with an empty list on both servers                 | The expectation was wrong. Row-level security hides the rows                       |
| Audit rows carry `req-N` request ids in TypeScript and UUIDs in Rust                                  | Compared by presence only                                                          |
| The password case hit TypeScript's first-user path, which answers 500                                 | The case now seeds an owner and open registration                                  |

### Removal run

Each removal edits a fresh copy of the code at the commit, then runs one check that must fail.
The run used commit `f7a0055ad` on a clean tree and ended `### FINAL rc=0`. All 17 were caught.

| Protection removed                                                                                                              | What failed                                                                            | Exit |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---- |
| Module SQL refusal treats every table as the module's own                                                                       | 2 module SQL unit tests                                                                | 101  |
| The secret type made printable with `derive(Debug)`                                                                             | The build, through a compile-time check                                                | 101  |
| Log redaction passes lines and JSON through unchanged                                                                           | 2 redaction unit tests                                                                 | 101  |
| The vault stops refusing `..`                                                                                                   | The vault's climb-out test                                                             | 101  |
| The origin check dropped from sign-up, sign-in and sign-out                                                                     | The sign-in route test                                                                 | 101  |
| Code added that reads a file, serves a folder and a single file, reads a secret and the privileged database address, and prints | All five rules                                                                         | 1    |
| The start-up role guard switched off                                                                                            | The guard script's own copy starts on a role that skips row-level security             | 0    |
| The connector list returns the sealed secret                                                                                    | The connectors case                                                                    | 1    |
| Requests run on the privileged connection with the role guard off                                                               | The admin case                                                                         | 1    |
| Sign-in prints the request body                                                                                                 | The log scan                                                                           | 1    |
| The data context acts as member A for every request                                                                             | The member isolation case. B reads and edits A's task                                  | 1    |
| The account check lets pending and deactivated members in                                                                       | The lifecycle case. Both get 200 where TypeScript holds them with 403                  | 1    |
| Deactivation leaves the member's sessions open                                                                                  | The lifecycle case. The old session works again after reactivation                     | 1    |
| Admin routes skip the admin check                                                                                               | The guardrails case. A member and a former admin list every user                       | 1    |
| An admin may deactivate their own account                                                                                       | The guardrails case. The last-admin guard refuses with 409 where TypeScript gives 422  | 1    |
| The last admin may step down                                                                                                    | The guardrails case. The last admin's demotion goes through                            | 1    |
| The bootstrap owner's three guards removed                                                                                      | The bootstrap owner case. Deactivate and demote go through, and delete reaches the 501 | 1    |

- The role guard script carries its own removal, so its pass (exit 0) is the caught result. In
  eight steps it shows the real build refusing each wrong role and the copy without the guard
  starting.
- The planted password reached the Rust log three times, and the scan failed the run.
- Without the self-deactivation guard, the last-admin guard still refused the admin, but with a
  different answer, and the case caught that. With a second admin the self-deactivation would go
  through. No case sets that up.

Failing output, from the gate log and each removal's own log, with long lines cut:

```text
module-sql-owner: caught (exit 101)
  ---- module_sql::tests::accepts_every_shipped_module_migration stdout ----
  ---- module_sql::tests::refuses_sql_that_reaches_past_the_module stdout ----
  test result: FAILED. 7 passed; 2 failed; 0 ignored; 0 measured; 35 filtered out; finished in 0.03s
secret-debug: caught (exit 101)
  error[E0283]: type annotations needed
    --> safety-core/src/secret.rs:63:22
  63 | assert_not_impl_any!(Secret: fmt::Debug, fmt::Display, serde::Serialize, Clone);
  error: could not compile `safety-core` (lib) due to 1 previous error
redaction: caught (exit 101)
  ---- redact::tests::json_values_under_secret_names_never_survive stdout ----
  ---- redact::tests::free_text_credentials_never_survive stdout ----
  test result: FAILED. 1 passed; 2 failed; 0 ignored; 0 measured; 41 filtered out; finished in 0.00s
vault-dotdot: caught (exit 101)
  ---- tests::refuses_paths_that_climb_out stdout ----
  test result: FAILED. 3 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
origin-check: caught (exit 101)
  ---- origin::tests::the_sign_in_routes_run_both_checks stdout ----
  test result: FAILED. 7 passed; 1 failed; 0 ignored; 0 measured; 36 filtered out; finished in 0.00s
static-rules: caught (exit 1)
  BROKEN: 1 file access goes through the vault crate
  BROKEN: 2 only the start-up code serves files
  BROKEN: 3 secrets are read only where they are used
  BROKEN: 4 no connection that skips row-level security
  BROKEN: 5 every log line goes through the redacting writer
role-guard: caught (exit 0)
  4 app role can bypass row security: refuses (wanted refuses)
  5 same, with the check switched off: starts (wanted starts)
  6 app role is a superuser: refuses (wanted refuses)
  7 same, with the check switched off: starts (wanted starts)
connector-envelope: caught (exit 1)
  FAIL safety: connectors are private and never return the secret
       step A lists connectors: Rust output holds "encryptedSecret"
       step A lists connectors: Rust output holds "ciphertext"
admin-bypass: caught (exit 1)
  FAIL safety: admin cannot read a member's private data
       step admin reads A's task: /status: TypeScript 404 vs Rust 200
       step admin lists tasks: /body/tasks: TypeScript has 0 items, Rust has 2
password-logged: caught (exit 1)
  FAIL server logs hold no MOSS-SENTINEL- value
       Rust server log: 3 lines hold MOSS-SENTINEL-
wrong-actor: caught (exit 1)
  FAIL safety: member isolation, another member's task reads as missing
       step B reads A's task: /status: TypeScript 404 vs Rust 200
       step B edits A's task: /status: TypeScript 404 vs Rust 200
account-status: caught (exit 1)
  FAIL safety: account lifecycle, pending to approved to deactivated and back
       step pending member is held: /status: TypeScript 403 vs Rust 200
       step deactivated member is held: /status: TypeScript 403 vs Rust 200
session-revoke: caught (exit 1)
  FAIL safety: account lifecycle, pending to approved to deactivated and back
       step deactivation ended the session: /status: TypeScript 401 vs Rust 403
       step the ended session stays ended: /status: TypeScript 401 vs Rust 200
admin-check: caught (exit 1)
  FAIL safety: account guardrails hold for admins
       step member lists users: /status: TypeScript 403 vs Rust 200
       step former admin lists users: /status: TypeScript 403 vs Rust 200
self-deactivate: caught (exit 1)
  FAIL safety: account guardrails hold for admins
       step admin deactivates self: /status: TypeScript 422 vs Rust 409
last-admin: caught (exit 1)
  FAIL safety: account guardrails hold for admins
       step last admin demotes self: /status: TypeScript 409 vs Rust 200
bootstrap-owner: caught (exit 1)
  FAIL safety: the bootstrap owner cannot be deactivated, demoted or deleted
       step deactivate the owner: /status: TypeScript 409 vs Rust 200
       step demote the owner: /status: TypeScript 409 vs Rust 200
       step delete the owner: /status: TypeScript 409 vs Rust 501
```

### Rules check

```text
ok: 1 file access goes through the vault crate
ok: 2 only the start-up code serves files
ok: 3 secrets are read only where they are used
ok: 4 no connection that skips row-level security
ok: 5 every log line goes through the redacting writer
```

## Finding: the AI key update rule

- The update rules on `app.ai_provider_configs` and `app.ai_configured_models`
  (`packages/ai/sql/0091_chat_model_override.sql`) allow any admin.
- Postgres adds the select rule to an update only when the statement reads a column.
- So an admin's update with no `WHERE` and no `RETURNING` reaches rows the select rule hides from
  that admin. A recorded step in the AI case runs one as the admin, straight against each side's
  database: `"affected":[1]`, the member's own key. The same admin's filtered update changed 0
  rows.
- The app never sends such an update. All seven updates on these tables in
  `packages/ai/src/repository.ts` (lines 572, 593, 822, 1065, 1070, 1152 and 1201) filter by a
  column, so the select rule applies. So do its two deletes (lines 765 and 783).
- The delete rule on `app.ai_configured_models`
  (`packages/ai/sql/0163_ai_cli_model_reconcile_delete.sql`) has the same shape: any admin, any
  row but the default. No case tests it.
- Changing a hidden row's `base_url` would send that key to another server. This is a database
  rule shared by both servers, not a Rust difference.
- Fix: a new migration whose update and delete rules add the select rule's owner-or-admin-created
  condition. Never edit 0091 or 0163.
- An issue is drafted but not yet filed, because filing one was outside this task's permissions.

## Differences kept on purpose or not yet ported

| Area                                                         | TypeScript                                                                                                   | Rust                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| Rate limits                                                  | 10 a minute per address on sign-in, sign-up and password posts. 2,000 a minute per caller on everything else | None                               |
| "Remember me" off, session IP address                        | Supported                                                                                                    | Not ported                         |
| Session-ended notices and job clean-up after account changes | Sent                                                                                                         | Not ported                         |
| `callbackURL` and `redirectTo` checks                        | Checked                                                                                                      | `callbackURL` accepted and ignored |
| Form-encoded sign-in bodies                                  | Accepted                                                                                                     | JSON only                          |
| A body that is not a JSON object                             | Validation message per field                                                                                 | "Invalid body"                     |
| Non-UUID admin `:id`                                         | 500                                                                                                          | 404                                |
| First-user sign-up failure (seeded state only)               | 500, no body                                                                                                 | 422 `FAILED_TO_CREATE_USER`        |
| Ending a user's sessions                                     | Two statements                                                                                               | One transaction                    |
| Connector token payload                                      | Any JSON                                                                                                     | Text values only                   |
| Job send                                                     | After commit                                                                                                 | Inside the request transaction     |
| Idempotency key in the job                                   | Raw text                                                                                                     | sha256                             |
| Job task id                                                  | The path text                                                                                                | The row's lowercase UUID           |
| Default listen address                                       | 0.0.0.0                                                                                                      | 127.0.0.1, set with `HOST`         |
| Empty `JARVIS_AUTH_BASE_URL`                                 | Trusts the request's own address                                                                             | Counts as unset                    |
| Refused-origin log                                           | Raw referer                                                                                                  | Origin only                        |
| Audit request ids                                            | `req-N`                                                                                                      | UUID                               |

## Phones and other computers

- `HOST` sets the listen address, so the server can listen on the LAN or tailnet.
- A browser sign-in from a phone needs that page's address in `JARVIS_AUTH_TRUSTED_ORIGINS`, or
  in the base URL, the same as TypeScript today.
- Cookies are marked secure when `JARVIS_TRUST_PROXY` says the server sits behind HTTPS.
- Recommended: the desktop app fills the trusted list from its own LAN and tailnet addresses, or
  offers a setting in the app. Nobody should have to edit a settings file to sign in from a phone.
- Not tested on a real phone or a second computer.

## Not proven

- Sign-in from a phone or another computer.
- The origin check side by side. Both servers run in test mode there, which turns it off, so unit
  tests cover it instead.
- Rust opening a connector secret that TypeScript sealed, through the connector code. The cipher
  underneath was proven in both directions in Phase 0a.
- Secrets in exports and AI prompts. Rust has no export or prompt code yet.
- Wiping secret memory on drop. The code does it, but no test can observe it.
- Load, speed and long-running sessions.
- macOS and Windows. Every run was on Linux.
- Session renewal after a day. It is ported, but no case waits that long.

## How to proceed

1. Join this crate with Phase 2b, following `rust-spike/platform/README.md` ("Safety-core joins").
   - Build 2b's actor from this crate's session resolver.
   - Run 2b's configuration and endpoint stores inside a `DataContext`.
   - Move Tasks' job onto 2b's `jobs` crate and drop `queue.rs`.
   - Let the module SQL refusal read table ownership from 2b's registry.
   - Use one Cargo workspace once the product binary starts.
2. Add the rate limits before the Rust server listens beyond the machine it runs on. At the same
   time, end a refused request's transaction and return its connection to the pool. Today a 403
   or 404 after the data context opens throws the connection away.
3. File the drafted issue for the AI key rule migration, covering the update rules and the
   configured-models delete rule. It affects the TypeScript app today.
4. Give the trusted-origins list a way to be set in the app, then test sign-in from a phone.
5. Port "remember me", the session IP address, session-ended notices and job clean-up when the
   screens that use them move to Rust.
