# Finance slice: original UI evidence

Captured on 2026-10-30 from clean production/test source 6d9d490442fb2167ff747d2b1d17d4cd6240f6cf.
Receipt: /tmp/jarv1s-gate/moss_finance-20261030-233452-WE53Bh.log.
All 237 Finance tests in 20 files passed, including 24 actual installed-browser flows.
Fingerprint: 1eab72b6205cd7e76c555eb38b7c40ce788a8f64a674e4ebb41277a6cb9e579a.
Node 24.19.0, pnpm 10.6.2, Chromium, disposable PostgreSQL 17.11.
Only synthetic financial/auth fixtures were used. Provider/credential ports were inert stand-ins;
UI, host confirmation, API, worker and SQL/RLS paths were real. No bank HTTP was exercised.

These PNGs are original byte-for-byte copies, without crop, resize, recoloring or annotation.
Some are full-page images; inspect at original resolution rather than judging a scaled thumbnail.

**Functional acceptance is not strict design closure.** Main-conversation design review remains open.
The baseline shows two approved follow-ups: make blocked drafts read only and copyable, and allow
canceling a pending initial read while fencing its late response. Neither fix is represented by these baseline images.

| Original                                                                                       | Dimensions  | Exact state                                                                                                                  | SHA-256                                                            |
| ---------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [finance-private-note-edit-light-1440.png](finance-private-note-edit-light-1440.png)           | 1440 × 900  | Desktop light: valid multiline draft, account/date context and explicit save.                                                | `5d9208e21270c134e0d44d0fe9e55be7f49d4eb76ec488c953be65750c5b5adc` |
| [finance-private-note-edit-dark-320.png](finance-private-note-edit-dark-320.png)               | 320 × 900   | Phone dark: retained whitespace, byte capacity, shared scrolling dialog and fixed actions.                                   | `cdaab20b4adf1057327c3526380bffbec2d4e08b36487381c68d05b328a8be5b` |
| [finance-private-note-stale-dark-320.png](finance-private-note-stale-dark-320.png)             | 320 × 900   | Phone dark baseline: stale review blocks writing and offers Check saved note; draft currently disabled (approved follow-up). | `4b8fe406def7a4d245a1a640da336f5efab569be5bd64841d6f3d9c84023bd70` |
| [finance-private-note-recovered-light-1440.png](finance-private-note-recovered-light-1440.png) | 1440 × 900  | Desktop light: current saved note above the retained editable draft.                                                         | `a730b50b295f653a4fb1142419a64624ac4c5eabf1460dd71e5a7a71af4f7e36` |
| [finance-private-note-recovered-dark-320.png](finance-private-note-recovered-dark-320.png)     | 320 × 900   | Phone dark: saved/draft comparison and save action remain within the reviewed layout.                                        | `06458bb7e440d5c1f47cc44140213bd0cea4c814d2759a12ac08da6ff6eac56f` |
| [finance-private-note-uncertain-dark-320.png](finance-private-note-uncertain-dark-320.png)     | 320 × 900   | Phone dark: real approved commit followed by synthetic HTTP 503; no blind write retry.                                       | `24f2240000cf49d3dd004ca62f5bedbbe5c279f69b79a3f089bc7578d8178ada` |
| [finance-bill-entry-preview-light-1440.png](finance-bill-entry-preview-light-1440.png)         | 1440 × 900  | Desktop light: exact before/after cash and expected versus actual expense.                                                   | `491aff9d3438b63dc72edb71d219ffeac25a485d8f17e1572420c4aee89978d8` |
| [finance-bill-entry-preview-dark-320.png](finance-bill-entry-preview-dark-320.png)             | 320 × 900   | Phone dark: entry preview, fixed actions, visible currency and no-bank-payment explanation.                                  | `4a2b4509f4ef3c445a3f924837eb688c5501b0cf532c7bf8daec2aa1a30a4cf1` |
| [finance-bill-entry-duplicate-light-1440.png](finance-bill-entry-duplicate-light-1440.png)     | 1440 × 900  | Desktop light: existing-expense warning prevents duplicate convenience recording.                                            | `f91a49401b1b73b3eaa805c4e6393ddc94098b2331cb077c32796e95657786df` |
| [finance-bill-entry-stale-dark-320.png](finance-bill-entry-stale-dark-320.png)                 | 320 × 900   | Phone dark: independently changed ledger blocks the captured write and explains recovery.                                    | `8be2656be92cc6a93314d32e8ced0308d258db47ae397b0e04ffa53ddca76759` |
| [finance-bill-entry-host-confirm.png](finance-bill-entry-host-confirm.png)                     | 320 × 900   | Phone dark: real nested host confirmation, action label and cancellation explanation.                                        | `02054ec199fd13cdff522724773464f05046750175e020dd6da073075ae5da45` |
| [finance-bill-entry-saved.png](finance-bill-entry-saved.png)                                   | 320 × 2698  | Phone full page: confirmed recorded expenses survive reload alongside projected obligations.                                 | `f3198fb67f9d74bee02dcc6844b01b383ce5daf9414bf107e8d48e65f66a4a20` |
| [finance-flex-dark-320.png](finance-flex-dark-320.png)                                         | 320 × 4364  | Broader review queue: full phone flexible-budget hierarchy and category density.                                             | `42a4a74e9589fd364b6de7c5c3b161f5ad9b60ff9b99cfd9174d40e47b7ad237` |
| [finance-manual-accounts-phone.png](finance-manual-accounts-phone.png)                         | 390 × 1190  | Broader review queue: manual/provider accounts, currency-separated worth and account actions (390px).                        | `1b3e78ffea85723591f434d8f777a82d3c7af3b3a7a003cc021329a356d602b0` |
| [finance-reports-1440.png](finance-reports-1440.png)                                           | 1440 × 2093 | Broader review queue: desktop recorded worth, missing-history disclosure, drill-down links and cash flow.                    | `9205e19f1f92761ca5f5a4eca9134ff5a1e8e4659d416185e9925296b65b5287` |

The existing installed tests prove cancellation with no mutation, completed save/reload, clear,
actual intervening-write conflicts, response-loss recovery, retained drafts when filters remove
a row, viewport-change focus return and recovery focus to search. They also check overflow and
fixed action bounds. They do not yet test delayed initial-read cancellation or blocked-draft
keyboard copying; those are the approved next regression cases.

Named-theme token pairs were separately inspected in [token-role-contrast.json](token-role-contrast.json).
This is source-token analysis of six selected role/ground pairs across five named palettes and
light/dark modes. All selected pairs meet their stated floors. It is not rendered-pixel or full
WCAG certification: disabled opacity, textures, arbitrary custom palettes and all interactive
states are outside that calculation. Current shared token/focus tests are also in the aggregate.

The approved follow-ups now have [separate corrected-state originals and regression results](../finance-private-notes-2026-10-31/README.md).
This folder remains the unaltered earlier-source baseline; broader review remains open.
