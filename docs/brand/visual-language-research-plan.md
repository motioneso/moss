# Moss Visual Language Research Plan

Date: 2026-06-06

## Purpose

This plan defines a research brief that can be given to NotebookLM or another research assistant to
study visual-language options for Moss.

The goal is not to design UI yet. The goal is to collect evidence, compare patterns, identify
anti-patterns, and recommend visual directions that fit the Moss brand foundation in
`docs/brand/brand-brief.md`.

## Brand Context

Moss is the chief of staff for your whole life: a private, adaptive daily briefing and personal OS
that helps users stay ready, follow through, and recover without judgment.

Core product metaphor:

```txt
Daily briefing
```

Primary question:

```txt
What are my priorities today, and how can I prepare for tomorrow?
```

Brand constraints:

- Trust always wins.
- Calm comes before speed.
- Accountability must not become judgment.
- Prepared is personal.
- Autonomy is granted, not assumed.
- Privacy is infrastructure, not personality.
- Context is volunteered, refined, and reversible.

Visual-language constraints:

- Do not make Moss feel like a generic AI chatbot.
- Do not copy Claude's editorial minimalism.
- Do not make it feel like a sterile SaaS dashboard.
- Do not make it feel like a therapy/wellness app.
- Do not use dark/purple glowing AI-product tropes as the default identity.
- Do not use decorative privacy/lock/security motifs as the brand personality.

## Research Output

The research should produce:

1. A market-pattern summary.
2. A visual anti-pattern list.
3. Three candidate design territories.
4. A recommended lead direction.
5. A design principle set.
6. A source-backed rationale with citations.
7. Open questions for the next design pass.

Preferred output file after research:

```txt
docs/brand/visual-language-research.md
```

Follow-up output files may include:

```txt
docs/brand/design-directions.md
docs/brand/anti-patterns.md
docs/brand/visual-principles.md
```

## NotebookLM Research Brief

Use this prompt in NotebookLM after adding the source set:

```txt
You are researching visual language for Moss, a private whole-life chief-of-staff assistant.

Moss is not primarily a chatbot. Its core product metaphor is a daily briefing that answers:
"What are my priorities today, and how can I prepare for tomorrow?"

Brand spine:
- chief of staff for your whole life
- private, adaptive daily briefing
- personal operating system for staying ready
- helps users follow through and recover without judgment
- default personality is composed, thoughtful, lightly dry, and considerate

Values:
- trust always wins
- calm before speed
- accountability without judgment
- prepared is personal
- autonomy is granted, not assumed
- privacy is infrastructure, not personality
- context is volunteered, refined, and reversible

Research task:
Study current AI assistant UX, productivity tools, daily briefing/editorial products, personal
knowledge systems, and command-center interfaces. Identify visual patterns that could help Moss
feel like a daily briefing system rather than a generic AI chatbot or dashboard.

Avoid recommending:
- generic chatbot homepages
- purple/blue AI glow aesthetics
- Claude-like editorial clone patterns
- corporate SaaS dashboard sameness
- therapy/wellness softness
- mascot-style assistant personality
- fear-based privacy/security visuals

Deliver:
1. Summarize the strongest market patterns with citations.
2. List visual and UX anti-patterns Moss should avoid, with examples.
3. Propose three candidate visual directions for Moss.
4. For each direction, describe:
   - emotional feel
   - layout language
   - typography direction
   - color/material direction
   - motion/interaction behavior
   - where it fits the Moss daily rhythm
   - risks and failure modes
5. Recommend one lead direction and one or two supporting modes.
6. Explain how the recommendation supports:
   - morning command center
   - quiet daytime monitoring
   - gentle recovery from drift
   - tomorrow preparation
   - user-configurable persona
7. Provide a concise design principle set for future UI work.
8. End with open questions that need human design judgment.

Prioritize durable product language over trend-chasing.
```

## Source Collection Plan

NotebookLM quality will depend on the source set. Collect sources in five buckets.

### Bucket 1: AI Assistant And Agent UX

Purpose: understand current AI UX patterns and avoid generic chatbot tropes.

Look for sources about:

- AI interfaces moving beyond chat
- agentic UX
- human-in-the-loop controls
- trust and transparency in AI products
- personalization and adaptive interfaces
- AI assistant identity/persona

Suggested source types:

- UX research articles
- product design essays
- HCI trend reports
- official product launches or design notes from AI products
- public product pages

Candidate products to inspect:

- ChatGPT
- Claude
- Perplexity
- Notion AI
- Microsoft Copilot
- Google Gemini
- Linear agent or AI surfaces
- Rewind/Limitless-style personal AI products, if available

Questions:

- Which AI products still center chat as the whole product?
- Which products turn AI into contextual tools or workflow-specific surfaces?
- How do products show confidence, provenance, reasoning, or action boundaries?
- What visual patterns now feel generic or overused?

### Bucket 2: Daily Briefing And Editorial Interfaces

Purpose: understand briefing, hierarchy, scanning, and editorial rhythm without copying Claude.

Look for sources about:

- daily briefings
- news digests
- morning newsletter layouts
- editorial hierarchy
- newspaper-inspired digital layouts
- information-dense but readable interfaces

Candidate references:

- Apple News
- Bloomberg
- Financial Times
- The Economist
- Axios
- Morning Brew
- The New York Times briefing formats
- Wall Street Journal briefing formats
- Quartz-style briefings
- email newsletter designs

Questions:

- How do briefing products establish importance quickly?
- How do they separate headlines, context, action, and background?
- What makes editorial layouts feel trustworthy rather than decorative?
- Which newspaper-like patterns feel modern, and which feel nostalgic or heavy?
- How can Moss borrow briefing structure without copying Claude?

### Bucket 3: Productivity, Planning, And Command-Center Tools

Purpose: understand daily planning, priorities, commitments, risk, and action surfaces.

Candidate products:

- Todoist
- Things
- Sunsama
- Akiflow
- Motion
- Reclaim
- TickTick
- Superhuman
- Linear
- Raycast
- Arc
- GitHub dashboards

Questions:

- How do these tools handle today's priorities?
- How do they show overdue/drift without shame?
- How do they separate planning, doing, and review?
- What density feels useful rather than overwhelming?
- What command-center patterns could support morning planning?

### Bucket 4: Personal Knowledge And Memory Systems

Purpose: understand long-term context, values, interests, notes, and continuity.

Candidate products:

- Notion
- Obsidian
- Capacities
- Reflect
- Mem
- Anytype
- Tana
- Readwise Reader

Questions:

- How do these products make memory and context visible?
- What patterns help users inspect and correct what the system knows?
- How can values, interests, and long-term priorities appear without becoming clutter?
- What interfaces feel personal without becoming cute or overly soft?

### Bucket 5: Trust, Privacy, And Confirmation UX

Purpose: understand how to show permission, autonomy, audit, and privacy without making privacy the
brand personality.

Look for sources about:

- permission design
- confirmation UX
- audit logs
- high-trust admin tools
- privacy controls
- explainability in AI products

Candidate references:

- password managers
- admin audit-log interfaces
- GitHub permission and token flows
- Google/Microsoft OAuth consent flows
- banking or fintech confirmation screens
- security settings in consumer products

Questions:

- How do trustworthy products show irreversible or sensitive action states?
- How do they avoid fear-based visual language?
- How can autonomy be shown as granted, scoped, and reversible?
- What should happen visually when Moss is asking versus acting?

## Evaluation Rubric

Use this rubric to score each candidate visual direction from 1 to 5.

| Criterion              | Question                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------- |
| Brand fit              | Does it feel like a whole-life chief of staff?                                          |
| Briefing strength      | Does it make the daily briefing feel primary?                                           |
| Trust                  | Does it feel careful, transparent, and reliable?                                        |
| Calm                   | Does it reduce overwhelm rather than amplify it?                                        |
| Accountability         | Does it support follow-through without judgment?                                        |
| Distinctiveness        | Does it avoid generic AI/productivity styling?                                          |
| Extensibility          | Can it support tasks, calendar, email, notes, chat, briefings, settings, and interests? |
| Personalization        | Can it adapt to user values, priorities, interests, and persona?                        |
| Density control        | Can it support both scan-friendly summaries and deeper context?                         |
| Implementation realism | Can the direction be built incrementally in the current React/Vite app?                 |

Recommended scoring format:

```txt
Direction: <name>
Brand fit: 1-5
Briefing strength: 1-5
Trust: 1-5
Calm: 1-5
Accountability: 1-5
Distinctiveness: 1-5
Extensibility: 1-5
Personalization: 1-5
Density control: 1-5
Implementation realism: 1-5
Total: <score>/50
Primary risk:
Best use:
```

## Candidate Design Territories To Investigate

### Territory 1: Briefing Desk

Editorial and daily-packet inspired. Priorities, risks, context, and prep are organized like a
high-trust briefing rather than a dashboard.

Investigate:

- section hierarchy
- datelines and daily issue framing
- concise summaries
- marginalia and annotations
- "prepared for today" framing
- source/provenance treatment

Risks:

- can become too Claude-like
- can become too newspaper nostalgic
- can under-support command/action surfaces

### Territory 2: Readiness Console

Operational and planning-oriented. Strong for morning planning, risk tracking, follow-through, and
"what needs attention" views.

Investigate:

- priorities and risk states
- command center layouts
- progress and queue treatment
- compact status language
- action readiness and next-step controls

Risks:

- can become sterile SaaS dashboard
- can feel too work-first
- can amplify anxiety if status/risk are overemphasized

### Territory 3: Personal Ledger

Continuity and memory-oriented. Strong for values, life context, recovery, reflection, and whole-life
personalization.

Investigate:

- journals and ledgers
- personal knowledge systems
- context cards
- values/priorities surfaces
- recovery and re-entry patterns

Risks:

- can become too soft or therapy-adjacent
- can feel less operational
- can become text-heavy

## Expected Recommendation Shape

The research should not choose a single visual metaphor for every state. A likely successful answer
will be:

```txt
Lead direction: Briefing Desk
Planning mode: Readiness Console
Recovery/context mode: Personal Ledger
```

The research should validate, challenge, or revise that hypothesis.

## Anti-Patterns To Watch For

Document examples of:

- generic AI chat homepages
- glowing gradient/orb AI branding
- purple-blue "intelligence" palettes
- endless card dashboards
- shame-heavy overdue/task states
- overly clinical wellness styling
- mascot-like assistant UIs
- privacy/security fear visuals
- interfaces that hide why AI recommended or acted
- interfaces that over-personalize without user control

## Research Questions

1. What visual patterns make a digital briefing feel trustworthy and useful?
2. What patterns make a personal assistant feel competent without feeling invasive?
3. How can Moss show priorities, risks, and prep without creating anxiety?
4. How can the interface support user-configurable personality without becoming gimmicky?
5. How should the product distinguish ask/recommend/prepare/act states?
6. How can privacy and autonomy be visible only when relevant?
7. What UI language supports a whole-life system rather than a work-only productivity app?
8. What should the morning briefing, quiet monitoring, recovery, and tomorrow-prep modes have in
   common?
9. Which visual motifs are already overused in AI products?
10. Which references should Moss explicitly avoid resembling?

## Final Research Deliverable Template

Use this structure for the final research document:

```markdown
# Moss Visual Language Research

Date: YYYY-MM-DD

## Executive Summary

## Source Set

## Market Patterns

## AI UX Patterns

## Briefing And Editorial Patterns

## Productivity And Command-Center Patterns

## Personal Knowledge And Memory Patterns

## Trust, Privacy, And Confirmation Patterns

## Anti-Patterns

## Candidate Direction 1: Briefing Desk

## Candidate Direction 2: Readiness Console

## Candidate Direction 3: Personal Ledger

## Scoring

## Recommended Direction

## Design Principles

## Open Questions

## Source Notes
```

## Notes For The Human Reviewer

When reviewing NotebookLM output, watch for:

- shallow trend summaries without concrete UI implications
- sources that only describe AI architecture rather than user-facing UX
- recommendations that copy one product too closely
- recommendations that ignore ADHD-aware recovery and anti-shame principles
- recommendations that make privacy/security too visually dominant
- design language that depends on a full redesign before it can help the current app
