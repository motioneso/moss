# Rust phase 5, Meetings part 7b report (devices screen)

## Built

- Devices section behind the Meetings cog: loading, denied, failed and empty states, inline rename, unlink confirm, "linked" notice.
- Approval dialog over Meetings: ask, linked, declined ("Nothing was linked"), closed ("That request is no longer open"), sign-in and failed states, for Mac and phone.
- Shell-native owner routes: list, rename, unlink (`companion_owner.rs`). Unlink deletes the device row, which ends its credential.
- The approval code stays in the address fragment. The parent page reads it, strips it, and hands it to the screen. It never reaches the server.
- `/link/trail-marker` redirects to `/meetings`, keeping the fragment.
- Package file list, app-map entry, manifest (0.3.0) and changelog updated.

## Proof

- UI logic tests: 28 pass. Host test for unlink (owner scoped, credential ends, repeat is false): pass.
- Live browser pass on the real Rust server over HTTPS, desktop (1280) and phone (390) widths, no intercepted or rewritten responses. 20 checks per width, all pass: empty list, approval ask, link, redeem, check-in, Connected, rename and reload, unlink, check-in refused after unlink, decline, declined phone cannot redeem, closed request, linked phone.
- Script: `modules/meetings/tools/screen-live-part7b.mjs`.

## Not proven

- Linking the real Mac (Trail Marker.app over SSH). The fake Mac in the script uses the real pairing routes, but the installed app was not driven. Needs the Mac to trust and reach the server.
- A linked device reaching the Meetings upload routes. On this server those routes answer 403 "Open Moss to manage your account" to a companion credential both before and after unlink, so refusal after unlink is shown only on check-in (200 before, 401 after).
- Owner routes with Meetings turned off.
- The cog opening `/settings/meetings` on the full shell. The live test server serves no shell screens, so screens were opened through the module frame.
- The Mac and Android Get-app buttons. Both stay disabled because no download links exist yet.
- `/link/trail-marker` redirect in a real browser.
- Unrelated and not investigated: the home screen shows "Mac access could not be verified" on this server (Mac capture list answers 401).
