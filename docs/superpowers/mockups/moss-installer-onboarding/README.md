# Moss installer onboarding: static review screens

This is a sanitized, self-contained repository review bundle for the installer
onboarding design in PR #3464. It is **a mockup, not an installer**.

Open `index.html` in a browser. The bundle uses a deferred classic script and
relative assets, so no build, package install, local server, or backend is needed.
Use **Prototype** in the upper-right corner to choose review scenarios and switch
Forest/Teal or light/dark appearance. Refreshing resets all choices. Only
predefined scenario names appear in deep links; form values never do.

Suggested repository location:
`docs/superpowers/mockups/moss-installer-onboarding/`

## Review status and provenance

- The Park Press baseline screens and their visual primitives derive from frozen
  source `69db5d08812767abb3a485dc43ae789d9f97ee51`.
- The baseline includes local Mac/Windows/Linux installation, remote/headless
  Linux, manual Docker, notes before startup, and protected browser account handoff.
- The near-end **Use Moss from other devices** flow is a **revision proposal**.
  The access-choice direction is approved; these newly composed subpanels and
  exact copy have not received rendered visual review. The on-screen badge makes
  that distinction explicit.
- Existing HTTP browser access is now represented separately from the protected
  first-owner bootstrap gate. Existing deployments retain their current access.
- Repository-specific adaptations are in-memory-only interaction, generic sample
  data, relative font paths, a reduced public provenance record, and review links.
  These are export changes, not evidence of implemented product behavior.

The source prototype has not been modified. This bundle contains no annotations,
feedback history, storage synchronization, backend code, deployment configuration,
private addresses, credentials, personal data, or connection tokens. The original
historical design document is deliberately not reproduced. See
[screen-contract.md](screen-contract.md) for the selected implementer contract and
[provenance.json](provenance.json) for the limited public source record.

## Screen and state map

### Baseline installer routes

| Screen or state      | Entry point                                                                                                                                 | What to review                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Route choice         | [Fresh](index.html#review=fresh)                                                                                                            | This computer / Linux server / manual Docker           |
| Local host           | Fresh → Continue                                                                                                                            | Mac, Windows, Linux; Docker checks                     |
| Headless Linux       | [Headless](index.html#review=headless)                                                                                                      | Host-side helper, no laptop folder picker              |
| Manual Docker        | [Manual](index.html#review=manual-docker)                                                                                                   | Illustrative host configuration, no commands run       |
| Notes before startup | Host → Choose notes                                                                                                                         | Existing host folder / private Moss folder / later     |
| Preparation review   | Notes → Continue                                                                                                                            | Host and folder are reviewed before services start     |
| Health check         | Prepare Moss                                                                                                                                | Explicit simulated health result, no timer-as-proof    |
| Browser handoff      | Health passes → Continue                                                                                                                    | Same deployment and protected first-owner continuation |
| Docker failures      | [Missing](index.html#review=install-missing), [stopped](index.html#review=install-stopped), [wrong host](index.html#review=install-context) | Explain and deliberately retry                         |
| Preparation failure  | [Failure](index.html#review=install-failed)                                                                                                 | Keep deployment identity and host choices              |

### Baseline browser onboarding

There are six numbered browser stages: Account, You, AI, Email, News, Sports.
Notes are prepared during installation and remain editable from the recap;
access is an optional near-end subpanel, never a seventh numbered stage.

| Screen or state        | Entry point                                                                                                                                                                                                                              | What to review                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Account                | Complete the simulated install                                                                                                                                                                                                           | Made-up name and non-editable password illustration         |
| You / assistant name   | Account → Continue                                                                                                                                                                                                                       | Shared assistant identity and narrow focus                  |
| You / city             | Assistant name → Continue                                                                                                                                                                                                                | Sample cities, manual time zone, weather units              |
| AI                     | Continue from city                                                                                                                                                                                                                       | Featured providers, add another provider, model readiness   |
| ACP discovery          | AI → Browse all ACP agents                                                                                                                                                                                                               | 41 dated inert entries; registry is not compatibility proof |
| Provider waiting/error | [Waiting](index.html#review=ai-awaiting), [failure](index.html#review=ai-failed), [catalog unavailable](index.html#review=ai-unavailable), [background only](index.html#review=no-chat)                                                  | No real login, model, key, or endpoint                      |
| Notes recovery         | [Pending](index.html#review=notes-mount), [read-only](index.html#review=notes-readonly), [browse error](index.html#review=notes-error), [write failure](index.html#review=notes-verify), [host failure](index.html#review=host-recreate) | Saved source survives incomplete replacement                |
| Email                  | Continue from AI                                                                                                                                                                                                                         | Permissions disclosed; sending remains a separate action    |
| Email error states     | [Error](index.html#review=email-failed), [Bridge unavailable](index.html#review=email-unavailable)                                                                                                                                       | No provider sign-in or mail read                            |
| News                   | Continue from email                                                                                                                                                                                                                      | Suggested topics and custom topic with prerequisites        |
| Custom news topic      | [Ready fixture](index.html#review=news-ready) → Add another topic                                                                                                                                                                        | Separate structured-model and web-search checks             |
| Sports                 | Continue from news                                                                                                                                                                                                                       | Sample leagues, teams, search and no-results                |
| Catalog errors         | [News](index.html#review=news-read), [sports](index.html#review=sports-read)                                                                                                                                                             | Read failure is not an empty catalog                        |
| Ready recap            | [Ready](index.html#review=happy), [optional steps skipped](index.html#review=skip-all)                                                                                                                                                   | Current choices, pending items and edit paths               |
| First Today            | Ready → Get started                                                                                                                                                                                                                      | One useful continuation, no fabricated briefing             |
| Email-ready Today      | [Fixture](index.html#review=email-ready)                                                                                                                                                                                                 | Email and model readiness are simulated                     |

### Revision proposal: near-end access

| Screen or state            | Entry point                                                                          | What to review                                                          |
| -------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Access chooser             | [Use other devices](index.html#review=access) or Ready → Use Moss from other devices | Keep local / Home network HTTP / HTTPS                                  |
| HTTP disclosure            | [HTTP choice](index.html#review=access-http)                                         | Unencrypted credentials/content and HTTPS-only feature warning          |
| HTTPS choice               | [HTTPS choice](index.html#review=access-https)                                       | Recommended; no domain/certificate/Tailscale requirement to finish      |
| Host-plan review           | Choose changed mode → Review access change                                           | Explicit illustrative host/interface/port/address; no browser autoapply |
| Saved checkpoint / pending | Host plan → Simulate applying reviewed plan                                          | Previous verified access remains current until verification             |
| Connection failure / retry | Pending → Simulate failed check                                                      | Same deployment and owner, no fabricated success                        |
| Connection verified        | Pending → Simulate connection verified                                               | Update only the mock access recap                                       |
| Existing LAN browser       | [Legacy HTTP](index.html#review=legacy-lan)                                          | Keep current HTTP access; remote companion still needs HTTPS            |
| Existing HTTPS             | [Legacy HTTPS](index.html#review=legacy-https)                                       | Keep current saved HTTPS access                                         |

A real host plan must substitute exact inspected values for the clearly marked
placeholders before asking for approval. **Get started never widens access.**
A phone/computer browser can use an explicitly selected LAN HTTP route. The
remote companion has a separate HTTPS requirement. New owner claiming remains
loopback, SSH tunnel, or verified HTTPS and closes before access widens.

### Recovery and simulation controls

[HTTP first-owner gate](index.html#review=http),
[unknown connection](index.html#review=unknown),
[certificate warning](index.html#review=certificate),
[wrong instance](index.html#review=wrong-instance),
[signed out](index.html#review=signed-out),
[expired claim](index.html#review=claim-expired),
[used claim](index.html#review=claim-used),
[save failure](index.html#review=save),
[offline](index.html#review=offline),
[newer navigation](index.html#review=navigation),
[account switch](index.html#review=owner-switch),
[resume](index.html#review=resume), and
[finish failure](index.html#review=finish).

Resume/restart/save scenarios are simulated in memory. This export intentionally
does not persist progress across reloads or synchronize tabs.

## Shared primitives and files

- `tokens.css`: Park Press semantic palette, spacing, type, focus, surfaces,
  Forest/Teal and light/dark themes; local Archivo font faces.
- `style.css`: centered wizard, six-stage compact progress, restrained artwork,
  field, choice, disclosure, status-note, recap, action and dialog primitives.
- `app.js`: bundled inert model, screen renderers and mock transitions. No imports,
  requests, real provider actions, native pickers, clipboard, or persistent state.
- `assets/`: Moss mark, two Park Press illustrations, four provider identity marks,
  and the ACP registry license. Unused art and the unused Gemini mark are omitted.
- `fonts/archivo/`: six Latin WOFF2 weights and the SIL Open Font License.
- `ATTRIBUTION.md`: asset origins and applicable notices.
- `tests/verify.mjs`: dependency-free static/privacy/link contract checks.
- `tests/dom-check.cjs`: optional jsdom interaction checks; it needs an already
  available `jsdom` package and does not start a browser or server.
- `validation.md`: exact verification scope and limitations.

## Checks

Run `node --check app.js` and `node tests/verify.mjs` from this directory.
If jsdom is available, run `node tests/dom-check.cjs`. `JSDOM_MODULE` may point to
an existing jsdom module when the enclosing repository resolves it elsewhere.
No dependency installation is needed to open the mockup.

Source/DOM checks cannot verify pixels, responsive overflow, browser-specific
file-origin handling, or actual screen-reader behavior. Rendered-browser QA was
not run because the prior browser route was blocked; no sandbox or socket
workaround was attempted. See [validation.md](validation.md).
