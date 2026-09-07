# Personal AI assistants: a survey of the wider field

Date: 2026-09-06. Written for the Moss competitive analysis. Hermes Agent and OpenClaw are
covered in separate documents and are left out here.

Each entry answers the same questions: who it is for, how you talk to it, what it can act on,
how memory works, whether it runs on its own schedule, which models it uses, why its makers say
you should pick it, and one thing it does not do. Every claim carries the page it came from.
Where a vendor's help page blocked automated reading, the entry says so and cites the page anyway.

## Part 1: open-source and self-hosted

### Khoj

- Who it is for: people who want a "second brain" that answers from their own notes and documents. Positioned as open source and "self-hostable. Always." (https://github.com/khoj-ai/khoj)
- How you talk to it: browser, desktop app, phone, Obsidian plugin, Emacs, and WhatsApp. (https://github.com/khoj-ai/khoj, https://docs.khoj.dev/)
- What it acts on: your files (PDF, Markdown, Word, org-mode, images), Notion pages, and the public web. It does research and image generation rather than acting in other apps. (https://github.com/khoj-ai/khoj, https://docs.khoj.dev/)
- Memory: retrieval over the documents you share with it; no self-edited memory file is described. Custom "agents" carry their own knowledge base, persona, model and tools. (https://docs.khoj.dev/, https://github.com/khoj-ai/khoj)
- Schedule: yes. "Automations" run a saved query on a cron schedule in your time zone and email you the result; self-hosters must set up an email sender first. (https://docs.khoj.dev/features/automations)
- Models: local (llama.cpp, Ollama: llama3, qwen, gemma, mistral, deepseek) or cloud (GPT, Claude, Gemini). (https://github.com/khoj-ai/khoj)
- Reason to choose: private answers from your own documents, on your own hardware, with a hosted option when you want it. (https://docs.khoj.dev/)
- Does not do: act inside your email, calendar or other apps. The same team's newer "Pipali" desktop co-worker (beta, Apache-2.0, about 280 stars) adds file and browser actions, scheduled tasks and MCP tools, but routes models through their own paid platform. (https://github.com/khoj-ai/pipali)
- Traction: about 37k stars, AGPL-3.0. (https://github.com/khoj-ai/khoj)

### Open Interpreter and 01

- Status change: Open Interpreter is no longer a personal assistant. The repository now describes itself as "a coding agent optimized for low-cost models", a Rust fork of OpenAI's Codex aimed at open models. The original Python assistant lives on only as a community fork. (https://github.com/OpenInterpreter/open-interpreter)
- How you talk to it: a terminal program, an editor integration, or the Codex SDK. (https://github.com/OpenInterpreter/open-interpreter)
- What it acts on: runs commands in a native sandbox on macOS, Linux and Windows; a built-in skill drives web apps and native apps. Supports MCP tools, skills and hooks. (https://github.com/OpenInterpreter/open-interpreter)
- Models: any OpenAI-compatible endpoint, switched with a slash command. (https://github.com/OpenInterpreter/open-interpreter)
- Memory and schedule: none described on the README.
- 01, the voice device project: still public, "under rapid development and lacks basic safeguards", no releases listed, advises running only on machines without sensitive data. Server plus phone, desktop or ESP32 clients; can use OpenAI's realtime voice API. (https://github.com/OpenInterpreter/01)
- Reason to choose: cheap open models with a serious agent harness. (https://github.com/OpenInterpreter/open-interpreter)
- Does not do: anything a non-programmer would recognise as a daily assistant.
- Traction: about 68k stars on the main repo, Apache-2.0; 01 about 5k stars, AGPL-3.0. (same URLs)

### Letta (formerly MemGPT), via Letta Code

- Who it is for: developers and power users who want an agent that "learn[s] from experience and improve[s] with use"; the docs list personal assistants and AI co-workers as intended uses. (https://docs.letta.com/)
- How you talk to it: terminal, desktop app for macOS, Windows and Linux, a browser and mobile chat at chat.letta.com, and channels for Telegram, Slack and Discord. The docs also list WhatsApp and Signal channels. (https://github.com/letta-ai/letta-code, https://docs.letta.com/)
- What it acts on: local files and shell, skills (its own plus the ClawHub and Hermes skill hubs), subagents, hooks and permission modes. (https://github.com/letta-ai/letta-code)
- Memory: the headline feature. A git-tracked memory folder the agent edits itself, with a "remember this" command, an audit command for drift and bloat, and "dreaming": background subagents that review recent conversations and update memory after a set number of steps or when the context is compacted. Memory can sync to your own GitHub repository. (https://docs.letta.com/configuration/memory, https://github.com/letta-ai/letta-code)
- Schedule: yes. "Configure heartbeats and crons, and let agents work across time with self-managed schedules." (https://github.com/letta-ai/letta-code)
- Models: bring your own keys for OpenAI, Anthropic and others; switch with a slash command. (https://github.com/letta-ai/letta-code)
- Hosting: the harness runs anywhere, but agent state lives in Letta Cloud by default and remote computers require a Letta sign-in. A self-hosted app server exists; the old Docker server is deprecated and unsupported. (https://github.com/letta-ai/letta-code, https://github.com/letta-ai/letta, https://docs.letta.com/)
- Reason to choose: agents "more like people than tools" with memory, identity and experience over time. (https://github.com/letta-ai/letta-code)
- Does not do: ship any built-in personal modules (calendar, email, news). It is a harness, not a product.
- Traction: main repo about 25k stars; letta-code about 3k; Apache-2.0. (https://github.com/letta-ai/letta, https://github.com/letta-ai/letta-code)

### Home Assistant Assist with a language-model conversation agent

- Who it is for: Home Assistant households that want voice control of the house that "can run fully on your own hardware, so your voice commands stay private." (https://www.home-assistant.io/voice_control/)
- How you talk to it: the dashboard, the Android and Apple companion apps (hands-free wake word on Android), the Voice Preview Edition speaker, DIY ESP32 satellites, and a Linux satellite program. (https://www.home-assistant.io/voice_control/)
- What it acts on: only devices and scripts you have explicitly exposed to Assist; the setting exists so locks and garage doors are not controlled by accident. (https://www.home-assistant.io/voice_control/voice_remote_expose_devices/)
- Language models: "Home Assistant supports most of them." OpenAI, Anthropic and local Ollama are named; Google is listed as a conversation integration. Each agent has a "No control" or "Assist" (can control devices) setting. (https://www.home-assistant.io/voice_control/assist_create_open_ai_personality/)
- Local first: a "prefer local handling" switch lets the built-in intent matcher answer first and hand the rest to the model. (https://www.home-assistant.io/voice_control/assist_create_open_ai_personality/)
- Memory: none described; each request stands alone.
- Schedule: not a feature of Assist itself; Home Assistant automations do scheduling separately.
- Reason to choose: privacy, an open voice stack, and the widest device support. (https://www.home-assistant.io/voice_control/)
- Does not do: email, notes, tasks, briefings, or anything outside the house.

### Leon

- Who it is for: people who want "your open-source personal AI assistant" running on their own machine. (https://github.com/leon-ai/leon)
- Status: mid-rebuild. A notice dated 2026-03-29 says work is on the 2.0 Developer Preview on the develop branch; the stable branch is the old "pre-agentic" version, docs lag the code, and development happens "largely during spare time." (https://github.com/leon-ai/leon)
- How you talk to it: a local web app on port 5366, with voice features; a "Satellite" runs computer use remotely. (https://github.com/leon-ai/leon)
- What it acts on: native skills (search, productivity, system, media, coding help, voice) and agent skills defined by SKILL.md files; computer use over desktop and browser. (https://github.com/leon-ai/leon)
- Memory: layered (durable preferences, day-to-day context, recent conversation) plus a "bounded proactive pulse system." (https://github.com/leon-ai/leon)
- Models: "supports both local and remote AI providers"; none named. (https://github.com/leon-ai/leon)
- Reason to choose: privacy and completing tasks end to end on your own machine. (https://github.com/leon-ai/leon)
- Does not do: offer a finished, documented product today.
- Traction: about 17k stars, MIT. (https://github.com/leon-ai/leon)

### OpenVoiceOS

- Who it is for: hobbyists building a private voice speaker; a community continuation of Mycroft. (https://www.openvoiceos.org/)
- How you talk to it: voice on Raspberry Pi, Mycroft Mark I and II, Linux desktops, and Docker. (https://www.openvoiceos.org/)
- What it acts on: skills for smart home, music and radio, timers and reminders, Q&A, from a marketplace or self-written. (https://www.openvoiceos.org/)
- Language models: the home page does not mention them at all; the pitch is offline speech-to-text and text-to-speech options. (https://www.openvoiceos.org/)
- Status: alive. An NGI Zero grant was announced October 2025 and a live status page is maintained. (https://www.openvoiceos.org/)
- Does not do: act as a general assistant over your data or apps.

### Goose (the prominent newcomer)

- Who it is for: anyone wanting "a general-purpose AI agent that runs on your machine" for research, writing, automation and data analysis, not only coding. Now governed by the Linux Foundation's Agentic AI Foundation. (https://github.com/block/goose)
- How you talk to it: desktop app for macOS, Linux and Windows, a terminal program, or an API. (https://github.com/block/goose)
- What it acts on: "70+ extensions" through MCP. (https://github.com/block/goose)
- Models: "15+ providers" including Anthropic, OpenAI, Google, Ollama, OpenRouter, Azure and Bedrock, or an existing Claude, ChatGPT or Gemini subscription. (https://github.com/block/goose)
- Memory and schedule: not described on the README; the tree hints at workflow "recipes."
- Reason to choose: neutral, foundation-governed, plugs into any model and any MCP tool. (https://github.com/block/goose)
- Does not do: talk to you from your phone or run on its own.
- Traction: about 54k stars, Apache-2.0. (https://github.com/block/goose)

### Claude Code used as a daily assistant (the 2026 pattern)

- What happened: the coding tool grew the pieces a daily assistant needs. "Channels" push Telegram, Discord or iMessage messages into a running session and reply back through the same chat; it is a research preview, works on Pro and Max without admin setup, and only receives while a session is open, so people keep one running in the background. (https://code.claude.com/docs/en/channels)
- Schedules: three tiers. Cloud routines run on Anthropic's machines with no local files and a one-hour minimum; desktop tasks run on your machine with local files at a one-minute minimum; the in-session loop dies with the session. (https://code.claude.com/docs/en/desktop-scheduled-tasks)
- Projects built on top have little traction so far: one "persistent personal assistant" starter has 4 stars (https://github.com/claude-world/claude-agent); a Telegram-to-Obsidian second brain that files voice notes and writes a nightly report has about 365 stars, and runs one long-lived interactive session to stay on a flat subscription (https://github.com/smixs/agent-second-brain).
- Why it matters: the vendor now ships the messaging bridge and the scheduler natively, so "assistant on Claude Code" needs only a memory folder and a few skills.
- Does not do: give you a product. Every user assembles their own.

## Part 2: hosted and commercial

### ChatGPT

- Who it is for: everyone; the consumer default.
- How you talk to it: web, desktop, mobile, voice, and the Atlas browser.
- Agent mode: retired. The help page now reads "ChatGPT agent is no longer available. Use ChatGPT Work for longer, multi-step tasks" and points browser jobs at a cloud browser. (https://help.openai.com/en/articles/11752874-chatgpt-agent)
- What it acts on: apps (formerly "connectors") for Gmail, Google Calendar, Drive, Outlook, Slack, GitHub, Notion, Linear, Dropbox, Box and more, with write actions added in 2026 so it can draft email and create events; each write asks for confirmation. Off by default for Enterprise and Edu. (https://help.openai.com/en/articles/11391654-chatgpt-business-release-notes)
- Memory: as of June 2026 a single memory summary that a background process rewrites automatically; the old list of saved memories is the "legacy" option. A book icon shows which sources personalised an answer. Off by default on Enterprise. (https://help.openai.com/en/articles/8590148-memory-faq)
- Schedule: yes. Active task limits are 3 on Free and Go, 5 on Plus, 10 on Business, 15 on Pro; no more than hourly; push or email notification; a "Scheduled" page in the sidebar; event-triggered tasks on Gmail, Slack or GitHub activity for paid plans. Not available in the desktop app. (https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt)
- Proactive: Pulse, the overnight daily briefing, was sunset in 2026 and folded into scheduled tasks. (https://help.openai.com/en/articles/6825453-chatgpt-release-notes-2026-05-17-OpenAI, https://openai.com/index/introducing-chatgpt-pulse/)
- Models: OpenAI's only.
- Reason to choose: the most integrations and the largest user base.
- Does not do: run on your hardware, use your model, or let you read the memory file it keeps.
- Note: OpenAI's help pages refuse automated readers; the URLs above were confirmed through search excerpts of those pages.

### Claude

- Who it is for: consumers and knowledge workers; Cowork targets "complex, multi-step tasks without using a terminal." (https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork)
- How you talk to it: web, desktop (macOS, Windows, Linux beta), mobile, a Chrome side panel, and from the phone through Dispatch, which sends a task to your desktop and reports back with a push notification (limited beta, Pro and Max, one persistent thread). (https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile, https://support.claude.com/en/articles/13947068-assign-tasks-from-anywhere-in-claude-cowork)
- What it acts on: local folders with explicit permission, connectors, plugins that bundle skills and connectors, and a browser. Claude in Chrome reads, clicks, types and fills forms, pauses at logins and CAPTCHAs, and asks per site; paid plans only. (https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome, https://support.claude.com/en/articles/12902428-use-claude-in-chrome-safely)
- Memory: saved as individual topics as you chat, with a "remember this" instruction, a separate memory per project, incognito chats, and pause or reset controls. On by default for Free, Pro and Max; local Cowork sessions do not use it. (https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)
- Schedule: yes, in Cowork for all paid plans. Tasks run in the cloud "even when your computer is asleep", use your connectors and plugins, and appear under "Scheduled" in the sidebar; anything needing local files runs only locally. (https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork)
- Models: Anthropic's only.
- Reason to choose: one assistant that spans chat, desktop files, browser and phone, with memory you can inspect and pause.
- Does not do: run on your hardware or use another vendor's model.

### Gemini

- Who it is for: Google account holders, especially Workspace users.
- How you talk to it: web and mobile apps, Chrome, watch, and inside Gmail, Docs and Calendar.
- What it acts on: Gmail, Calendar, Drive, Docs, Keep and Tasks once the Workspace app is connected; you name the app in the prompt. Also Google Home, YouTube Music and a few third parties. Admins can switch each service off. (https://support.google.com/gemini/answer/15229592, https://support.google.com/gemini/answer/15305236)
- Memory: "personal context" learns from past chats; personal accounts only, 18 or over, needs activity history on, and does not apply inside Gems or Live. A 2026 import feature accepts memory and chat history from other assistants. Temporary chats are kept 72 hours and not used. (https://support.google.com/gemini/answer/16598469)
- Custom assistants: Gems are saved instructions plus up to a handful of files; created on the web, usable on mobile. (https://support.google.com/gemini/answer/15236321)
- Schedule: yes. Up to 10 active scheduled actions, daily, weekly or monthly; content is prepared ahead so "rapidly changing data, like stock prices, won't be the latest"; mobile push or unread chat on web; paused after inactivity. (https://support.google.com/gemini/answer/16316416)
- Models: Google's only.
- Reason to choose: it already lives where your mail and calendar are.
- Does not do: browser control or a memory you can read as a file.

### Perplexity Computer

- Who it is for: Pro and Max subscribers who want "a general-purpose digital worker" rather than a chat answer. Launched 2026-02-25. (https://www.perplexity.ai/hub/blog/introducing-perplexity-computer)
- How you talk to it: desktop, mobile, Slack and Microsoft 365. A "Personal Computer" variant runs around the clock on a Mac mini, and "Portable Computer" (2026-08-25) runs entirely on a local NVIDIA machine. (https://www.perplexity.ai/products/computer, https://www.perplexity.ai/hub/blog/introducing-portable-computer-for-local-first-ai)
- What it acts on: an isolated environment with a real file system and browser, plus connectors for Gmail, Google Calendar, Slack, Notion, Linear, GitHub, Outlook, Teams, Jira, Drive, Dropbox and more; it spawns subagents and "check[s] in if it truly needs you." (https://www.perplexity.ai/help-center/en/articles/13837784-what-is-computer)
- Memory: "Brain" builds a private context graph across sessions, connectors and files, refreshed overnight; every memory links to its source and you control what it keeps. (https://www.perplexity.ai/products/computer)
- Schedule: yes. You describe the job in plain language and it proposes a schedule; condition-based triggers watch email, calendar, flights and files; stuck jobs show "Needs attention." (https://www.perplexity.ai/help-center/en/articles/11521526-perplexity-tasks)
- Models: "an orchestration harness of 20 frontier models"; you do not pick. (https://www.perplexity.ai/hub/blog/introducing-perplexity-computer)
- Reason to choose: long-running work, credit-metered, with the vendor doing the model juggling.
- Does not do: let you bring your own model, and pages blocked automated reading, so the above rests on search excerpts of those pages.

### Manus

- Who it is for: individuals and teams who want "an autonomous general AI agent designed to complete tasks and deliver results." (https://manus.im/docs)
- How you talk to it: web, mobile, desktop, a browser operator, Slack, and an API. (https://manus.im/)
- What it acts on: a virtual computer with internet, persistent files and the ability to install software; connectors for Gmail, Google Calendar, GitHub, Linear, Notion, Postgres and more; a desktop "My Computer" mode reaches local files. (https://manus.im/docs, https://help.manus.im/en/articles/12231777-how-can-i-use-manus-connectors)
- Memory: projects hold persistent context, files, skills and instructions that scheduled runs reuse. (https://manus.im/blog/projects-connectors, https://manus.im/blog/manus-schedules)
- Schedule: yes. Described in plain language with the delivery method in the prompt; results go to email, Slack, Drive, a spreadsheet or a connector; trusted workflows can skip confirmations; limits "depend on your plan." (https://manus.im/docs/features/scheduled-tasks, https://manus.im/blog/manus-schedules)
- Models: Manus's own 1.6 family (Lite, standard, Max); the free tier gets only Lite. (https://manus.im/blog/manus-schedules)
- Reason to choose: finished deliverables (slides, sites, designs) from one prompt.
- Does not do: run on your machine or use your model.

### Lindy

- Who it is for: companies; "the AI teammate that will 3x your output", organised by department. (https://www.lindy.ai/)
- How you talk to it: Slack first (private DM per person plus shared channels), iMessage, Gmail, a Chrome extension, and as a participant in Meet, Zoom and Teams. (https://www.lindy.ai/)
- What it acts on: "Gmail, Slack, Notion, HubSpot, and 1,000+ more. Supports MCP", plus computer use and self-built integrations; "nothing irreversible happens without your approval." (https://www.lindy.ai/)
- Memory: "it all lives in plain files" you can open and edit like a document. (https://www.lindy.ai/)
- Schedule: yes. Routines in plain language: a daily 8 AM brief, a Friday report, notes after every call. (https://www.lindy.ai/)
- Models: not stated. Pricing is per user per month from about $30 to $200 on credits. (https://www.lindy.ai/)
- Reason to choose: "Most of them stop at a draft. Lindy finishes the job." (https://www.lindy.ai/)
- Does not do: aim at a private individual; it is sold to teams.

### Limitless (and Rewind)

- Status: acquired by Meta. Pendant sales ended 2025-12-05, existing owners are supported through 2026 on a free plan, Rewind's screen and audio capture was disabled 2025-12-19, desktop and web recording ended, and the service left the EU, UK and several other regions. (https://www.limitless.ai/)
- What it was: a clip-on pendant that recorded conversations, transcribed and summarised them, and let you ask questions across months of meetings in a phone app. (https://www.limitless.ai/, third-party reviews only for feature detail)
- Memory: everything you heard, searchable; the defining idea of the category.
- Schedule and actions: none; it recalled, it did not act.
- Reason it mattered: proof that "remember my day" is a product people paid for, now absorbed into a wearables giant.
- Does not do: exist as a purchasable product today.

## Patterns across the field

Common, appearing in most entries:

- Chat from the phone through an app you already use. Telegram, Discord, Slack, WhatsApp or iMessage bridges appear in Letta, Khoj, Lindy, Manus and Claude Code; the big three consumer apps rely on their own mobile apps instead.
- Scheduled runs are table stakes. ChatGPT, Claude, Gemini, Perplexity, Manus, Lindy, Khoj and Letta all offer them. The differentiators are whether a run can reach local files, the minimum interval, and whether the vendor caps the count (Gemini 10, ChatGPT 3 to 15 by plan).
- A daily briefing is the canonical scheduled job. Nearly every vendor uses "morning brief" as the example; ChatGPT built a dedicated product for it and then merged it back into schedules.
- Memory the agent writes itself. ChatGPT's rewritten summary, Claude's topics, Perplexity's overnight graph and Letta's git-tracked folder all update without being asked. The split is whether you can read and edit it as plain files (Letta, Lindy, the Obsidian projects) or only through a settings screen (ChatGPT, Claude, Gemini).
- Background consolidation with a sleep metaphor. Letta "dreams", ChatGPT's memory is rewritten by "dreaming", Perplexity refreshes "overnight."
- Connectors to mail, calendar, files and chat tools. Gmail, Google Calendar, Slack, Notion, Drive and GitHub are the near-universal set; MCP is the plumbing under most of them.
- Skills as the unit of extension, often with a shared hub. Letta reads the ClawHub and Hermes hubs, Manus and Lindy have skill libraries, Leon and Pipali use SKILL.md files.
- Bring-your-own model on the open side, no choice on the hosted side. Goose, Khoj, Letta, Home Assistant and Leon take any provider; ChatGPT, Claude, Gemini, Manus and Perplexity lock you in.
- Confirmation before irreversible actions. ChatGPT write actions, Claude's per-site prompt, Lindy's named approver, Manus's optional skip, Home Assistant's explicit expose list.

Rare, appearing in one or two:

- A memory you can version and sync to your own git repository (Letta only).
- Condition-based triggers rather than clocks: "when this email arrives" (Perplexity, ChatGPT event tasks, Claude Code channels as webhooks).
- Phone-to-desktop dispatch, where the phone sends a job to your own machine and its files (Claude Dispatch, the agent-second-brain project).
- Voice as the primary surface (Home Assistant, OpenVoiceOS, 01); the general assistants treat voice as an add-on.
- Always-on capture of the physical world (Limitless, now gone).
- Local-first operation with a hosted model in the loop, where the assistant runs on your hardware but the vendor still owns the model or the state (Perplexity Personal Computer, Letta Cloud, Pipali).
- Built-in personal modules such as calendar, notes, news, sports and wellness, shipped as part of the product rather than assembled from connectors. None of the open-source entries does this; the hosted ones do it through connectors to Google or Microsoft rather than owning the data.
