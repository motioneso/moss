# Workshop interaction prototype

Status: product design and prototype approved by Ben on 2026-09-04 (“yea that looks good”).
Implementation contract: [Workshop projects and supervised builds](../../2026-09-04-workshop-projects-and-supervised-builds.md).
Related work: [assessment](../../../../reviews/2026-09-04-workshop-assessment.md) and
[issue #2023](https://github.com/motioneso/moss/issues/2023).

## Open and review

From `~/Jarv1s`, run:

```sh
python3 -m http.server 8769 --bind 127.0.0.1
```

Open <http://127.0.0.1:8769/docs/superpowers/specs/assets/2026-09-04-workshop/>.
The [HTML file](index.html) also opens directly from the checkout. It loads the existing Moss
styles using relative paths, so keep it inside the repository.

The [supplementary state sheet](states.html) is a separate review artifact. Use its **Show a
state** control to inspect loading, fetch and mutation failures, reconnect, MockupV1 preview
recovery, and saved-word storage limits. Controls are labeled simulated and do not call Moss.

Use **New project** for the full journey. The separate **Interaction prototype** bar switches
sample states and supplies simulated completion events. It is review tooling, not proposed
product UI. No model, database, installation, actual sharing, or persistent storage is used.
Free text is rendered safely and acknowledged as prototype input; it does not generate a module.
There is one example project in memory. New project replaces that example; refresh resets it.
Navigation within the example preserves conversation, unfinished input, and draft state.

Suggested walkthrough:

1. New project → Create project → Same word all day → Prepare plan + mockup.
2. Use **Complete plan** in the prototype bar. Review the plan beside the page sketch.
3. Choose **Add saved words**, then **Complete plan**. The revision describes the changed
   behavior and private storage. **Saved words** inside the mockup previews that second view.
4. Approve that revision. Use **Complete build** to simulate checks and installation.
5. Save, view, and remove the sample word. Finish privately. Sharing requires a separate dialog.
6. Choose **Running draft**, then **Let me save words** to try refinement of an existing version.
   During that build, select **Failed check**. The previous draft remains available.
7. During a build, select **Build question** to answer and continue the same attempt. Or stop it:
   **Stopping** remains distinct from **Stopped** until **Confirm builder stopped** is selected.

## Approved interaction decisions

The main design is one persistent project workspace. Conversation stays on the left; the current
plan, review, build state, or draft occupies the larger right side. On screens up to 800 CSS pixels,
**Conversation** and **Project work** switch views. Plan-ready events reveal the review; questions
reveal the conversation. Content and unsent input survive those switches.

The default project list is an ordinary list with a clear next action and privacy label. Project
creation asks for a name and an idea; it does not launch a build. The **Arrive from Moss** sample
shows the same workspace with previously settled requirements already carried over.

| State              | What the user sees and can do                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Requirements       | One focused question; answer it or add context.                                                                       |
| Planning           | Reasoning role shown beside the same project assistant; conversation stays available.                                 |
| Review             | Purpose, data/access, acceptance examples, scope, and visual mockup together. Approval names the exact plan revision. |
| Building           | Observed work and attempt identity; stop control; details available without a terminal.                               |
| Needs answer       | Concrete question and next action; waiting is not presented as active work.                                           |
| Check failed       | The failed behavior, effect on the attempt, retry/revise actions, and previous usable draft.                          |
| Stopping / stopped | Cancellation request and confirmed process exit are separate states. Conversation and plan survive.                   |
| Draft              | Interactive module next to its conversation; request a change or finish privately.                                    |
| Finished           | Module stays private and the project remains available for refinement.                                                |
| Share              | Separate confirmation about module availability; conversation and personal data remain private.                       |
| Model unavailable  | Preserve the project; explain unavailable reasoning configuration and offer planning retry.                           |

For the design proof, adding saved words changes the storage requirement and always returns to
plan/mockup review. A previous approval never authorizes the new revision. The runtime must bind
approval to the exact artifacts and reject stale approvals, beyond disabling an old UI button.

Ben confirmed the layout during review: conversation and project work stay side by side on
desktop, with switchable views on phones. He then reviewed the prototype remotely over Tailscale
and approved the design. On 2026-09-04 he also approved the supplementary state sheet
("states look good"), satisfying A1's design-review gate. The implementation must replace
its simulated behavior with real services.

## Code basis and implementation boundaries

This sketch follows the existing spec-asset precedent from August 19. The real app uses React;
this disposable HTML/JavaScript demonstrates interactions without adding a production route.
Use the app’s components and persistence when implementing, not this script as a runtime foundation.

- Palette, fonts, spacing, and state colors come directly from
  `apps/web/src/styles/tokens.css`. Current display and body tokens share the Helvetica fallback.
- Buttons, forms, and empty states load the authored `packages/ui/src/styles/` primitives.
  No new `jds-*` classes or font/color tokens are introduced. Prototype CSS is local to the artifact.
- The assessment identifies the real gaps in Workshop coordination, cancellation, routing,
  private completion, generated module validation, and app-map metadata. This artifact fixes none
  of those backend gaps and is not evidence of a working Workshop.
- Production must provide durable projects, idempotent creation/handoff, event delivery,
  actual selected-model diagnostics, restart/reconnect recovery, isolated host storage,
  checked installation, separate finish/share operations, and app-map declarations.
- Runtime guardrails belong in the implementation spec and host enforcement. The UI surfaces
  behavior, data, and authority the user needs to approve, not SDK machinery.
- Full permission/authority changes, unsupported capabilities, and stale/reconnecting sessions
  still need implementation contracts and acceptance cases. The sample is deliberately limited
  to pages, bundled words, and host storage; custom SQL provisioning remains later work.

The linked implementation spec now defines the project/attempt state model, API and ownership
boundaries, selected-model propagation, custom-module contract checks, and live Word of the Day
proof. Existing `shipExternalModule` cannot stand in for private finish.

## Verification

With the preview server running, from `~/Jarv1s`:

```sh
node docs/superpowers/specs/assets/2026-09-04-workshop/check.mjs
```

The isolated Playwright check exercises project creation, plan revision approval, build questions,
stopping/retry, failed refinement preserving the old draft, saving/removal, private finish and
explicit share, escaped input, navigation with unsent text, model recovery, and keyboard submission.
It checks 11 states at each of 320, 375, 414, and 768 pixels for horizontal overflow and clipped
controls, including both mobile views. It asserts no browser script or failed asset responses.
Desktop and mobile artifact captures are saved to the temporary directory for cropped review.

This is prototype verification only. It does not prove real daily selection, reload persistence,
owner isolation, model routing, cancellation, or installed-module behavior. Sample check results
in the interface are visibly identified as simulation. No database or live-path test was run.

The state sheet adds design evidence for the remaining UI states; its MockupV1 panel represents the
host-rendered raster contract (artifact ID, hash, dimensions, alt text, and screen/state navigation)
without loading a real artifact. Production still needs the owner-scoped PNG/WebP route and
validation described in the implementation spec.

Hallmark review: existing Moss branding overrides catalogue font/theme rotation; product-workspace
layout overrides marketing-page structures. Cropped review found a clear conversation/work split,
readable plan/mockup hierarchy, token-only colors and fonts, and no decorative chrome or progress
percentages. Self-critique: philosophy 4, hierarchy 4, execution 4, specificity 4, restraint 4,
variety 4. This is an applied review, not a claim that every marketing-page gate applies.
