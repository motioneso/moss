# Calendar part 9: installed screen startup recovery

Task JS-93, Card 525. Part of issue #4027. Release note Category: N/A.

This is a screen reliability checkpoint in the ongoing Calendar port, not final
Calendar acceptance. Work stays in Calendar-owned files in the task worktree under
`~/Jarv1s`. The module remains a client of the authenticated server API; no database,
provider or sibling-module access is added to the browser.

## Change

The packaged Calendar and settings documents display a shared Park Press loading
state before the Rust screen mounts. If the generated JavaScript, bridge import or
Wasm startup fails, the document explains that Calendar could not start and how to
retry. Successful startup removes the fallback. If the boot script itself cannot
download, the static loading text still points to the parent page's reload control.

The authenticated parent page offers **Reload page** independently of the module
bundle. Reload retains the settings/calendar screen and event query, escapes the
query in HTML, and opens a fresh installed frame/bridge. Reloading the opaque frame
alone would revoke its document-bound bridge, so recovery reloads the parent page.

## Verification approach

`tools/startup-check.ts` interrupts actual installed-package asset requests in the
task browser, without replacing account identity or API responses. It checks Wasm
and generated-JavaScript download failures on Calendar and bridge-import failure
on settings, then removes each fault and uses **Reload page** to restore the real
screen and linked event. Screenshots label this deliberate transport fault; they
are recovery evidence, not an assertion that the network failed spontaneously.

The disposable signed-live fixture supplies real Rust sign-in, HTTPS, a signed
registry installation, Wasmtime, PostgreSQL and UI API calls. Database checks run
only through `scripts/run-gate.sh`, including the existing failing-first privacy
witnesses. Final check receipts and independent review belong in the task proof.
Build tools come from the existing Rust/Wasm scratch toolchain and declared
lockfiles. No global tools, new dependencies or wit-bindgen installation are added.

## Remaining acceptance

The full Calendar port still needs its provider tools and jobs; public reference
and provider adapters; source-behavior and provider-status controls; preview,
approval, apply, retry, recovery and follow-through; full shell/Today/chat
composition; old-screen replacement; exhaustive assembled HTTP/tool/job parity;
and a physical second device over trusted HTTPS. A phone-width viewport and a LAN
request from the same computer do not prove the last requirement.

This check does not simulate every browser crash, a corrupt downloaded package,
every Rust startup panic, slow-download timing, or a real production deployment.
