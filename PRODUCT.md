# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Technical self-hosters: people comfortable running a server on their own hardware, who accept
setup work in exchange for control and privacy. They tolerate settings, detail and configuration
screens, and they expect to see and control what the assistant does with their data.

The product also serves a second, non-technical audience indirectly: household or family members
of the installer may use it day to day. Their needs are not yet a confirmed design constraint.

## Product Purpose

Moss is a self-hosted AI assistant for everyday life. It brings notes, tasks, calendar, email,
goals, commitments, people, wellbeing and interests into one place, then lets the user talk to it
to plan a day, find something saved, track a commitment, or work through a goal.

Modules give the assistant tools to act on the user's information, and give the user dedicated
screens to browse and manage that information directly. Success is a user who starts their day in
Moss and trusts it with the information they would otherwise scatter across other tools.

Status: active alpha. Features and installation are still changing.

## Positioning

**You can grow Moss by asking.** The user describes a capability they want; Moss plans it,
shows the plan and a mockup for approval, builds it, and installs it as a real module with its own
screens and assistant tools. That is what the Workshop is. No mainstream assistant lets its user
extend it by conversation.

Supporting, but not the differentiator: it runs on the user's own hardware, data is private by
default, administrator access does not bypass private-data permissions, and the user brings their
own AI provider.

## Operating Context

Used equally on desktop and on a phone. Every screen must work as well at phone width as in a wide
browser window; neither leads. On desktop the assistant lives in a drawer beside the current
screen; on a phone that drawer is the chat surface and stays a drawer.

Typical scenes: planning the day at a desk in the morning, checking or capturing something on a
phone during the day, and longer sessions configuring modules, connectors and providers.

## Capabilities and Constraints

- Modules can be enabled, installed from Settings, or built through the Workshop. Installed
  modules contribute navigation entries, screens, settings and assistant tools.
- The assistant is provider-agnostic. Features request capabilities and a router picks the user's
  configured model; no provider or model name is ever hardcoded.
- Private by default. Content is owner-only unless explicitly shared, and admin power is
  configuration power only.
- Self-hosted storage does not mean local AI. Hosted providers receive prompts and relevant
  context; connectors and web tools make external requests.
- The design system is authored, not generated: shared `jds-*` primitives and the tokens in
  `apps/web/src/styles/tokens.css` are the only source of colour, type and spacing. Module CSS is
  layout-only by contract.
- Every product change must keep the app map truthful, so the assistant can describe and navigate
  its own screens.

## Brand Commitments

- Name: Moss. Repository and internal codename: Jarv1s.
- Voice: plain English. No jargon, no coined shorthand, no code names or file paths in anything a
  user reads. Ordinary words over invented ones.
- Typography: a display face for headings, a sans face for body. No monospace (retired
  2026-07-08) and no serif, with the sports nameplate as the single exception. Labels and data use
  the sans face with tabular figures.
- Layout: use the horizontal space. Wide content, not a narrow column marooned in large gutters.

## Evidence on Hand

- Real product screenshots of a representative user's day in `docs/images/readme/`.
- An approved interaction prototype for the Workshop covering the whole journey, with a separate
  sheet of loading and failure states, in
  `docs/superpowers/specs/assets/2026-09-04-workshop/`. Both approved by the product owner on
  2026-09-04.
- An earlier Workshop sketch set in `docs/superpowers/specs/assets/2026-08-19-moss-workshop/`.
- No customers, testimonials, pricing, benchmarks or press exist. Future work must not invent any.

## Product Principles

1. **The user can extend the product by asking.** Anything that makes building a module feel like
   filing a ticket is a failure of the core promise.
2. **Private by default, and visibly so.** The user should be able to see who can reach a thing
   without hunting for it.
3. **Say it in plain English.** Every label, error and explanation is written for someone who does
   not know how the system is built.
4. **The assistant and the screens are one product.** Anything the user can do by talking, they
   can also see and manage on a screen, and the reverse.
5. **Honest states over reassuring ones.** Show what is actually happening, including switched
   off, waiting, failed and not yet built.

## Accessibility & Inclusion

No product-specific standard has been established beyond the design system's own rules. Both phone
and desktop are first-class, so touch targets and reflow at phone width are real requirements
rather than afterthoughts.
