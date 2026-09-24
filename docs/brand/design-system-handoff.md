# Jarvis Design System — Handoff Brief for Claude Design

> **Superseded by [docs/design-system.md](../design-system.md).** Kept as a dated record.

> **Dated record — kept verbatim.** The product is now named **Moss** (decided 2026-08-06, #1441).
> This brief is left in its original wording because it names the codename the referenced design
> deliverables were actually produced under, and because it explicitly scoped public-name
> finalization out of that engagement. Read every "Jarvis" below as the product now called Moss.

**Date:** 2026-06-13
**Prepared for:** Claude Design
**Scope of engagement:** **Option A — the complete Jarvis visual design system** (the "design book"): logo, typography, color, iconography, motion, a component library, and high-fidelity key screens, all grounded in the brand and research already documented in `docs/brand/`.

This document is the **entry point**. It (1) describes what Jarvis is, (2) states the locked decisions, (3) defines what to design and what's out of scope, and (4) lists the supporting source documents to read. It is self-contained: with this brief plus the listed source docs, you have everything needed to begin.

---

## 0. The one critical exclusion (read first)

**The existing frontend code is NOT a design input. Ignore it entirely.**

- `apps/web/src/styles/tokens.css` and everything in `docs/brand/mockups/*.html` were built **only to test frontend engineering capability**. They are not taste-approved, were never signed off, and must **not** be referenced, sampled, or treated as a starting point. The teal accent, the specific hex values, the mockup layouts — all disregarded.
- **The only grounding for this design system is the brand + research documents listed in §7.** Design from those, from scratch.

---

## 1. What Jarvis is

**Jarvis is a private, whole-life chief of staff: a single-user personal operating system whose primary ritual is a daily briefing.** It helps one person stay ready, follow through, and recover — without judgment.

**The brand spine:** _Jarvis is the chief of staff for your whole life: a private, adaptive daily briefing and personal OS that helps you stay ready, follow through, and recover without judgment._

**The core question Jarvis answers every day:** _"What are my priorities today, and how can I prepare for tomorrow?"_ The user should never have to reconstruct their life from scratch each morning. Jarvis carries the context, commitments, risks, priorities, and resources so fewer things slip and the user can re-enter the day with less anxiety.

**What it is NOT:** not a chatbot, not a smart calendar, not a productivity SaaS dashboard, not a wellness/therapy app, not an ADHD-recovery app, not an endless feed. Chat is _a tool inside the product, never the spine._

### How it actually works (the experience to design for)

- **Single-user and private by default.** Each user has their own assistant, context, goals, settings, permissions, and briefing. Privacy is felt through restraint and correct behavior — _not_ through lock icons and fear language.
- **The day is the primary unit; the week is the planning horizon; the user's goals/values are the compass.** Preparedness is the center of gravity — getting on top of things before the day gets on top of you. Recovery is the failure-mode response when prep wasn't enough or life changed.
- **Two daily rituals with different jobs:**
  - **Morning briefing** = the prepared _execution_ brief. Operational: today's schedule, tasks & priorities, drift & risks, weather/travel, major overnight changes. The user should leave oriented, ready, and realistically confident.
  - **Evening interview** = the _planning conversation_. Reflective and preparatory: what happened, what was accomplished, what changed, tasks created today, what carries into tomorrow, tomorrow's blocking. It starts as a readable report and becomes a chief-of-staff conversation where the user resolves issues, adjusts priorities, and sets up the next day.
- **The briefing is live, not static.** It's surgically patched through the day as meetings move and tasks complete. Changes are **ambiently visible** (a subtle badge / changed-section marker), never interruptive. Jarvis interrupts only for _consequence_, not activity. The original generated briefing is preserved as a historical snapshot.
- **Briefings will become audio-visual over time.** Every audio item has a visual counterpart. (Audio-visual sync is future, not this round — but design the briefing so it could be narrated.)
- **The unified Task list is the primary action surface.** Jarvis-created tasks are _real_ tasks in the same list (never a separate "review queue" inbox), distinguished only by source/provenance. A system-owned **urgency/drift signal** ("due today," "overdue," "stale," "at risk") is distinct from the **user-owned priority**.
- **Autonomy is granted, not assumed.** Jarvis starts by observing, briefing, recommending, and asking; the user grants scoped autonomy as trust grows. Permissions are inspectable, reversible, and separate data-access from action-authority. Actions are auditable with undo where possible.
- **Jarvis has a visible "what Jarvis knows about me" profile** — confirmed facts (user-stated) separated from inferred patterns (with confidence/source, and promote/reject/edit controls). The user can correct any belief in context.
- **Modules** (calendar, email, wellness, finance, etc.) plug in. Wellness is optional, private, and first-class when enabled. Sensitive rationale is abstracted ("lighter plan recommended based on today's capacity signals"), never raw.

### Personality & voice (what the _visuals_ must embody)

Default Jarvis is **composed, intelligent, dry-but-not-sharp, thoughtful, considerate, concise, grounded.** Confidently directive — it comes with a point of view, not a neutral menu of options — while staying inspectable and overridable. Humor is _earned by context_: it appears in low-stakes moments and sign-offs, **never** when the user is overwhelmed, in sensitive content, or recovering from drift.

Voice: _competent, calm, direct, lightly dry, modern, useful._ Positioning line: **"Useful in the modern age, not impressed with itself."**

**Recovery / anti-shame is a first-class design rule, not an error state.** Normal human drift (a slipped task, a missed block, an at-risk commitment) is **never** rendered as a red error. It uses calm, muted/amber treatment and recovery language: _"This slipped. We can reset it." / "Here's the smallest useful next step."_ — never _"You failed" / "You're behind."_ No gamified shame, no streak-loss punishment, no productivity moralizing.

---

## 2. The locked visual direction

The visual language is **locked to Direction 3 — "The Chronological Flow / Ritual Model"** (`docs/brand/visual-language-research.md`, §3, chosen by Ben 2026-06-13). Read that document in full; the essentials:

- **Chronological / timeline-centric.** The day is organized by flexible time-buckets — **This Morning / This Afternoon / This Evening** — not rigid minute-by-minute time-blocking. Structure without rigidity.
- **Instruments over conversations.** The briefing and day-view are _reading and steering_ surfaces (a steering wheel), not a chat stream. Use **dynamic blocks** that appear, populate, and adapt to show what Jarvis understood — not a blank prompt box.
- **Governors — expose the logic.** AI-generated / unconfirmed content renders at **~70% opacity** with a clear "provisional, not yet confirmed" affordance, reaching full opacity only when the human confirms. Show the reasoning where Jarvis acted.
- **Respect the periphery.** Glanceable, ambient cues (think indicator lights, quiet status tones) keep awareness without dominating the center.
- **Calm but substantive.** (See §3 tonal spine.)

### Tonal spine (locked this session)

**Calm-Ritual dominant — but competent and information-rich, NOT airy wellness minimalism.** The everyday feel is calm, quiet, and editorial-leaning, with generous-but-not-sparse rhythm. Borrow **Instrument precision** (clean data readouts, monospaced numerics/timestamps, predictable fixed layouts) as _seasoning where it adds clarity_ — not as the dominant cockpit register. The **Living Archive / editorial** mode is the natural fit for the briefing _reading_ surface (comfortable measure, strong vertical rhythm). The morning "command center" moment may carry a touch more instrument-density.

---

## 3. The HARD STOP list (non-negotiable)

These are forbidden, everywhere:

- ❌ **No "AI glow"** — no purple/blue neon gradients, no sparkle / magic-wand / "✨" icons.
- ❌ **No chat-first dominance** — chat is a secondary tool; the product is not a blank text box.
- ❌ **No mascots or therapeutic/wellness softness** — no friendly bots, no cutesy illustration, no "calm app" mushiness.
- ❌ **No error-red for normal human drift** — anti-shame states are amber/muted. Red is reserved for genuine system/validation errors and destructive actions only.
- ❌ **No horizontal pagination** (disrupts reading/highlighting).
- ❌ **No corporate-SaaS-dashboard or Claude-editorial-clone aesthetic**, no AI-hype, no productivity moralism.

---

## 4. Locked decisions (from the 2026-06-13 design interview)

| Decision                        | Locked answer                                                                                                                                                                                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Name**                        | Design under **"Jarvis"** (codename; public name is a separate later track). Wordmark says "Jarvis."                                                                                                                                                                                        |
| **Existing frontend artifacts** | **Ignored** — not design inputs (see §0).                                                                                                                                                                                                                                                   |
| **Tonal spine**                 | Calm-Ritual dominant, but **substantive/information-rich**, not sparse-wellness.                                                                                                                                                                                                            |
| **Typography**                  | **CD proposes options** — a type _system_ with roles: UI sans (workhorse), an optional reading face (briefing), a mono (numerics/data). Constraint: **open-license / self-hostable** fonts; calm, competent, highly legible; no quirky/wellness-soft faces.                                 |
| **Color**                       | **CD proposes palette options from scratch.** Must honor: anti-shame states (amber/muted, never red for drift), red reserved for true errors, ~70% governor opacity for provisional content, and the STOP list. _(Circadian/time-of-day color shifting is dropped this round — see below.)_ |
| **Themes**                      | **Light + dark, both required.** **No** circadian / evening-amber time-of-day theming this round.                                                                                                                                                                                           |
| **Platform**                    | **Desktop web is the primary canvas this round**, but the design **must be responsive** — nothing may be designed in a way that makes a later mobile/PWA polish difficult.                                                                                                                  |
| **Logo**                        | CD presents **2–3 distinct directions** (wordmark + symbol + app icon each), grounded in brand/values, honoring the STOP list. Ben picks one to refine later.                                                                                                                               |
| **Iconography**                 | **Delegated to CD** — propose a cohesive icon language (calm/precise line icons; no sparkle/magic).                                                                                                                                                                                         |
| **Motion**                      | **Delegated to CD** — deliver motion **principles + a few key transitions** (calm, quick, purposeful: provisional→confirmed, briefing section updates, recovery states), not an exhaustive motion library.                                                                                  |

---

## 5. What to deliver (the design book)

1. **Brand identity** — 2–3 logo directions (wordmark + symbol + app icon), with a recommendation.
2. **Type system** — proposed pairing(s) by role, with specimens and usage rules.
3. **Color system** — light + dark palettes (proposed as options), with semantic roles defined (surfaces, text, accent, anti-shame states, governor/provisional, true-error).
4. **Iconography** — the icon language + a starter set covering core actions/objects.
5. **Motion** — principles + key transitions.
6. **Component library** — the reusable kit (see §6).
7. **High-fidelity key screens** — in light + dark, responsive (see §6).
8. **The design-book document itself** — principles, do/don't, and how the system expresses the brand, so engineering can implement against it.

---

## 6. Recommended coverage (screens, states, components)

> This is the _recommended_ scope — adjust with Ben. The goal is enough to prove the system holds across the calm-reading, dense-planning, and form-heavy extremes.

**Hero screens (design these well):**

1. **Morning briefing** — the prepared execution brief (reading surface + ambient "changed since you last looked" markers).
2. **Evening interview** — the reflective planning conversation (report → conversation).
3. **Day view / Tasks** — time-bucket chronology (This Morning / Afternoon / Evening), drift signals distinct from user priority, anti-shame at-risk treatment.
4. **Onboarding** — the "get to know me" invitation (skippable, progressive, never nagging).
5. **"What Jarvis knows about me"** — the user-model profile: confirmed facts vs inferred patterns (confidence + promote/reject/edit).
6. **Settings + permissions/autonomy** — the form-heavy proof: data-access vs action-authority controls, usage/cost appetite, audit/activity history.
7. **App shell** — global nav, top bar, the "command center" framing.
8. **Chat drawer** — the _secondary_ tool (must not read as the spine).

**Critical states (must be designed, not afterthoughts):**

- **Recovery / drift** (anti-shame, amber/muted, recovery language)
- **Provisional / governor** (70%-opacity AI content + confirm affordance)
- **Empty, loading, and ambient-update** states
- **Privacy mode** (user-toggled briefing detail suppression for shared screens)

**Component library (starter inventory):**
Cards, buttons (primary/secondary/quiet), inputs & form controls, badges/chips (incl. drift/at-risk tones), the **time-bucket section header**, the **provisional/governor wrapper**, task row, briefing section block, nav + top bar, modals/sheets, ambient toasts/indicators, the audit/activity list, the confirmed-fact vs inferred-pattern row.

---

## 7. Source documents to read (the grounding)

**Read these — they are the only grounding for the design system:**

| Doc                                           | What it gives you                                                                                                     | Priority             |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `docs/brand/visual-language-research.md`      | **The locked visual direction** (Direction 3), market patterns, STOP list, design principles for durable intelligence | ★★★ essential        |
| `docs/brand/brand-brief.md`                   | Brand spine, values, personality, voice, recovery language, daily rhythm, open brand questions                        | ★★★ essential        |
| `docs/brand/product-goals-and-ideals.md`      | How the product behaves — briefings, tasks, autonomy/permissions, user model, modules, advisor personas               | ★★ important context |
| `docs/brand/brand-questionnaire.md`           | The brand interview + current working answers                                                                         | ★ supporting         |
| `docs/brand/visual-language-research-plan.md` | Methodology behind the research (background)                                                                          | ☆ optional           |

**Explicitly NOT design inputs (do not read as direction):**

- `apps/web/src/styles/tokens.css` — frontend capability test only.
- `docs/brand/mockups/*.html` — frontend capability test only.
- `docs/superpowers/specs/2026-06-13-p3-design-direction-ritual-design.md` — an _engineering implementation slice_ spec, not the design brief; ignore for design direction.

---

## 8. Out of scope this round

- Public/legal name finalization (design under "Jarvis").
- Circadian / evening-amber time-of-day theming.
- A dedicated mobile/PWA screen set (responsive foundations only).
- Audio-visual briefing sync / narration UI (design briefing so it _could_ be narrated; don't build the AV experience).
- Advisor-persona and full per-module screen sets (cover the core; modules come later).
- Final motion library (principles + key transitions only).
