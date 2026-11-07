# Rust port, Phase 0a: portability facts

- Task: JS-34. Part of #4027.
- Plan: `docs/superpowers/specs/2026-11-06-rust-port-plan.md`, Phase 0a.
- Key rules: `docs/superpowers/specs/2026-11-06-rust-port-data-and-install-rules.md`, "Keys and
  private data".
- Code: `rust-spike/`, a throwaway cargo workspace. `rust-spike/README.md` says how to run it.
- Run on 2026-11-07 with cargo 1.95.0 and Node 22.22.2.

## Summary

All four facts hold, so the Phase 0a kill gate does not fire. Phase 0b was not started.

| Fact                                                               | Result                      | Main evidence                                                                         |
| ------------------------------------------------------------------ | --------------------------- | ------------------------------------------------------------------------------------- |
| 1. Rust checks the app's password hashes                           | Holds                       | 26/26 app-made cases agree. The app accepts 11/11 Rust-made hashes.                   |
| 2. Rust opens the app's encrypted credentials                      | Holds                       | 27/27 envelopes and 4/4 family keys agree. The app opens all 4 Rust-made values.      |
| 3. Rust reproduces every migration checksum                        | Holds                       | 331 core files, 80 module files and 3 pinned checksums agree. 37/37 edge cases agree. |
| 4. Unlock and recovery with no terminal, on Linux with no keychain | Holds for every case tested | 36 tests, 26/26 planted bugs caught, 46 checks in a real browser.                     |

The tests were seen to fail as well as pass:

- Before the Rust code existed, 10 of the 14 tests for facts 1 to 3 ran red. The other four came
  with the code. Three test the JavaScript-compatible helpers, and one writes values for the app
  to check.
- Given three deliberately wrong Rust-made values, the app's check failed exactly those three.
- 34 planted bugs, 8 for facts 1 to 3 and 26 for fact 4, were each caught.

The red run, the failed check and every planted-bug run are attached to the task's proof.

One real difference turned up. Rust's Unicode tables are one version newer than Node's, so 68
rare characters normalise differently. A password containing one of them would hash differently
in Rust. Fact 1 has the details and a fix for Phase 1.

macOS and Windows are written up under fact 4, but nothing was tested on either.

## Method

- `rust-spike/fixtures-gen/generate.ts` runs the app's own TypeScript code and records what it
  makes in `rust-spike/fixtures/`. Nothing is reimplemented on the TypeScript side.
- Every password and key in the fixtures is a made-up value. No database was touched.
- The Rust tests read the fixtures. They must agree with every recorded value, including the
  app's error cases.
- `portability/tests/rust_made.rs` writes values made by Rust, and
  `fixtures-gen/check-rust-made.ts` checks them with the app's code. That covers the other
  direction.
- Planted bugs show that the tests can fail. Each run changes one line, runs the tests, records
  the result and restores the line.

## Fact 1: password hashes

**Result: holds.**

The format is better-auth 1.6.14 `salt:key`. The salt is 32 hex characters, used as text. The
key is scrypt (N=16384, r=16, p=1, 64 bytes) of the NFKC-normalised password, in lowercase hex.

Evidence, from `rust-spike/`:

```
cargo test -p portability --no-fail-fast -- --nocapture
```

```
passwords: 26/26 cases agree with Node
NFKC: 272/272 blocks of 4096 code points agree with Node (Node Unicode 17.0, Rust crate Unicode 18.0.0)
```

From the repo root:

```
pnpm exec tsx rust-spike/fixtures-gen/check-rust-made.ts <cargo target folder>/tmp/rust-made.json
```

The cargo target folder is `rust-spike/target` unless `CARGO_TARGET_DIR` says otherwise.

```
rust-made: 15/15 checks pass in the app's code (11 password hashes, 2 envelopes, 2 family key checks)
```

Planted bugs caught:

- scrypt block size changed from 16 to 8
- NFKC normalisation skipped

Differences found:

- **Unicode version.** The `unicode-normalization` crate follows Unicode 18.0. Node 22.22.2
  follows Unicode 17.0.
  - 68 code points are unassigned in 17 and get a mapping in 18: U+0558, U+058B-058C,
    U+209D-209F, U+107BB-107BF, U+1B123-1B126, U+1D6A6, U+1DF95, U+1DFCD-1DFFF.
  - Node leaves them unchanged and Rust maps them, so a password containing one would hash
    differently. The NFKC test counts a block as agreeing when the only differences are these
    code points.
  - Node itself drifts the same way whenever its ICU is upgraded.
  - Phase 1 should pin the Rust normaliser to the Unicode version the app used, or record the
    Unicode version beside each hash.
- **Timing.** The app compares password keys with `===`, which is not constant time. Rust uses a
  constant-time compare. Results are the same.

Unknown:

- Hashes from real accounts were not used, on purpose.
- Older better-auth hash formats, if any were ever written, were not looked for.

## Fact 2: credential envelopes

**Result: holds.**

Covered:

- version-1 AES-256-GCM envelopes from `packages/db/src/secret-cipher.ts` and `keyring.ts`
- the key ring, where each key is SHA-256 of its secret text
- key IDs, and the legacy search for envelopes with no key ID, which moves to the next key only
  when authentication fails
- `MOSS_` and `JARVIS_` key names, where the `MOSS_` name wins even when empty
- the family keys nested in the master key store (`packages/settings/src/master-key-store.ts`)

Evidence, from the same `cargo test` run:

```
envelopes: 27/27 agree with Node, 2 of them refused on purpose (never written by the app)
family keys: 4/4 envelopes agree with Node
```

The app also opens the 2 envelopes and 2 family key checks that Rust made (the 15/15 line above).

Planted bugs caught:

- key order taken from the source text instead of the app's map order
- legacy search stops at the first wrong key
- base64 decoder drops the URL-safe minus

Differences found, none of which affect anything the app writes:

- Rust refuses a 16-byte IV and a 12-byte tag. Node accepts both, but the app never writes them.
- A lone UTF-16 surrogate in a decrypted payload becomes U+FFFD in Rust, because a Rust string
  cannot hold one. Rust reports this rather than hiding it.
- JSON parse errors are worded differently. The fixtures only require an error.
- serde_json and `JSON.parse` differ on very large numbers and on nesting deeper than 128.

Unknown:

- Two branches of `loadFamilyKeyring` were not modelled, the env key that takes precedence and
  the development fallback. Both are plain key ring calls.
- Real stored envelopes were not used, on purpose.

## Fact 3: migration checksums

**Result: holds.**

Covered, from `packages/db/src/migrations/sql-runner.ts` and `module-sql-runner.ts`:

- SHA-256 of the raw SQL bytes
- the backfill domain `moss:sql-migration+backfill:v1` for files with a backfill sidecar
- JavaScript's default sort, which orders by UTF-16 code units
- JavaScript `trim` on backfill declaration lines, which also removes the `\r` of a CRLF
- byte-order marks, empty files, missing sidecars, bad UTF-8 and malformed backfill declarations
- the module runner's checksum of decoded text

Evidence, from the same `cargo test` run:

```
migrations: 331 core-runner files (2 with a backfill), 80 module-runner files and 3 pinned shim checksums checked; 0 disagree (fixture commit fd175ef0068a)
migration edge cases: 37/37 agree with Node, skipped ["module-refused-statement"] (validator not ported)
```

Planted bugs caught:

- backfill domain string changed
- UTF-16 sort replaced by byte sort
- JavaScript trim replaced by Rust trim

Differences found:

- With several bad files at once, Node reports whichever read fails first in time. Rust reports
  the first by name. Both stop startup.
- The module runner's SQL validator was not ported, so one edge case is skipped.

Unknown:

- The ledger of a real installed database was not compared, by decision. The runner stores the
  same checksum the fixture records, so the fixture is the ledger's input.
- File names that are not valid UTF-8 were not tested.

## Fact 4: key unlock and recovery with no terminal, on Linux with no keychain

**Result: holds for every case tested.** An owner sets up, restarts, loses the key file, recovers
from the 24 words and repairs a damaged or exposed key file, all through screens.

### What was built

- **Keychain check.** Moss asks the session bus for the Secret Service
  (`org.freedesktop.secrets`), which GNOME Keyring and KWallet both provide. A keychain counts as
  working only if it answers `OpenSession` within 3 seconds.
- **No session bus.** This counts only when no bus address is set and the runtime folder has no
  `bus` socket. A bus that is there but refuses the connection, or does not finish connecting
  within 3 seconds, counts as a broken keychain.
- **Key file only with no keychain.** Moss offers the key file only when there is no session bus,
  or when nothing provides or can start the Secret Service. A keychain that is present but fails
  never leads to the file. The owner has to choose it.
- **A second check before saving.** Setup checks the keychain again when the owner finishes the
  sheet check. The setup code itself refuses to write anything unless that check allows the key
  file.
- **Recovery key.** 256 random bits, written as 24 BIP39 words. The last word carries a checksum.
  There is no passphrase.
- **Key file.** `$XDG_CONFIG_HOME/moss/keys/recovery-store`, mode 0600 in a 0700 folder, outside
  the data folder. It holds the recovery key, protected only by file permissions.
- **Bundle.** `$XDG_DATA_HOME/moss/keys/credential-keys.json`.
  - The credential keys are sealed with a fresh data key, and the data key with the recovery key.
  - Both use AES-256-GCM with fresh 96-bit nonces.
  - The header binds kind, encoding version, installation ID, bundle ID, recovery key name and
    key store. It is the authenticated data for both seals.
- **Test credential.** An envelope in the app's v1 format, made at setup. Opening it proves the
  same keys came back.
- **Safe setup.**
  - Setup writes the test credential, then the bundle, then the key file.
  - Each write goes to a staging file, is synced, then renamed into place.
  - Setup refuses when a bundle or a key file already exists.
  - A failed write removes every file this setup wrote.
- **Safe recovery.**
  - Recovery makes the key folder private before writing into it, and refuses a folder that is
    a link.
  - A damaged key file is kept under a new name. Two in the same second get different names.
  - "Make it private" opens the file without following links or waiting on a pipe, and changes
    only a plain file.
- **Screens.** `keystore-ui` serves setup and recovery on 127.0.0.1.
  - Every account on the computer can reach 127.0.0.1, so the server prints a one-time link.
    Opening it gives that browser a cookie (HttpOnly, SameSite=Strict). Every other request
    needs the cookie, or gets a 403. That includes the recovery words page.
  - Forms also need a per-run token, and other host names are refused.
  - It sends a strict content policy, no caching, no framing and no referrer.
  - The cookie does not stop other programs running as the same account. They can read the
    browser's cookies or the server's output.

This matches each rule in "Keys and private data" that applies to a spike:

- the key file only by explicit choice, only with no keychain session, never after a keychain
  failure
- a random 256-bit recovery key with a checksum, and no passphrase
- setup says that losing both copies means no recovery
- a fresh data key per bundle and fresh nonces
- a header that binds kind, installation ID, key ID and version

### Evidence

From `rust-spike/`:

```
cargo test -p keystore --no-fail-fast
```

```
tests/probe.rs: 11 passed
tests/recovery.rs: 7 passed
tests/store.rs: 18 passed
```

The keychain tests run a private D-Bus session bus. A fake keychain on it can work, refuse,
never answer or fail to start. Other tests point the check at an address nothing listens on, a
stale socket and a socket that never answers.

Planted bugs, all 26 caught by the test meant for them:

- a broken keychain also offers the key file
- any answer from the keychain counts as working
- no time limit on the keychain's answer
- a session bus that fails counts as no bus
- no time limit on joining the session bus
- the bus socket in the runtime folder is never asked
- the set bus address is ignored
- setup writes the key file while a keychain is there
- folder permissions not checked
- key file permissions not checked
- sealed parts not bound to the bundle header
- test credential not checked
- files written readable by others
- a linked key file is followed
- stored key name not checked against the key
- typed words not matched to this setup first
- a damaged key file is deleted instead of kept
- a kept key file is replaced by the next one within a second
- recovery writes into the key folder without making it private
- making it private follows a link
- a pipe in place of the key file hangs "Make it private"
- a pipe in place of the key file is made private as if it were the file
- three-letter prefixes accepted
- a failed setup leaves its files behind
- setup replaces a key file whose bundle is missing
- a failed write leaves its staging file

The browser proof drives the real screens in Chromium the way an owner would. Each server runs
on its own session bus, with no keychain unless the step starts the fake one. All 46 checks pass.
They include requests sent without the browser's cookie, as another account would send them.
The first screen, the words page and a setup form with a valid token each get a 403, and the
one-time link works only once. With the cookie check removed, or the link left reusable, the
proof fails.

```
pnpm exec tsx rust-spike/keystore/proof/drive.ts <port> <scratch folder> <keystore-ui> <fake-secret-service>
```

| Screen | What it shows                                                     |
| ------ | ----------------------------------------------------------------- |
| 01     | First start on a computer with no keychain                        |
| 02     | The recovery sheet                                                |
| 03     | A failed sheet check names each wrong word and saves nothing      |
| 04     | Set up, with the keys' fingerprint                                |
| 05     | After a restart, unlocked with no prompt and the same fingerprint |
| 06     | The key file is gone, so Moss asks for the recovery words         |
| 07     | A typo is pinpointed, with a suggestion                           |
| 08     | Words from a different sheet are refused, naming both keys        |
| 09     | Recovered from a pasted sheet, with the same fingerprint          |
| 10     | A damaged key file is refused, and the words are asked for        |
| 11     | A key file other accounts could read is refused                   |
| 12     | Made private with one button, then unlocked                       |
| 13     | A broken keychain, with no key file offered                       |
| 14     | A working keychain is found, where the spike stops                |
| 15     | No desktop session at all, as on a server                         |
| 16     | A keychain appeared before the sheet check, so nothing was saved  |

The screenshots show throwaway words from a test run. They are attached to the task's proof,
not committed.

### Screen choices

These screens are a test harness, not a design proposal. The choices below are about behaviour,
and the real screens will follow the design system.

| Choice                                                                           | Why                                                             |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Offer the key file only with no desktop session or no keychain installed         | The rules forbid falling back to a file when a keychain fails   |
| A broken keychain gets an explanation, "Try again" and a "What Moss saw" section | The owner can act, and support can see the cause                |
| The setup choice says the file is only as safe as the disk                       | The rules forbid an at-rest claim without disk encryption       |
| The words page warns that losing both copies means no recovery                   | The rules require saying this during setup                      |
| Nothing is saved until the sheet check passes                                    | A sheet that was never written down is caught before it matters |
| The check asks for 3 random words                                                | Enough to catch a skipped sheet without retyping all 24         |
| The first 4 letters of a word are enough, in any case                            | No two BIP39 words share their first 4 letters                  |
| A failed check names each wrong word                                             | The owner fixes one word, not the whole form                    |
| Starting again makes a new key                                                   | An old, abandoned sheet can never open the keys                 |
| Recovery uses 24 boxes laid out like the sheet                                   | Copying is easier when the screen matches the paper             |
| Pasting the whole sheet into box 1 fills every box                               | An owner with a digital copy is done in one step                |
| A typo is named with its position and a likely word                              | Fixes the common mistake in one step                            |
| Typed words stay in their boxes after an error                                   | Nobody has to retype 23 good words                              |
| A wrong sheet is named by both key names                                         | The owner knows to fetch a different sheet                      |
| A damaged key file is set aside, not deleted                                     | It may still be needed to diagnose the damage                   |
| An exposed key file gets one "Make it private" button                            | Fixes the problem without a terminal                            |
| Word boxes turn off autocomplete, autocorrect and spellcheck                     | Recovery words should not reach a keyboard's memory             |

### macOS (untested)

- Keep the recovery key in Keychain Services as a generic password item for this app.
- Keychain access is tied to the app's code signature, so the signing team and bundle
  identifier must never change. An ad-hoc or differently signed build will prompt, or fail to
  read the item.
- Mark the item as never syncing to iCloud Keychain.
- Unknown: how a locked login keychain behaves for a background service, and what restore to a
  new Mac looks like.

### Windows (untested)

- Protect the recovery key with DPAPI for the current user. Credential Manager can hold the
  32-byte key, but its limit of about 2.5 KB rules out a whole key bundle.
- On a local account, an administrator's password reset makes DPAPI data unreadable. The
  recovery words are then the only way back, so the setup warning matters more on Windows.
- Unknown: whether a server install runs as a service account or as the user, and how DPAPI
  behaves for each.

### Unknown (fact 4)

- A real GNOME Keyring or KWallet was not used. The tests use a fake one on a private bus.
- A locked keychain that asks the user to unlock it was not tested.
- Flatpak and other sandboxes, where the keychain arrives through a portal, were not tested.
- Server mode with a service account was not tested.
- Storing keys in a working keychain was not built. The spike stops once one is found.
- The 3-second limit may be too short for a keychain that starts on demand and shows an unlock
  dialog. That fails safe, since the keychain counts as broken and no key file is offered, but
  the owner sees an error.
- No test used a real systemd user session, where the Secret Service starts on demand and may be
  slow.

## Not proven

- **Crash order during setup.** A failed write cleans up, and the order is chosen so a crash
  leaves something the owner can recover. A real crash between writes was not simulated.
- **The Unicode difference.** The 68 code points were found and listed. Their effect on a real
  sign-in was not tried.
- **Two setups at once.** Setup checks that no bundle or key file exists, then writes. Two setup
  servers running at the same moment could both pass the check. One server handles one request at
  a time, so this needs two servers.
- **Server limits.** The setup server handles one request at a time. It reads at most 64 KiB of a
  form and drops the rest without an error.
- **Keys in memory.** Keys are not wiped from memory after use. This was not built.
- **A fresh key for an exposed key file.** "Make it private" fixes the permissions, but anyone
  who read the file still has the key. The real product should also offer a new recovery key.
- **macOS and Windows.** Nothing was run on either.
- **Volume.** No real user data was used for any fact, on purpose.

## What Herdr does that Moss can borrow

Studied the installed Herdr 0.9.5, its task and fleet tools, and the herdr-core and herdr-app
sources.

### One program as desktop app and server

- Herdr is two programs. The core is a daemon that runs terminals and draws nothing. The app is
  a native client that finds a core, or installs one.
- A holder process owns each running program and keeps about 1 MB of its output, so programs
  survive a core restart.
- Moss can use the same split. One server process does the work, and the window, tray and phone
  are all clients of it.

### Long-running work

- On Linux, cores and holders run as systemd user services. A desktop crash, logout or ended
  SSH login cannot take them down.
- On macOS, a one-shot launchd job starts the core outside the app's process family, so macOS
  does not kill it when the app quits.
- One daemon runs per session, guarded by a lock file.

### Packaging and updates

- The app reads a `latest.json`, downloads the build, checks its SHA-256, unpacks it beside
  itself and swaps it in on restart.
- On macOS a release build must pass a strict code signature check. A known dev build is
  re-signed locally instead, and anything else is refused.
- On macOS the core lives at a fixed path behind a `current` link, which is swapped in one step.
- The macOS bundle identifier and signing team never change, so system permissions survive
  updates.
- **Do not copy.** On Linux a checksum from the same server is the only check. Moss's plan
  calls for a signed update channel, which is stronger.

### State on disk

- State lives in the standard per-user folders, with private file modes.
- Writes go to a temporary file and are renamed into place, so a reader sees old or new, never
  half.
- Shipped default files are upgraded only when the user has not edited them, judged by an exact
  match with an earlier original.
- The task tool keeps one JSON file per folder, written under a lock and replaced whole.

### Working rules

- One table lists every API call.
- Platform differences live in one module per platform.
- Code that decides is kept apart from code that does IO, so the deciding part is easy to test.
- Tests come first, and end-to-end tests run the real program.
- Reports say what was observed, not what should be true.
- Files stay small, around 32 KB at most.

Herdr has no keychain code, so it offered nothing for fact 4.

## Tools not available

- `rustfmt` and `clippy` are not installed, and installing them was out of scope. The code was
  not formatted or linted by them. To add them:

  ```
  rustup component add rustfmt clippy
  ```

- The box's browser helper could not run, because a tool it needs is missing. The browser proof
  used the repo's own Playwright and Chromium instead.
- A one-off type check of the spike's TypeScript scripts reports 10 errors in
  `packages/ai/src/terminal-routes.ts`. They appear without the spike's files too, so they come
  from the one-off check's setup, not from the spike.
