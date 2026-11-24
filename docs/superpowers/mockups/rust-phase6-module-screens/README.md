# Module screens: approved

JS-66, Phase 6 M9. Open `index.html` for all eleven screens. These are static fixtures for Ben's
look check, not working product screens or proof of package installation. Screen-index links,
state disclosures, switches, native fields and the theme picker work locally. Action links move
between drafts; they never mutate Moss. Progress, success and failure are shown together for review.

Run a static server from `~/Jarv1s` (or this task's checkout) using a reserved port:

```bash
devports claim js66-mockups
# Use the returned port in place of PORT; do not pick a port manually.
python3 -m http.server PORT --bind 127.0.0.1
```

Expected: server stays running; open
`/docs/superpowers/mockups/rust-phase6-module-screens/index.html` on that server. Stop the server
and run `devports release PORT` when finished. No build, dependencies or database needed.
Tokens and shared primitive styles load directly from the repo; Archivo fonts are local.

## Starting look and implementation mapping

The Settings sidebar/pane hierarchy comes from
`apps/web/src/settings/settings-instance-modules-pane.tsx` and `settings-ui.tsx`.
The Rust catalog/review/result starting flow is `rust-spike/shell/ui/src/modules_page.rs`.
The draft uses the authored paper, ruled rows and compact Settings controls, avoiding the old
screen's explanatory hero line. Product builds use shared components/Leptos kit wrappers; this
static HTML uses their existing CSS for review only. `mockups.css` owns draft layout.

| Draft              | Shared pieces for implementation                                |
| ------------------ | --------------------------------------------------------------- |
| S1 Installed       | Masthead, RowIndex, Badge, Switch, IconButton, DisclosureToggle |
| S2 Browse          | Field, Select, RowIndex, Badge, Button                          |
| S3 Detail          | Masthead, IconButton, RowIndex, SectionHead, Badge, Button      |
| S4 Install review  | Dialog, SectionHead, Button                                     |
| S5 Progress/result | RowIndex, Indicator, EmptyState, Button                         |
| S6 Update review   | Dialog, Badge, SectionHead, Button                              |
| S7 Remove          | Dialog, Field, Button (danger only for data deletion)           |
| S8 Restore         | Dialog, Select, RowIndex, Button                                |
| S9 Registries      | Field, Select, RowIndex, Badge, Dialog, Button                  |
| S10 Block/warn     | HeldBanner, Badge, RowIndex, Button                             |
| S11 Request        | Dialog, Badge, RowIndex, Button                                 |

Every screen has a States disclosure with empty/loading/error copy. Loading comes from host
records; no fake spinner or timer. Build tasks must add real pending/disabled controls and shared
Dialog focus/isolation behavior; static sections are intentionally not presented as modal dialogs.
Source registry appears wherever a draft names a module. Delete copy states all-account scope and
30-day retention. The local package path is builder-private and is not presented as registry review.

Module settings are reached only through the header cog. The management cog opens `module-preferences`; its automatic-update control is a management
preference. The Finance cog opens a separate `finance-settings` illustration of its existing
settings. The product route remains `/settings/finance`; this task does not redesign it.
No module-settings text link is introduced.

Ben approved S1–S11 on 2026-11-23, with the quieter Installed-tab controls from PR 4477. The
approval and the section 8 assumptions it confirms are recorded in the package/registry spec.
