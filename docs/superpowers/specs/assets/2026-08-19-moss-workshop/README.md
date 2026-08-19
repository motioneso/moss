# The Workshop — design reference

Static mockups reviewed and approved by Ben on 2026-08-19, alongside spec
`../../2026-08-19-moss-builds-modules-on-moss.md` (#1739).

Three screens:

- `workshop.html` — the module list, grouped Needs you / Building now / Live.
- `approval.html` — the review-and-approve screen shown before a built module is allowed to run.
- `chat.html` — the chat drawer moment where a build is started and later reported finished.

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

## Two rulings baked in

- **Cards are for decisions.** Only the item asking the user to do something is a raised card.
  Work in progress and live modules are plain rows separated by a hairline. Ben, 2026-08-19: be
  careful of using too many cards.
- **Use the width.** Working surfaces run wide (about 1240px), not a narrow reading column. Cap the
  measure only on genuine prose. Ben, 2026-08-19: designs often waste horizontal space with large
  side gutters.
