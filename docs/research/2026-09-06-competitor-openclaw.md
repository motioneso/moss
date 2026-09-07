# Competitor research: OpenClaw

Date: 2026-09-06. Sources are primary only: the official docs at docs.openclaw.ai, the GitHub
repository and its API, the official blog at openclaw.ai/blog, and the ClawHub registry. Every
claim carries the URL it came from. Security and sandboxing are deliberately left to one line.

## 1. What it is

OpenClaw is an open-source, self-hosted AI assistant that "runs on your devices and meets you in
the channels you already use" (https://github.com/openclaw/openclaw). It began as a weekend
project called WhatsApp Relay by Peter Steinberger, was named Clawd in November 2025, then
Moltbot, then OpenClaw on 29 January 2026
(https://openclaw.ai/blog/introducing-openclaw). Since July 2026 it is stewarded by the
OpenClaw Foundation, a US non-profit, with OpenAI as a major donor and Steinberger, now at
OpenAI, keeping technical decision-making
(https://openclaw.ai/blog/introducing-openclaw-foundation). It is aimed at "developers, power
users, and teams who want an AI assistant they can message from anywhere" and who do not want
to hand their data to a hosted service (https://docs.openclaw.ai). The centre is a single
long-running program called the Gateway that owns sessions, routing, tools and chat
connections; the web control panel, command line, chat apps and phone apps all connect to it
(https://docs.openclaw.ai/concepts/architecture, https://github.com/openclaw/openclaw).
Install is a one-line script on macOS, Linux, WSL2 or Windows, or npm, Docker, Nix or source;
it needs Node 22.22 or newer and an API key from a model provider
(https://docs.openclaw.ai, https://docs.openclaw.ai/install). It is lightweight: "a small VPS
or Raspberry Pi-class box is fine; 4 GB RAM is plenty" (https://docs.openclaw.ai/help/faq).
Phones and Macs attach as "nodes", peripherals that add camera, screen, location and voice but
never host the Gateway (https://docs.openclaw.ai/nodes). MIT licensed
(https://docs.openclaw.ai/reference/credits).

## 2. How the user talks to it

The docs use three tiers: bundled with the core install, official plugin installed with one
command, and external plugin maintained outside the repo
(https://docs.openclaw.ai/channels). All of these are documented and supported by the project;
only the external tier is not first-party code.

| Surface | Tier | Notes |
|---|---|---|
| Telegram | Bundled | Recommended first channel, needs only a bot token |
| WebChat and web control panel | Bundled | Served by the Gateway at port 18789 (https://docs.openclaw.ai/web/control-ui) |
| WhatsApp | Official plugin | QR pairing as a linked device, loaded on demand |
| Discord, Slack, Signal, iMessage, Google Chat, Microsoft Teams, Matrix, Mattermost, IRC, LINE, Nostr, QQ, Feishu, Zalo, Twitch, Nextcloud Talk, Synology Chat, Tlon, SMS via Twilio, Voice Call via Plivo, Telnyx or Twilio | Official plugins | iMessage runs through a native macOS bridge; Signal through signal-cli |
| WeChat, WeCom, Yuanbao, Zalo ClawBot | External plugins | Maintained outside the repo |
| macOS menu bar app | First-party | Quick Chat popup, voice input, notifications, widget panel, Mac-side commands; distributed as a DMG from GitHub releases (https://docs.openclaw.ai/platforms/macos) |
| iOS app | First-party | Chat, camera, screen snapshot, location, talk mode, voice wake, opt-in health summaries; "distributed through Apple channels when enabled for a release" (https://docs.openclaw.ai/platforms/ios) |
| Android app | First-party | On Google Play and as a signed APK; chat, voice, camera, calendar, contacts, SMS, notification forwarding; Wear OS companion (https://docs.openclaw.ai/platforms/android) |
| Apple Watch | First-party | Standalone voice over the talk feature (https://docs.openclaw.ai/nodes/talk) |
| Windows Hub | First-party | Desktop app; Linux companion apps are "planned" (https://docs.openclaw.ai/platforms) |
| Voice | First-party | Continuous talk mode on macOS, iOS, Android, browser; wake words; realtime voice via OpenAI or Google Live (https://docs.openclaw.ai/nodes/talk, https://docs.openclaw.ai/nodes/voicewake) |
| Email | Trigger only | Gmail push and a bundled IMAP trigger wake an agent on inbound mail; sending is via skills (https://docs.openclaw.ai/cli/webhooks, https://docs.openclaw.ai/start/why-openclaw) |

Every channel supports text; "media and reactions vary by channel". Group chats reply only
when mentioned by default (https://docs.openclaw.ai/channels).

## 3. Tools out of the box

From the tools reference (https://docs.openclaw.ai/tools):

- Shell and processes: run commands, manage processes, shared operator terminals, and
  provider-backed Python code execution.
- Files: read, write, edit, apply patch, inside the agent workspace, which is "the default
  cwd, not a hard sandbox" (https://docs.openclaw.ai/concepts/multi-agent).
- Web: web search through twelve providers (Brave, DuckDuckGo, Exa, Perplexity, SearXNG,
  Tavily and others), X post search, and fetch of readable page content
  (https://docs.openclaw.ai/concepts/features).
- Browser: a browser automation tool and a browser panel in the web control panel. The FAQ
  warns it is "not 'do anything a human can'"; captchas and MFA still block it
  (https://docs.openclaw.ai/help/faq).
- MCP: connects to any Model Context Protocol server, local or remote, from the control
  panel, the command line or config, including OAuth login; can also expose its own tools to
  other MCP clients (https://docs.openclaw.ai/tools/mcp).
- Skills: instruction packs in a SKILL.md file, loaded into the prompt (see section 7).
- Scheduling: an automations tool and a heartbeat reply tool (see section 5).
- Media: view images, generate images, music and video, and text to speech; voice note
  transcription (https://docs.openclaw.ai/tools, https://docs.openclaw.ai/concepts/features).
- Devices: camera snap and clip, screen record and snapshot, location, notifications, run a
  command on a paired Mac, and on Android read calendar, contacts, photos, SMS and call log
  (https://docs.openclaw.ai/nodes). "Local node tools are currently macOS-only" for the
  desktop side (https://docs.openclaw.ai/help/faq).
- Sub-agents: delegate work, wait on other agents, and a goal tracker; hand off to Claude
  Code, Codex or OpenCode through an opt-in coding-agent skill
  (https://docs.openclaw.ai/tools/skills).
- Messaging: send replies or channel actions across any connected chat.
- Workflows: an optional Lobster plugin runs "multi-step tool pipelines as one deterministic
  tool call" with approval checkpoints (https://docs.openclaw.ai/tools/lobster).

## 4. Memory

"Memory is just Markdown on disk in the agent workspace" and "The model only remembers what
gets saved to disk; there is no hidden state" (https://docs.openclaw.ai/concepts/memory).
The workspace files (https://docs.openclaw.ai/concepts/agent-workspace):

- AGENTS.md: operating instructions, loaded every session.
- SOUL.md: "Persona, tone, and boundaries", loaded every session.
- IDENTITY.md: the agent's name, vibe and emoji, set in a first-run ritual (BOOTSTRAP.md).
- USER.md: stable preferences about the person, loaded with its own 4,000-character budget.
- MEMORY.md: curated long-term facts and decisions, loaded only in the private main session.
- memory/YYYY-MM-DD.md: daily notes; today and yesterday load at session start, older ones
  are reachable only by search.

Search is a memory_search tool doing hybrid vector plus keyword search over those files.
OpenAI embeddings are the default; Gemini, Voyage, Mistral, Ollama, LM Studio, local GGUF and
others can be selected; backends are built-in SQLite, Honcho or LanceDB. Before a long
conversation is compressed, a silent turn "reminds the agent to save important context to
memory files". A background process called "dreaming" runs by default as a scheduled job and
promotes notes into MEMORY.md only when they pass score, recall-frequency and diversity
gates; MEMORY.md "is still only written by deep promotion". Memory from Codex, Claude Code and
Hermes can be imported (https://docs.openclaw.ai/concepts/memory). Each agent searches only its
own memory (https://docs.openclaw.ai/concepts/multi-agent).

## 5. Automation

- Scheduled jobs: a built-in scheduler inside the Gateway, persisted in SQLite. Schedules
  are one-shot, fixed interval, cron expression, when a watched command exits, or from a
  supervised command's output stream. A job can post a system event, run a model turn, run a
  host command, or run a headless script using the agent's tools. Jobs run in the main
  session, an isolated fresh session, or a named session, and can announce results to a chat
  or POST to a webhook. Created from the command line, by the agent itself, or with a
  /loop shortcut in chat; when you repeat a task the agent offers to schedule it
  (https://docs.openclaw.ai/automation/cron-jobs).
- Heartbeat: a periodic main-session turn every 30 minutes by default so the model "can
  surface anything that needs attention"; a fresh install stays quiet because "Proactive
  heartbeat behavior is opt-in", with active-hours windows
  (https://docs.openclaw.ai/gateway/heartbeat).
- Inbound webhooks: HTTP hooks, off by default, let "an external service wake an agent or
  submit an agent turn", with named mappings and fan-out; Gmail push notifications ride this
  path (https://docs.openclaw.ai/automation/cron-jobs, https://docs.openclaw.ai/cli/webhooks).
- Long tasks: isolated runs are bounded by "the scheduler's own 60-minute watchdog" unless a
  timeout is set; the final reply "must be the deliverable rather than a plan"; sub-agents can
  be orchestrated and their output delivered (https://docs.openclaw.ai/automation/cron-jobs).
- The scheduler "does not fire if the Gateway is not running continuously"
  (https://docs.openclaw.ai/help/faq).

## 6. Model support

"35+ model providers (Anthropic, OpenAI, Google, and more)"
(https://docs.openclaw.ai/concepts/features). The provider directory lists around sixty
entries including Anthropic, OpenAI, Google Gemini, xAI, Mistral, DeepSeek, Groq, Bedrock,
OpenRouter, GitHub Copilot, and local runners Ollama, llama.cpp, LM Studio, vLLM and SGLang
(https://docs.openclaw.ai/providers). Users bring their own key, or reuse a subscription:
"Subscription auth via OAuth (e.g. OpenAI Codex)", "Anthropic (API + Claude CLI)"
(https://docs.openclaw.ai/concepts/features, https://docs.openclaw.ai/providers). Setup
"begins with what's already on the user's machine", meaning existing ChatGPT or Claude
subscriptions, API keys and local models (https://openclaw.ai/blog/openclaw-2-accidentally).
The docs advise "use the strongest latest-generation model available" and warn that smaller
models "are more susceptible to instruction hijacking" (https://docs.openclaw.ai,
https://docs.openclaw.ai/help/faq). Codex OAuth "does not grant embeddings access", so memory
search still needs a real key (https://docs.openclaw.ai/help/faq).

## 7. Self-improvement and skills

A skill is a folder with a SKILL.md file following the AgentSkills spec; skills are found in
the workspace, the home folder, a managed library, bundled ones, and plugins
(https://docs.openclaw.ai/tools/skills). The agent can draft its own: through the Skill
Workshop "it drafts a proposal instead of writing directly to SKILL.md"; the person reviews
in a board or a one-at-a-time view with Use it, Tweak it, Skip
(https://openclaw.ai/blog/openclaw-agent-skill-workshop). The blog frames this as "A useful
agent should learn the work you keep giving it." The showcase includes users who "had OpenClaw
generate the skill directly in Telegram chat" (https://docs.openclaw.ai/start/showcase).

ClawHub "is the public registry for OpenClaw skills and plugins", with versions, downloads,
stars and automated security scans; anyone with an old-enough GitHub account can publish
(https://docs.openclaw.ai/clawhub, https://clawhub.ai). Skills are installed with
`openclaw skills install @owner/slug`; the docs say "Treat third-party skills as untrusted
code" (https://docs.openclaw.ai/tools/skills). Skill count: not published; the registry API pages through items without a total field.

## 8. Personal-life features

It is a general agent with tools and skills, not a personal-life product. Nothing first-party
manages a calendar, task list, notes, health record, news feed or smart home. What exists:

- Email: Gmail push and an IMAP trigger wake an agent on new mail; the docs suggest a
  restricted "mail reader" agent for it (https://docs.openclaw.ai/cli/webhooks).
- Phone data: the Android app exposes calendar, contacts, photos, SMS and call log as device
  commands; iOS offers opt-in health summaries (https://docs.openclaw.ai/nodes,
  https://docs.openclaw.ai/platforms/ios).
- Everything else is community-built and listed on the showcase page: a CalDAV calendar
  skill, a Home Assistant add-on and skill, Todoist, Obsidian, Oura ring health, a morning
  briefing image, robot vacuum and air purifier control
  (https://docs.openclaw.ai/start/showcase). Notion "Not built in today"
  (https://docs.openclaw.ai/help/faq).

## 9. Users and personas

Designed for "a single operator, or a team whose members trust each other"
(https://github.com/openclaw/openclaw). Multiple agents (personas) run in one Gateway, each
with its own workspace, SOUL.md, model settings and session store, and chat accounts or
individual senders are bound to agents; "true isolation requires one agent per person"
(https://docs.openclaw.ai/concepts/multi-agent). Team mode adds sign-in identities, named
operator roles, shared sessions with an owner and presence, and personal skills, but "A
gateway is one trust domain" and untrusted users need separate gateways
(https://docs.openclaw.ai/start/teams). The web control panel is a single-page app with chat,
sessions, panels and settings, gated by a shared token or password plus device pairing, with
no user accounts of its own (https://docs.openclaw.ai/web/control-ui).

## 10. Positioning, in their words

- Repository tagline: "The AI that really does things. Any OS. Any Platform. The lobster way."
  (https://github.com/openclaw/openclaw)
- "Your assistant. Your machine. Your rules." and "Unlike SaaS assistants where your data
  lives on someone else's servers, OpenClaw runs where you choose"
  (https://openclaw.ai/blog/introducing-openclaw)
- Foundation mission: "bring the power of personal AI to the people by stewarding OpenClaw as
  open and independent"; "Our ambition is for OpenClaw to be the Switzerland of AI"
  (https://openclaw.ai/blog/introducing-openclaw-foundation)
- Why page: "an extensible, proactive, open-source AI agent that works everywhere you work";
  "A feature table does not establish the security model"; "trusted gateway, untrusted
  execution, deterministic policy"; "no lab's model is privileged"
  (https://docs.openclaw.ai/start/why-openclaw)
- 2.0 post: "We are not selling anything here or asking you to trust one company, one model,
  or one AI provider"; a Claw can start with one workflow like flagging school emails to
  Telegram and grow across "your life and work"
  (https://openclaw.ai/blog/openclaw-2-accidentally)

## 11. Stated limitations

From the FAQ (https://docs.openclaw.ai/help/faq) and the why page
(https://docs.openclaw.ai/start/why-openclaw):

- "not an IDE replacement"; "not 'just a Claude wrapper'".
- "Sandboxing and exec approvals are off by default"; default is "a trusted single-operator
  assistant". Security in one line: the Gateway is trusted, tools run on the host unless
  you configure a sandbox, and "prompt injection is still an industry-wide unsolved problem"
  (https://openclaw.ai/blog/introducing-openclaw).
- "We do not recommend full autonomy over your personal messages."
- Data is not fully local: "external services still see what you send them."
- Desktop device tools are macOS only; Linux companion apps are planned; nodes never host the
  Gateway; "there is no built-in bot-to-bot bridge" between two installs.
- Sessions never auto-reset; context is limited by the model window.
- Cost: "Long tasks and sub-agents both consume tokens"; a team of many agents "is token-heavy".
- Memory: "Promoted memories have no time-based retention bound"; forgetting is not "a general
  erasure guarantee". Cross-channel sending is blocked by default; one Gateway per host.

## 12. Popularity signals

| Signal | Value | Source |
|---|---|---|
| GitHub stars | 389,058 | https://api.github.com/repos/openclaw/openclaw (2026-09-06) |
| Forks | 81,754 | same |
| Open issues | 6,230 | same |
| Repository created | 2025-11-24 | same |
| Latest release | v2026.9.2 on 2026-09-05 | https://api.github.com/repos/openclaw/openclaw/releases |
| Releases per month 2026 | Feb 16, Mar 22, Apr 47, May 66, Jun 27, Jul 9, Aug 10, Sep 3 so far | same, pages 1 and 2 |
| Release volume | 2026.9.2 covers "1,247 in-range PRs" in two days | same |
| Contributors on 2.0 | "933 contributors, including 569 first-time contributors" | https://openclaw.ai/blog/openclaw-2-accidentally |
| Foundation claims | "4.5 million new claws weekly", "fastest growing repository in GitHub history" | https://openclaw.ai/blog/introducing-openclaw-foundation |
| ClawHub skills | not published (API paginates without a total) | https://clawhub.ai/api/v1/skills |

Releases are automated and date-tagged. The pace slowed from May to a nearly seven-week gap
before 2.0 on 30 August 2026, and an "extended-stable" channel was added in July on the road
to long-term support (https://openclaw.ai/blog/extended-stable-releases-and-maturity-scorecards).
