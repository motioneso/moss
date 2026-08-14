# #1588 — Recently Released

**Date:** 2026-08-14

**Status:** Approved by Ben — 2026-08-14

**Issue:** [#1588](https://github.com/motioneso/moss/issues/1588)

## Context

Moss ships frequently. Users can update successfully and still have no easy way to learn what the
new version added, fixed, or changed. Release information exists in the repository, but it is not
available through the ordinary product UI. The existing host diagnostics is admin-only and reports
only the latest GitHub release; GitHub Releases are not a complete history and are not the right
source for an installed instance.

This feature gives every signed-in user a simple, read-only release history inside Moss. A user will
most often visit it after an update, but it remains available at any time for curiosity or review.

## Goals

1. Let any signed-in user navigate from Settings to a **Recently Released** page.
2. Show chronological, user-facing release notes through the version contained in the installed
   build.
3. Make each release easy to scan by version, date, and the categories **Added**, **Fixed**, and
   **Changed** when those categories have entries.
4. Keep release-note maintenance in the repository's existing curated changelog workflow.

## Non-Goals

- Comments, reactions, ratings, or other social features.
- Search, filtering, unread state, notifications, badges, or update prompts.
- An admin editor or any in-app release-note authoring workflow.
- A GitHub Releases browser or runtime GitHub API integration.
- Reusing or replacing the external weekly delivery report.
- Automatically deriving user-facing prose from commits or pull requests.

## Resolved Decisions

| Decision | Choice | Reason |
| --- | --- | --- |
| Audience | Every signed-in user | Release information is product documentation, not an admin operation. |
| Entry point | A **Recently Released** item in the **Moss** group of Settings | It is discoverable without adding another primary navigation destination. |
| Route | Deep-linkable Settings section, `/settings?section=released` | Reuses the existing Settings navigation model and supports direct navigation. |
| Source | Build-bundled `docs/WHATS_NEW.md` | It is already the curated user-facing changelog and avoids an incomplete runtime GitHub history. |
| Version boundary | Content bundled into the installed build | An installed image cannot display notes authored after that build, so the visible history naturally ends at the installed version. |
| Interaction | Read-only chronological document | Navigation and visibility are the entire requested behavior. |

## Architecture

### Canonical content

`docs/WHATS_NEW.md` remains the single canonical release-note document. Normalize its entries into
newest-first release sections. Each release has:

- a version;
- a release date;
- optional **Added**, **Fixed**, and **Changed** subsections; and
- concise user-facing entries under the applicable subsections.

Empty subsections are omitted. Existing useful history is retained while being reorganized into
this shape. Release notes continue to be reviewed and shipped with the code they describe.

The web build imports the Markdown as a raw build asset. It does not fetch the repository, GitHub,
or a server endpoint at runtime. No version-filtering service is needed: the checked-out changelog
at build time is, by construction, the history available to that installed build.

### Settings surface

Add `released` to the personal Settings section ids and place **Recently Released** in the existing
**Moss** group. Add the matching declaration to `CORE_APP_SETTINGS` so the app map remains truthful.
The item is user-scoped and links to `/settings?section=released`.

The pane renders the bundled Markdown with the already-installed, HTML-escaping Markdown path used
by Moss. It uses existing Settings and design-system primitives and adds no separate page shell,
navigation system, parser, or dependency.

### Loading and failure behavior

Because the content is bundled, the page requires no network request, loading state, authentication
fork, or retry behavior beyond the Settings pane's existing lazy-loading boundary. A build that
cannot import its release-note asset fails during build verification rather than shipping an empty
runtime page.

## Security and Privacy

- Release notes are static public product information and contain no user or instance data.
- The feature adds no database access, job payload, credential handling, filesystem runtime access,
  or authorization bypass.
- Markdown is rendered without raw HTML execution, using the existing safe renderer and URL
  handling.
- The section is available to authenticated users through the existing Settings shell; it does not
  expose admin diagnostics or host configuration.

## Verification

### Focused automated checks

1. Settings navigation accepts `section=released`, lists it under **Moss**, and renders the release
   pane for a normal user.
2. `CORE_APP_SETTINGS` contains the matching user-scoped path and description.
3. The pane renders representative version, date, Added, Fixed, and Changed content from the
   bundled changelog.
4. Markdown remains inert: embedded raw HTML is displayed/escaped rather than executed.

### Required live-path proof

On the exact implementation head, sign in as a normal non-admin user and navigate through:

```text
Settings -> Moss -> Recently Released
```

Verify from bounded DOM evidence that the URL selects `section=released` and that at least one
release version/date and its categorized release information are visible. Record the exact exit
code and teardown evidence on the PR. Screenshots are neither required nor retained.

## Exit Criteria

- Any signed-in user can reach **Recently Released** from the **Moss** group in Settings.
- The page displays newest-first version/date release notes with Added, Fixed, and Changed groupings
  where applicable.
- The displayed history cannot include releases newer than the installed build.
- Release-note content has one canonical source: `docs/WHATS_NEW.md`.
- No database, API, job, GitHub runtime fetch, notification, editor, or new dependency is added.
- Focused tests, repository static checks, CI, and the real-UI live-path proof are green.

## Hard Invariants Honored

- Spec before build: this document must be approved before an implementation plan is written.
- Design-system primitives and tokens are reused for the new Settings pane.
- The app map stays aligned with the user-visible Settings surface.
- No private data, secret, authorization, RLS, `AccessContext`, `VaultContext`, module boundary,
  migration, or AI-provider behavior changes.
- The implementation commit and PR use user-facing release-note language.
