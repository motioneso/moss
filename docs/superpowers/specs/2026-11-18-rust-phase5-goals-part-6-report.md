# Rust phase 5, Goals part 6: Today screen

Task JS-354, card 609. Mockup approved 2026-11-18. Source of truth:
`apps/web/src/today/goals-section.tsx`, reproduced without a redesign.

## Built

- Goals owns the package screen `/goals/today`: Focus, Long-term goals, target icon,
  title, optional priority and desired outcome. Only active goals appear, in route order.
- Rust Today embeds the screen below the day section, in the main column as before.
  It uses the existing sandbox and message bridge; requests stay on the current server.
- Empty lists collapse to zero height. Loading has a quiet status line. Request failures
  offer Retry; screen-opening failures ask the person to reload Today.
- The owning manifest declares the screen and app-map behavior. No editor or settings
  link was added. Package assets include the screen, stylesheet, scripts and bridge.
- The bridge retains its existing page minimum height; this Today embed opts into zero.

## Checks

- `scripts/run-gate.sh start --gate test:rust-goals`, followed by its `wait --follow`:
  expected exit 0, observed exit 0. Node rendering tests: 3 passed. Native Rust:
  7 route/tool tests and 1 privacy test passed. Real Wasm component/package: 6 passed.
  Installed-package route/tool parity and privacy: 4 passed. Two source-level negative
  controls failed as expected with their protections removed, and the restored checks
  passed. Installed tests also exercised the existing RLS negative controls.
- `node --test modules/goals/ui/view.test.mjs rust-spike/module-ui/web/bridge.test.mjs`:
  expected exit 0, observed exit 0; 23 passed, 0 failed. This includes the zero-height
  embed and unchanged page minimum, active-only rendering, ordering and text escaping.
- The initial package run caught an unsupported manifest error class. It was corrected
  to `transient` before the passing run.
- `pnpm verify:static` (un-piped): expected exit 0, observed exit 0. Lint, formatting,
  file size, design rules, dependency checks, all TypeScript checks and app-map build passed.
- `scripts/run-gate.sh start --gate test:rust-goals-live`, followed by its
  `wait --follow`: expected exit 0, observed exit 0; 1 installed real-server test passed.
  The test exercised the installed Wasm package, five tools, one-use approval,
  route writes, Today active filtering and two-account refusal over HTTPS.

## Live screen proof

A fresh Rust server and freshly built Rust Today Wasm shell ran from this worktree on
an allocated devports port, using the full shell assets. The browser reached its LAN
HTTPS address and signed in through the real sign-in page. The fixture held the server
open for the check, then stopped cleanly. No network responses were intercepted.

- With the fixture goals completed, Today rendered an iframe height of 0 pixels: no
  empty Goals heading or placeholder occupied the page.
- Three goals were created through authenticated POST requests to the app's Goals
  route: all returned 201. They immediately appeared in the real Today route response.
- After reload, the live screen showed Focus, Long-term goals, the three titles,
  priorities P3/P2/P1, and the desired outcomes in the returned order.
- Desktop viewport: 1440 × 1000. The screenshot shows the existing editorial styling,
  target icons and unboxed goal rows without coloured left borders.
- Phone viewport: 390 × 844. The embed measured 354 pixels wide at x=18; the document
  scroll width was 390 pixels. The long Spanish outcome wrapped without overflow.
- Completing the half-marathon goal through the real PATCH route returned 200. After
  reload, the screen showed only the remaining two active goals.
- Browser errors were empty. Screenshots and command output are published in the
  task's recipe proof artifact; no screenshots, credentials or LAN address are committed.

## Review

The first independent Claude review found no blocker or major findings. Its minor notes
were the loading line appearing before an empty list collapses, formatting-only Rust
changes, and the module-local bridge copy pattern. The formatting noise was removed.
The explicit loading state follows this task's requirement; the local bridge follows
other installed package screens.

## Not proven

- A second physical phone was not used; the phone proof uses a real browser at phone
  dimensions over the LAN HTTPS address.
- API-failure Retry and bootstrap reload guidance exist, but were not forced in the
  live browser. The transient loading state was not captured in a screenshot.
- Other themes and dark mode were not visually exercised in this pass.
- No real-model pass was needed for this read-only screen.
