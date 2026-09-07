# Competitor research: Hermes Agent (Nous Research)

Date: 2026-09-06. Sources are the official docs site, the GitHub README and repository, the
product page, and the Nous Portal pages. No third-party write-ups were used. Docs URLs below
start with https://hermes-agent.nousresearch.com/docs/ and are abbreviated to `docs/...`.

## 1. What it is

Hermes Agent is a free, MIT-licensed, open-source personal AI agent from Nous Research. The
README calls it "The self-improving AI agent built by Nous Research" and claims "it's the only
agent with a built-in learning loop" (https://github.com/NousResearch/hermes-agent). It is aimed
at individuals who want one assistant reachable from chat apps and the terminal, at self-hosters
running it on a small server, and at researchers generating training data. It is a Python
program installed with one shell command on Linux, macOS, WSL2 and Android (Termux), one
PowerShell command on Windows, or a native desktop app for macOS and Windows
(docs/getting-started/installation, https://hermes-agent.nousresearch.com/). First-tier support
covers Apple Silicon Macs, Windows 10/11, Linux/WSL2 and Docker; Termux and Nix are best-effort;
Intel Macs, Homebrew and pip installs are unsupported (docs/getting-started/platform-support).
No hardware minimum is stated; the README says "Run it on a $5 VPS, a GPU cluster, or serverless
infrastructure that costs nearly nothing when idle." A hosted option, Hermes Cloud, is in preview
and needs a subscription or $10 of credits (https://portal.nousresearch.com/cloud).

## 2. How the user talks to it

One background "gateway" process connects every configured chat platform, keeps a session per
chat, runs scheduled jobs, and handles voice messages (docs/user-guide/messaging/). Every adapter
below ships in the repository under plugins/platforms/ or gateway/platforms/, so all are
first-party unless marked.

- Terminal: a classic CLI and a newer mouse-friendly terminal UI, which the docs call the
  recommended way to use it interactively (docs/user-guide/tui).
- Desktop app for macOS, Windows and Linux, chat-first with side-by-side previews, voice, file
  browser and settings, sharing the same sessions as the terminal (docs/user-guide/desktop).
- Web dashboard on localhost for settings, keys, sessions, logs, cron jobs and skills, with an
  optional chat tab that embeds the terminal UI (docs/user-guide/features/web-dashboard).
- Chat platforms: Telegram, Discord, Slack, WhatsApp (two routes), Signal, SMS, Email (IMAP and
  SMTP), Home Assistant, Mattermost, Matrix, IRC, Google Chat, Microsoft Teams, LINE, DingTalk,
  Feishu/Lark, WeCom, Weixin, QQ, Yuanbao, iMessage via BlueBubbles or Photon, ntfy, Raft, Buzz,
  SimpleX, and inbound webhooks (docs/user-guide/messaging/). A WeChat bridge called HermesClaw
  is community-made (README).
- Any chat front end that speaks the OpenAI request format, such as Open WebUI, through the
  built-in API server (docs/user-guide/features/api-server). Those front ends are third-party.
- Voice: push-to-talk in the terminal, spoken replies on Telegram and Discord, live conversation
  in Discord voice channels, and a "hey hermes" wake word on the terminal and desktop app
  (docs/user-guide/features/voice-mode, docs/user-guide/features/wake-word).
- Code editors that support the Agent Client Protocol, such as VS Code, Zed and JetBrains
  (docs/user-guide/features/acp).

## 3. Tools out of the box

The docs describe a registry of "40+ tools" grouped into toolsets that can be switched on per
platform (README, docs/user-guide/features/tools). Categories on that page:

- Shell and files: run commands, manage background processes, read and patch files. The shell
  can run locally or inside Docker, over SSH, or in Singularity, Modal, Daytona or Vercel
  sandboxes.
- Web search and page extraction (Firecrawl or similar), plus X/Twitter search via xAI.
- Browser automation with local Chrome or cloud browsers, including a vision mode.
- Vision on pasted images, image generation through FAL, and text-to-speech with ten providers
  (docs/user-guide/features/overview).
- Code execution: the agent writes a Python script that calls its own tools, collapsing many
  steps into one turn (docs/user-guide/features/code-execution).
- Subagent delegation, with three children in parallel by default
  (docs/user-guide/features/delegation).
- A memory tool and a full-text search over past conversations.
- A cron tool for scheduled jobs, a to-do tool, and a "clarify" tool for asking the user.
- Home Assistant device control, Spotify, Discord actions, and any MCP server over stdio or
  HTTP (docs/user-guide/features/mcp).
- A skills tool for loading, creating and editing skill documents (see section 7).
- Checkpoints: it snapshots the working folder before edits so you can roll back
  (docs/user-guide/checkpoints-and-rollback).

Security in one line: a dangerous-command approval prompt, per-platform user allowlists, and
optional container isolation (docs/user-guide/security).

## 4. Memory

Built-in memory is two small text files, not a database (docs/user-guide/features/memory):

- MEMORY.md holds the agent's own notes (environment facts, conventions, lessons), capped at
  2,200 characters. USER.md holds a profile of the user, capped at 1,375 characters.
- Both are pasted into the system prompt at session start as a frozen block. The agent edits
  them itself with add, replace and remove actions. When a file is full the tool refuses the
  write and the agent has to consolidate or delete entries first. There is no auto-compaction.
- Beyond that, every conversation is stored in SQLite with full-text search, and the agent can
  search weeks-old sessions for exact messages.
- After a turn, a background copy of the agent reviews the exchange and may quietly save a
  memory or update a skill. The docs call this the "consent-aware learning loop"; a
  write-approval setting can make it stage changes for human review instead.
- Skills are the other half: the FAQ says memory stores facts and skills store procedures
  (docs/reference/faq).
- Eight optional external memory back ends can be plugged in, one at a time, including Honcho
  (a hosted or self-hosted service that builds a running model of the user), Mem0 and
  Supermemory. When active they add context to the prompt, prefetch relevant memories, and sync
  turns (docs/user-guide/features/memory-providers).
- The docs warn against pointing two agent processes at one home folder because both write
  memory automatically (docs/user-guide/profiles).

## 5. Automation

- Scheduled jobs: a cron scheduler inside the gateway ticks every minute. Jobs can be created in
  plain language in chat, one-shot or recurring, attach skills, run in a fresh session, and
  deliver results to the originating chat, a file, or any configured platform. A "no-agent"
  mode runs a plain script on a schedule with no model involved. Scheduled runs cannot create
  more scheduled runs (docs/user-guide/features/cron).
- In-session timers: a heartbeat re-injects one recurring instruction into the current
  conversation when it is idle, and a loop command re-runs a prompt on a fixed or self-pacing
  interval with stop conditions (docs/user-guide/features/heartbeat,
  docs/user-guide/features/loops).
- Long autonomous tasks: a goal command keeps the agent working across turns until a judge
  model says the goal is met, with a 20-turn budget and optional shell-command quality gates
  (docs/user-guide/features/goals).
- Event reactions: an inbound webhook server accepts signed posts from GitHub, GitLab, Stripe
  and similar and turns them into agent runs (docs/user-guide/messaging/webhooks). Home
  Assistant state changes arrive as events. Lifecycle hooks can run custom Python or shell
  scripts, and outbound webhooks push signed events to other systems
  (docs/user-guide/features/hooks).
- Multi-agent work: a Kanban board in SQLite hands tasks between named agent profiles
  (docs/user-guide/features/kanban), and a batch runner processes thousands of prompts in
  parallel (docs/user-guide/features/batch-processing).
- A skill "curator" runs in the background about weekly to mark stale agent-made skills and
  archive unused ones (docs/user-guide/features/curator).

## 6. Model support

- Provider-agnostic. The provider table lists roughly 50 options: Nous Portal, OpenAI, Anthropic
  (including a Claude Max login), Google Gemini and Vertex, AWS Bedrock, Azure, OpenRouter,
  DeepSeek, Kimi, MiniMax, xAI, Qwen, GitHub Copilot, a ChatGPT/Codex subscription login,
  Ollama, LM Studio, and any custom endpoint (docs/integrations/providers). You switch with one
  command and the README promises "no code changes, no lock-in."
- Bring your own key: most providers take an API key in a local env file; several use a
  browser login instead of a key.
- Local models: the desktop app downloads and manages llama.cpp, sizes the model to your GPU,
  and the FAQ says nothing leaves your computer (docs/user-guide/local-models, docs/reference/faq).
- Subscription: Nous Portal is described as "the recommended way to run Hermes Agent." One login
  gives 300+ models plus a tool gateway bundling web search, image generation, speech and cloud
  browser so you skip separate signups. Tiers are Free, Plus, Super, Ultra
  (docs/integrations/nous-portal, https://portal.nousresearch.com/manage-subscription).
- Nous's own Hermes 4 models are available but the docs say they are "not recommended for use
  inside Hermes Agent" because they are tuned for chat, not tool calling.
- Extras: automatic failover to backup providers, rotating pools of keys, and routing rules by
  cost or speed (docs/user-guide/features/overview).

## 7. Self-improvement and self-extension

- The agent writes its own skills. A skill is a folder with a SKILL.md instruction file and
  optional scripts and reference files, following the agentskills.io open format. The docs
  describe this as the agent's "procedural memory": when it works out a non-trivial workflow it
  saves the approach as a skill for reuse, and it can update or delete any skill later
  (docs/user-guide/features/skills).
- A learn command turns a folder, a web page, a book, or "the workflow you just walked the agent
  through" into a skill without hand-writing it. Large sources become an index plus one file per
  chapter, loaded on demand.
- Skills load in three levels (list, full text, one reference file) to save tokens. Every skill
  is also a slash command.
- The background review after each turn can propose skill edits, and the curator prunes unused
  ones (sections 4 and 5). An optional consolidation pass merges overlapping skills but is off by
  default because a sweep costs 50 to 100 model calls (docs/user-guide/features/curator).
- A Skills Hub installs community skills from registries, and a plugin system lets developers add
  tools, memory back ends and platform adapters in Python (docs/user-guide/features/plugins).
- New native tools still require code; the docs steer contributors to skills first
  (docs/developer-guide/creating-skills).

## 8. Personal-life features

Mostly a general agent plus tools and skills, with a few first-class integrations:

- Smart home: Home Assistant is both a chat platform and four device tools, enabled by one
  token (docs/user-guide/messaging/homeassistant).
- Email: two paths. People can email the agent and get replies in-thread, or the agent gets its
  own mailbox and reads, files and sends mail through a command-line client, with a polling
  schedule (docs/user-guide/messaging/email, docs/guides/agent-email-address). The docs say never
  to hand it your personal inbox.
- Calendar, mail and docs: a bundled Google Workspace skill covers Gmail, Calendar, Drive, Docs
  and Sheets through a CLI; Apple Reminders and Apple Notes skills exist for macOS; Obsidian and
  Notion skills for notes (docs/reference/skills-catalog).
- News: a daily briefing tutorial wires web search, a morning schedule and Telegram delivery
  (docs/guides/daily-briefing-bot); a competitor-news skill watches named companies.
- Health: optional skills for workout and nutrition planning and a brain-computer-interface
  feed (docs/reference/optional-skills-catalog).
- Music: a Spotify toolset for playback and playlists, requiring your own Spotify developer app
  (docs/user-guide/features/spotify).
- Tasks: a to-do tool for the current session and a document-to-action-items skill. There is no
  built-in task list, calendar view, or dashboard of your life; those come from third-party
  services the skills drive.

## 9. Multi-user and web UI

- Designed around one person per agent. The FAQ says multiple people can use one instance
  through the chat platforms, controlled by allowlists and DM pairing (docs/reference/faq), but
  they share one memory and profile. The documented way to give each family member their own
  assistant is a separate "profile" per person, each with its own settings, memory and bot
  tokens, run as separate services (docs/user-guide/multi-profile-gateways).
- Web UI: yes, a localhost admin dashboard with an embedded terminal chat tab, and a desktop
  app. A public bind on the dashboard requires a password or OAuth
  (docs/user-guide/features/web-dashboard). The desktop app's "Bot Mode" turns profiles into a
  roster of named bots that can share group chats and message each other
  (docs/user-guide/bot-mode).

## 10. Stated reasons to choose it

- Repository tagline: "The agent that grows with you." README lead: "It's the only agent with a
  built-in learning loop" that "creates skills from experience, improves them during use, nudges
  itself to persist knowledge" (https://github.com/NousResearch/hermes-agent).
- "It's not tied to your laptop, talk to it from Telegram while it works on a cloud VM" and
  "Run it on a $5 VPS, a GPU cluster, or serverless infrastructure" (README).
- Product page: "One agent, one memory, every surface" (https://hermes-agent.nousresearch.com/).
- Hermes Cloud: "Runs while you sleep" and "No servers, no DevOps, no YAML"
  (https://portal.nousresearch.com/cloud).
- Privacy: "Hermes Agent does not collect telemetry, usage data, or analytics" and calls go only
  to the provider you choose (docs/reference/faq).
- Cost: "free and open-source (MIT license). You pay only for the LLM API usage" (docs/reference/faq).
- Migration path from OpenClaw with a one-command importer (README).

## 11. Known limitations

- Built-in memory is tiny by design (about 1,300 tokens total) and never auto-compacts; the
  agent must prune it (docs/user-guide/features/memory).
- One agent process per home folder; sharing one corrupts memory (docs/user-guide/profiles).
- Scheduled jobs run headless and deny dangerous commands by default; they cannot schedule
  further jobs (docs/user-guide/features/cron, docs/user-guide/security).
- Native Windows lacks the dashboard's embedded terminal (docs/user-guide/windows-native). Phones
  cannot use Docker, local speech transcription or browser automation
  (docs/getting-started/termux). Intel Macs, Homebrew and pip installs are unsupported
  (docs/getting-started/platform-support).
- Many capabilities need separate paid accounts unless you buy the Nous subscription: web search,
  image generation, speech, cloud browser (docs/integrations/nous-portal).
- Nous's own models are not recommended inside the agent (docs/integrations/nous-portal).
- The background learning review "can burn a meaningful share of total tokens on busy hosts"
  (docs/user-guide/features/memory).
- The learning loop can misattribute refusals: the FAQ warns the model may blame a nonexistent
  "Hermes policy" (docs/reference/faq).
- No built-in calendar, task or life dashboard of its own (section 8).

## 12. Popularity signals

From the GitHub API on 2026-09-06 (https://api.github.com/repos/NousResearch/hermes-agent):

| Signal                            | Value                    |
| --------------------------------- | ------------------------ |
| Stars                             | 242,567                  |
| Forks                             | 49,889                   |
| Open issues and pull requests     | 40,395                   |
| Repository created                | 2025-07-22               |
| Last push                         | 2026-09-07               |
| Latest release                    | v2026.8.31 on 2026-08-31 |
| Releases in August 2026           | 8                        |
| Current version in pyproject.toml | 0.21.0                   |

Releases are tagged by date and land several times a month; the docs site has 433 pages.
