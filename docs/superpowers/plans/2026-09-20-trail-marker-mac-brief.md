# Brief: building Trail Marker on the Mac

For the session that picks up issue #2560 on Ben's MacBook. The Linux half is merged; this
covers everything that needs a Mac.

**Write in plain English.** Ben reads status to know whether the work is going well, not to
review code. Name things by what they do, not by what the repo calls them. Keep exact names only
where he has to act on them — a command to run, a file to open, an error to search for. If a
sentence has more than one backtick, say it again without them. This applies to every agent you
spawn, so put this paragraph in every brief you write.

---

## 1. What already exists

Merged to `main` as `a5082f82e` (PR #2564), live-proved against the dev instance.

| Piece                 | Where                                                             |
| --------------------- | ----------------------------------------------------------------- |
| Protocol contract     | `packages/shared/src/companion-api.ts`                            |
| Pairing service       | `packages/auth/src/companion-pairing.ts`                          |
| HTTP routes           | `apps/api/src/companion-routes.ts`                                |
| Browser approval page | `apps/web/src/companion/link-trail-marker-page.tsx`               |
| Plan (tasks 10-15)    | `docs/superpowers/plans/2026-09-20-trail-marker-mac-companion.md` |
| Spec                  | `docs/superpowers/specs/2026-09-20-trail-marker-mac-companion.md` |
| Design guide          | `docs/specs/Trail Marker/trail-marker-design-guide/`              |

The design guide is the authority for every Mac screen. It ships `DesignTokens.swift` to copy in
and the mark in both monochrome and colour. The Moss web design system does not apply to the Mac
app.

## 2. The protocol, in one page

Protocol version 1. Ask `GET /api/companion/protocol` first; it answers
`{"product":"moss","companionProtocol":1}`. Refuse any instance that answers something else or
nothing.

**Linking.** The Mac invents a secret it never sends, called the verifier — 43 base64url
characters. It sends only the sha256 of that secret, base64url, no padding.

1. `POST /api/companion/pair` with the device name, platform `macos`, app version, OS version and
   the verifier hash. Back comes an attempt id, a path for the browser, a poll interval in
   seconds, and an expiry ten minutes out.
2. Open the returned path in the real browser. The path already carries the approval code after a
   `#`, so use it exactly as given and never rebuild it. A `#` fragment is the one part of a web
   address a browser never sends to a server, which is why the code lives there. Putting it
   anywhere else in the address writes a live secret into server logs.
3. `POST /api/companion/pair/redeem` with the attempt id and the raw verifier, every poll
   interval. It answers 202 with a status while waiting — `pending`, `denied`, `expired`,
   `redeemed`, `unknown` — and 200 with the credential once the person approves. `unknown` covers
   both a wrong verifier and an attempt that never existed, so a leaked attempt id tells an
   attacker nothing.
4. `POST /api/companion/pair/cancel` with the attempt id and the verifier gives up. Cancel also
   deletes a credential already minted from that request, so a redeem that landed a moment earlier
   cannot leave a Mac connected that nobody meant to connect.

**Using the credential.** It begins `tm1_` and is returned exactly once, in the redeem response.
The server keeps only its hash, so there is no way to fetch it again — lose it and the Mac has to
link afresh. Send it as `Authorization: Bearer <credential>` to:

- `POST /api/companion/heartbeat` with app and OS version. Returns the device, the account, the
  server's clock and the credential's expiry.
- `POST /api/companion/device/name` to rename.
- `POST /api/companion/logout` to break the link from the Mac.

That credential opens nothing else. Sending it to any other route returns 401, and there is a test
holding that line.

**Lifetime.** Ninety days from the last heartbeat, capped at one year from linking. A heartbeat
slides the ninety days along. Signing the Mac out from Moss deletes the row, and the next
heartbeat gets 401.

**Error codes** arrive in the body: `companion_credential_invalid`, `account_pending_approval`,
`account_deactivated`, `pair_attempt_not_pending`, `invalid_origin`.

**Rate limits.** The polling route allows 120 requests a minute per address; the others allow 20.
Honour a 429 by backing off rather than retrying at the same rate.

## 3. The work, in order

Tasks 10 to 14 of the plan, which has the file lists, the Swift signatures and the failing tests
to write first. Read it rather than working from this summary.

1. **Task 10 — project skeleton and CI.** XcodeGen spec, a menu-bar-only app showing the mark and
   a Quit item, a macOS CI job triggered only by Mac file changes. One smoke test.
2. **Task 11 — instance address rules and the network client.** Which addresses are allowed, and
   a client with one place to fake the network so the tests need no server. Redirects are never
   followed; a redirect is an error the person sees.
3. **Task 12 — connection state machine, Keychain, preferences.** The machine is a pure function
   from state and event to new state and a list of effects, which is what makes the "Disconnect
   really means no requests" rule testable without a network.
4. **Task 13 — onboarding, menu, settings, permissions, login item, updater.** Follow the design
   guide screen by screen.
5. **Task 14 — live proof on the Mac.** Twelve checks, each a note and a cropped screenshot on the
   pull request.

Task 15 is the public release pipeline. It needs an Apple developer membership nobody has bought,
so do not start it without Ben saying go.

## 4. Ground rules on the Mac

- **Same repository, new branch and pull request.** The Mac app lives at `apps/trail-marker/`,
  outside the pnpm workspace. It is a second pull request because its tests need a Mac.
- **Do not touch the server or web files.** If the Mac work needs a protocol change, that is a
  finding to raise, not a quiet edit — the contract file is shared and changing it breaks the
  running dev instance.
- **Check `pnpm install --frozen-lockfile` still works at the repo root** after adding the folder.
  A stray package file there would join the workspace and break every Linux session.
- **Never claim a security property you have not followed through.** Before writing that the
  credential is confined, scoped or revoked, read the code that receives it and see where it
  actually ends up. A test asserting such a property must be watched failing with the protection
  removed.
- **The credential must never reach a log, a web address, or a crash report.** There is a test for
  this in the plan; write it before the code it guards.
- **A pull request must never break production.** If anything becomes a required setting, add it
  to every deployment config in the same pull request.
- Every pull request fills in the Release note section of the template. Task 14 has the wording.
- Cross-model review before merge. Claude-built work is reviewed by gpt-6-astra at medium effort.
- Merging is the agent's job. A green pull request parked for Ben is a stall.

## 5. Testing against a real instance

The dev instance has an https address on the tailnet — ask Ben for it, and check it is in the
instance's trusted-origins list before starting. Its plain LAN address will not work on purpose,
because the app rejects unencrypted addresses that are not on the Mac itself.

To watch a link attempt end to end, sign in at that address as Ben in a browser, then drive the
Mac app. A linked Mac shows up in Settings under Active sessions, named by itself, with the time
of its last contact. Signing it out there is how you prove revocation.

Clean up after live runs. The linked device rows and pairing attempts live in tables named for
companion devices and companion pair attempts; leaving test rows behind confuses the next person
looking at Active sessions. The standard user-deletion command currently refuses to run on dev
because that database has two owner accounts and the safety check cannot tell which instance it
is aimed at, so plan to remove test rows directly.

## 6. Things that bit the Linux half

- A pairing route only works if it is declared in the route guard list. Add a route without it and
  the server refuses to start.
- The approval code was in the web address at first. The same server serves the page and logs
  every address it is asked for, so the page load was writing a live secret to the log. It moved
  into the fragment, and the lookup became a post with the code in the body.
- A green test suite proved nothing about the browser talking to the server. The real page could
  not read a waiting Mac at all, because the client encoded the request body twice. Only driving
  the real screen found it. Expect the same on the Mac: unit tests will not prove the app talks to
  a real instance.
- Deleting a pairing attempt clears the link column on any device row that points at it, so a
  cancel that deletes both has to delete the device first.
