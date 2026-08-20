# The Workshop — design reference

Static mockups reviewed and approved by Ben on 2026-08-19, alongside spec
`../../2026-08-19-moss-builds-modules-on-moss.md` (#1739).

Five files:

- `workshop.html` — the module list, grouped Needs you / Building now / Live.
- `chat.html` — the chat drawer moment where a build is started and later reported finished.
- `plan.html` — agreeing the plan: what Moss means to build, before it builds it. Added
  2026-08-19, after Ben rejected the review-at-the-end screen.
- `draft.html` — the finished draft running for its author alone, with the chat drawer beside it
  and ship it on the draft itself. Added at the same time.
- `approval.html` — SUPERSEDED. The review-and-approve wall in front of a finished module. Kept
  only as the record of a rejected direction; do not build it, do not revive it.

These are the intended look, not shippable markup. They use only `jds-*` primitives that the design
system already defines (checked with the invented-class audit in the `design-system` skill) plus a
small layout-only `preview.css`. Real colour comes from `apps/web/src/styles/tokens.css`.

## Viewing them

They expect the app's stylesheets at `/css/all.css`. To view:

```bash
mkdir -p /tmp/moss-design/css
cp docs/superpowers/specs/assets/2026-08-19-moss-workshop/* /tmp/moss-design/
for f in packages/ui/src/styles/*.css; do cp "$f" "/tmp/moss-design/css/ui-$(basename "$f")"; done
for f in apps/web/src/styles/*.css;    do cp "$f" "/tmp/moss-design/css/app-$(basename "$f")"; done
cp apps/web/src/styles/tokens.css /tmp/moss-design/css/tokens.css
( cd /tmp/moss-design/css && { echo '@import "tokens.css";'; ls ui-*.css app-*.css | sed 's/.*/@import "&";/'; } > all.css )
( cd /tmp/moss-design && python3 -m http.server 5199 )
```

## Three rulings baked in

- **Cards are for decisions.** Only the item asking the user to do something is a raised card.
  Work in progress and live modules are plain rows separated by a hairline. Ben, 2026-08-19: be
  careful of using too many cards. On the plan and draft screens this means one card each: the
  plan, and the draft banner that carries ship it.
- **Use the width.** Working surfaces run wide (about 1240px), not a narrow reading column. Cap the
  measure only on genuine prose. Ben, 2026-08-19: designs often waste horizontal space with large
  side gutters.
- **A plan is read before it is agreed.** The dimmed confirmation device (`jds-governor`) drops its
  contents to 70% opacity until confirmed, which is right for a one-line "shall I?" and wrong for a
  five-line plan. Plans use the raised card instead.

## Note on the audit

The invented-class audit in the `design-system` skill greps `apps/web/src/styles/` for defined
classes. Most primitives live in `packages/ui/src/styles/`, so include both paths or the audit
reports every real class as invented.
