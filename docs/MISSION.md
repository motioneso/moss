# Moss Mission

Moss is a **privacy-first, self-hostable AI personal assistant OS**. It is built to be grounded in your own knowledge and life.

## What it does

Moss uses **your vault of notes** — the record of your work, projects, commitments, and relationships. It helps you by:

- Giving you **daily briefings** that surface what actually matters today.
- Tracking your **commitments and tasks**, watching for drift before it becomes a problem.
- Monitoring your **wellbeing** to help you see patterns over time.
- Connecting to your **calendar and email** to keep your context current.
- Acting as an **assistant** that knows your context. It always asks before taking action: you stay in charge.

## What it isn't

Moss is not a general-purpose chatbot or a cloud service. It runs on your hardware, keeps your data private, and never sends content to an AI provider without your explicit setup. Every AI capability is BYO-provider: you bring your own API key or run a local model. Nothing is locked to a single vendor.

## Design principles

- **Private by default.** Data is owner-only unless you choose to share it. No admin bypass.
- **Modular.** Every feature is a module following the same SDK. Built-in and future modules are peers.
- **Spec before build.** Every milestone starts with a written design and exits only when tests pass and invariants hold.
- **Provider-agnostic AI.** Features request capabilities; a router selects your configured model. Provider-specific code stays in extensions, not core.

## The honest acceptance test

Moss is working when you genuinely use the morning briefing: grounded in your real vault, synthesized by a real model, and useful enough that you'd miss it if it stopped.
