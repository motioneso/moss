# Approval card mockups

Calmer design-only follow-up to #3089 for #3065, phase 2. Ben must review this card style
before any product-card build. Open `index.html` locally; it includes desktop and
390px phone frames for every state. Every state also opens directly and adapts to its viewport. Review at
1440 × 900, 390 × 844 and 320 × 700. No app, server, network or build is needed to open the HTML.

## States

1. `01-delete-memory.html`: calm default, full server-read memory text; primary Approve / secondary Reject.
2. `02-change-settings.html`: server-read target and three exact label/value rows.
3. `03-outside-content.html`: named theme and one short outside-content notice.
4. `04-approved.html`: one quiet “Approved” line.
5. `05-declined.html`: one quiet “You declined” line.
6. `06-timed-out.html`: one quiet “Timed out” line.
7. `07-cancelled.html`: one quiet “Cancelled” line.
8. `08-delete-memory-comparison.html`: the same delete-memory record with a red Approve button,
   shown separately as an optional comparison.

The default always uses the normal shared primary button, including the theme state. Reject
keeps the shared secondary treatment. No warning icon, risk banner or extra explanatory copy
is added to the card. The red comparison is presentation-only and is never inferred from the
action title. The existing Thinking / steps row is untouched.

All examples are synthetic. Controls are inert. The resolved states are separate snapshots,
not client-side action simulations. “Approved” records the approval decision, not a claim that
the action completed. No “allow for this chat” control is included.

## Source and trust boundary

`build.tsx` renders the shipped `@moss/ui` Card, Button, ButtonLink, IconButton, BrandMark and
SectionHead primitives. Its small, typed fixture record stands in for a server-owned approval
record; it is not a proposed wire contract. The renderer accepts only the action title, full
server-read target, exact validated label/value rows and outside-content flag. It accepts no
model-written summary. React escapes all record strings; they are never inserted as HTML.
A delete with no submitted body has no invented field rows. Internal identifiers and API paths
are not shown. Outcomes replace the whole card with one quiet line and no remaining controls or outside-content
notice. Server titles, targets, labels and values are protected from formatter-inserted
whitespace; the static checks assert exact text.

The drawer uses the shipped `.chatd` shell: 404px desktop width, constrained to viewport minus
36px on phones, with its header, scrolling body and pinned composer. The approval card spans
the thread width rather than squeezing into an assistant prose/avatar column.

`moss-ui.css` bundles main `b9458ddb175d23d7d2ae02d72ae4f269c218511b` tokens and the shared
core, forms, Moss-Today, sections and chat styles, plus `kit-chat.css`. Archivo font faces are
embedded from the #3087 bundle, with `FONT-LICENSE.txt`. `mockup.css` supplies artifact layout
and token-based card arrangement only. There are no invented `jds-*` classes.

Reference: [Approval card and Phase 2](../2026-10-05-moss-acts-through-app-design.md#approval-card).
The spec is present on main; no phase-1 product branch was copied.

To regenerate the HTML from a checkout with dependencies installed:

    node --import tsx docs/superpowers/specs/approval-card/build.tsx
    pnpm exec prettier --write docs/superpowers/specs/approval-card
    node --test docs/superpowers/specs/approval-card/verify.mjs

The CSS bundle is checked in and does not need regeneration to review these states. No product
code, app-map declarations, workflows or hosting configuration change. This does not close #3065.

Validation: static generation, focused TypeScript, repository Prettier, exact-text assertions,
button/outcome/notice checks, offline/local-link checks and the invented-class audit.
Ben renders locally. No browser render, PNG, visual-fit or live-product claim is made here.
