# Settings trim live-path proof

PR #3773. The disposable UAT runner rebuilt the real app on application commit
`36376ecc1`, after rebasing onto `origin/main` at `5c146211e`.

The seeded owner signed in through the real form, then opened Account menu → Settings →
Connections. Executable assertions check the compact Outlook account row, read-only label,
coverage dates, one unconfirmed meeting warning, and exactly one notes-folder explanation.
Desktop 1280px and phone 390px/320px layouts have no horizontal overflow. The normal
accounts, Outlook status, notes source and integrations API requests all returned HTTP 200.

Only disposable persisted data was seeded: one owner-scoped Outlook calendar account and
its cached health preference. Notes uses the real empty source. No network responses were
intercepted, stubbed, rewritten or replayed. No dedicated Outlook browser was configured;
external sync and connect/refresh controls were not exercised.

The cropped screenshots contain only fixture status and application copy, with no private
data. They were captured explicitly for this task; automatic screenshots, traces and video
were disabled. The harness removes its containers, volumes and network after the run.

Reproduce from `~/Jarv1s`, using a port reserved by `devports claim`:

```bash
MOSS_UAT_CAPTURE_OFF=1 JARVIS_UAT_CLAIMED_WEB_PORT=<claimed-port> \
  pnpm test:uat 3773-settings-trim-live
```

The repeatable spec is `tests/uat/specs/3773-settings-trim-live.uat.spec.ts`. Its cropped
screenshots default to the Playwright output directory; set `MOSS_SETTINGS_TRIM_EVIDENCE_DIR`
to retain them elsewhere. Release the claimed port after the runner exits.

| Width  | Outlook row                 | Notes folder            |
| ------ | --------------------------- | ----------------------- |
| 1280px | [Outlook](outlook-1280.png) | [Notes](notes-1280.png) |
| 390px  | [Outlook](outlook-390.png)  | [Notes](notes-390.png)  |
| 320px  | [Outlook](outlook-320.png)  | [Notes](notes-320.png)  |

Run result and bounded output are recorded in the PR's live-proof comment.
