# Chat steering mockups

Design-only mockups for `docs/superpowers/specs/2026-10-29-chat-mid-turn-steering-design.md` (#3848). Open any file directly in a browser. No app, server, network, or build is needed. Controls are inert. All wording on the frames is product wording only.

## States

1. `01-working-typing.html` - Moss working, user typing a follow-up. Send and Stop side by side.
2. `02-steered-landed.html` - The follow-up sits in the transcript in place. Moss still working.
3. `03-many-waiting.html` - Five messages steered into one turn. Quiet warning line. Sending still works.
4. `04-cannot-steer.html` - Provider cannot steer. Message held, then sent as a new message.
5. `05-not-delivered.html` - A steer did not land. Message visible with Retry.

## Design notes

- Park Press tokens copied from `apps/web/src/styles/tokens.css` so each file renders alone. The build uses semantic tokens, never these literals.
- Bone paper ground, warm white panel, forest accent, Archivo panel title, hairline rules, no text under 11px.
- Build pieces named for the build - the shared chat Thread for the transcript, IconButton for Stop, the composer send button, and Chip-style rows for held and failed messages. Missing pieces go into `packages/ui/src/` first, per the design system.
- Check desktop and phone width, light and dark, and one park theme before sign-off.
