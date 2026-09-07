# Why would someone pick Moss? A competitive look at personal AI agents

Date: 2026-09-06. Grounded on Moss `main` as of today and on three research notes written the
same day from primary sources (official docs, repositories, product pages):

- [Hermes Agent](2026-09-06-competitor-hermes-agent.md)
- [OpenClaw](2026-09-06-competitor-openclaw.md)
- [The wider field](2026-09-06-competitor-field-survey.md): Khoj, Letta, Goose, Leon, Home
  Assistant, Claude Code as a daily assistant, ChatGPT, Claude, Gemini, Perplexity Computer,
  Manus, Lindy, Limitless

Scope: functionality only. Security, sandboxing and privacy guarantees are left out on purpose
for this round. The July gap analysis
([2026-07-feature-gap-analysis.md](2026-07-feature-gap-analysis.md)) covered developer
enablement; this one asks a different question: why a person would choose one of these over
Moss for their own life, and what that tells us to build.

## The short answer

Hermes and OpenClaw are **an agent you can message from anywhere that can do almost anything
on a computer**. Moss is **a place where your life lives, with an assistant inside it**.

Today a technical individual picks OpenClaw or Hermes because reach and doing beat viewing and
organizing. Five minutes after install they are texting it from Telegram, it runs a shell and a
browser, it schedules its own jobs, it writes its own skills, and it remembers in files they can
open. Moss cannot be reached from a phone chat app, cannot be told "do this every morning",
cannot act outside its own modules except through a connected MCP or OpenAPI service, and has
no voice.

Someone picks Moss when they want the thing neither of those is: a finished product with
screens for tasks, notes, mail, calendar, news, sports, wellness, food and money, a Today page,
briefings and monitoring that run without being asked, structured data with reminders and
trends, real accounts for a household, and an assistant that can build a whole new screen for
them from a chat request. Nothing else surveyed, open or hosted, ships that; the hosted ones
borrow it from Google or Microsoft through connectors, and the open ones leave it to skills.

So the honest position is: Moss is ahead on the product and behind on the agent. The
capabilities below close the agent gap without giving up the product.

## What each side is

| | Hermes Agent | OpenClaw | Moss |
|---|---|---|---|
| Shape | One Python process, one person | One long-running gateway, one trust domain | Web app plus database, many accounts |
| Talk to it from | Terminal, desktop app, web dashboard, about 25 chat platforms, voice, editors | Web panel, about 25 chat platforms, macOS/iOS/Android/Watch apps, voice, phone calls | The web app only (installable on a phone as a web app, no push) |
| Acts through | Shell, files, browser, code, web search, MCP, Home Assistant, Spotify, skills | Shell, files, browser, code, web search, MCP, phone camera/screen/location, skills | Its own module tools (about 100), plus connected MCP and OpenAPI services; no shell, no browser |
| Remembers in | Two small text files it edits, full-text search of past chats, plug-in memory services | Markdown files in a folder (persona, user, curated facts, daily notes) with vector search and overnight promotion | A structured memory graph distilled from chat, viewable in Settings; optional daily archive of chats to Notes |
| Runs on its own | Cron jobs made in chat, heartbeat, loops, goals, webhooks, weekly skill pruning | Cron jobs made in chat, 30-minute heartbeat, watched commands, webhooks, overnight memory pass | Fixed module schedules: briefings, monitoring scans, syncs, medication reminders |
| Extends itself | Writes skills from experience, learns from a folder or web page, skills hub, plugins | Drafts skills for your review, ClawHub registry, plugins | Workshop builds a whole module with screens and tools from a chat request; prompt-only skills; module install |
| Models | About 50 providers, local models managed in the desktop app, own subscription | About 60 providers, local runners, Claude and Codex subscription logins | Claude, Codex, Gemini subscription logins for chat; any API or Ollama/OpenAI-compatible endpoint for background work |
| Personal-life features | None built in; skills drive Google, Apple, Obsidian, Notion; a briefing tutorial | None built in; community skills for CalDAV, Todoist, Obsidian, Oura, Home Assistant | Built in: Today, Tasks, Notes, Calendar, Email, Briefings, Monitoring, Commitments, Goals, People, News, Sports, Weather, Wellness, Food, Finance, Job Search |
| People | One person per profile; family means separate services | One operator or a trusting team; one agent per person for isolation | Real accounts, an admin, access policy, per-user data |
| Traction | 242k stars, releases several times a month | 389k stars, foundation-backed, weekly releases | Alpha |

## Why people choose Hermes or OpenClaw over Moss

Ranked by how often the primary sources lead with it.

1. **It is in their pocket in five minutes.** Both make Telegram the recommended first step,
   and both reach WhatsApp, Signal, Discord, Slack and iMessage. OpenClaw's tagline is "meets
   you in the channels you already use"; Hermes says "One agent, one memory, every surface."
   Moss requires opening a web page. The July field survey found this in nearly every product,
   open or hosted.
2. **It actually does things.** OpenClaw calls itself "The AI that really does things." Shell,
   files, browser control, code execution, and any MCP server are there on day one. Moss's
   assistant can only act through Moss's own module tools and whatever services you connect. If
   the task is "convert these files", "fill in this web form", "check this site every day", Moss
   has no way to do it.
3. **"Do this every morning" works from chat.** Both have a scheduler the agent itself can
   use: one-shot or recurring, in plain language, delivered back to the chat you asked from.
   OpenClaw offers to schedule a task when it sees you repeat it. Both also have a heartbeat: a
   periodic turn where the model looks around and surfaces anything that needs attention. Moss's
   schedules are fixed by the module authors; a user cannot add one.
4. **It learns the job.** Hermes's whole pitch is "the only agent with a built-in learning
   loop": it saves a working procedure as a skill, updates it, and prunes it weekly. OpenClaw
   drafts a skill and asks you to approve it. Both read a shared open skill format with
   thousands of community skills. Moss's skills are instruction files the user writes by hand.
5. **Memory you can open.** Both keep memory as text files in a folder. OpenClaw: "there is no
   hidden state." Hermes: two small files pasted into every session. Letta goes further and
   syncs memory to your own git repository. Moss's memory graph is inspectable in Settings but
   is not a file you can read top to bottom or edit in your editor.
6. **Any model, including a local one.** Fifty to sixty providers each, plus subscription
   logins. Moss is close here (three subscription logins for chat, any endpoint for background
   work), so this is a smaller gap than it looks.
7. **Voice.** Hermes has push-to-talk, a wake word, and spoken replies on Telegram and Discord.
   OpenClaw has continuous talk mode on every app and real-time voice through OpenAI or Google.
   Moss has none.
8. **Momentum.** 389k and 242k stars, releases every week, a foundation behind OpenClaw, and
   an ecosystem of skills and plugins. People choose the thing their friends run.

Two smaller ones: both install with one command on a laptop, a $5 server or a Raspberry Pi,
where Moss needs Docker and Postgres; and both control Home Assistant out of the box.

## Why people would choose Moss

1. **It is a product, not a kit.** Everything the others leave to skills and third-party
   services, Moss ships as screens: tasks with lists and due dates, notes with search, mail and
   calendar in view, news and sports curated to you, medications on any schedule with the next
   three doses shown, mood trends over 28 days, meals with calories. The field survey's last
   pattern says it plainly: built-in personal modules are rare, and "none of the open-source
   entries does this."
2. **You look at your life, not just chat about it.** The Today page, the News front page, the
   Sports page and the Wellness charts are things the other two cannot show at all. Hermes says
   outright: "There is no built-in task list, calendar view, or dashboard of your life."
3. **It is proactive without being asked.** Morning and evening briefings, monitoring cards,
   commitments pulled out of your email and offered for accept or snooze, medication reminders.
   Hermes's daily briefing is a tutorial you assemble; Moss's is a module you turn on.
4. **Structured data with rules.** A medication in Moss is a schedule the app understands and
   can remind you about; in the others it is a line in a markdown file the model may or may not
   notice. Tasks, goals, people and commitments are the same: rows with meaning, not prose.
5. **It builds whole features, not just instructions.** Workshop takes "I want a page that
   tracks my plants" and comes back with a plan, then builds a module with its own screen and
   tools and tells you when it is done. The others can write a skill; neither can add a screen.
6. **A household, not a single operator.** Real accounts, an admin, per-person data, an access
   policy. Hermes needs a separate service per family member; OpenClaw says "true isolation
   requires one agent per person."
7. **Approval where it matters.** Actions show as cards with a plain result label (Executed,
   Allowed, Failed, Denied); workflow steps pause for approval in chat. The others prompt in a
   terminal or not at all by default.
8. **Your subscription runs the chat.** Sign in to Claude, Codex or Gemini once and chat runs
   on the plan you already pay for, while cheaper or local models handle background work.
   OpenClaw matches this; most of the field does not.

## Capabilities to add to Moss

Ordered by how much of the "why not Moss" list each one removes, against how much of Moss's
substrate already exists. Each names the gap, what Moss already has, and the smallest useful
version.

### 1. Message Moss from your phone through Telegram

The gap: number one on the list above. Moss has multi-user accounts, notifications and a chat
runtime; it has no way for a chat app to reach them. The web app is installable on a phone but
cannot push.

Smallest useful version: one bundled channel (Telegram, the one both competitors recommend
first) that pairs a chat account to a Moss user, relays messages into that user's chat surface,
and delivers notifications and briefings back. Approval cards become inline buttons. WhatsApp,
Signal and iMessage follow the same pairing model later. This also solves push for free.

### 2. Schedules and watchers the user creates in chat

The gap: "every morning at 7, tell me X" and "when an email from the school arrives, ping me."
Moss already has a job queue, a workflow engine with approvals, monitoring scans, and delivery
through notifications and email digests. What is missing is a user-owned schedule object the
assistant can create, list and delete from chat, and a settings screen listing them.

Smallest useful version: a scheduled prompt that runs the user's own chat with a fixed
instruction at a fixed time and delivers the answer as a notification (and to the phone channel
once it exists). Then triggers: new email matching a rule, a calendar event approaching, a
monitoring card of a kind. OpenClaw's touch of offering to schedule a task you keep repeating
is cheap and memorable. A heartbeat, meaning a periodic "anything I should raise?" turn, is the
same mechanism with a standing instruction.

### 3. Memory you can read as notes

The gap: both competitors, and Letta and Lindy, keep memory as files you can open. Moss has a
richer structure (a graph) but it lives behind a settings screen. Moss already archives chats
to Notes daily, so the plumbing to write into the vault exists.

Smallest useful version: a maintained "About you" note and a daily memory note in the vault,
written from the graph, and edits to those notes flowing back. That gives the transparency the
others advertise without abandoning the structure Moss has.

### 4. Skills the assistant writes, and skills you can import

The gap: Moss's skills are hand-written prompt files. Both competitors write their own, and
both read the open SKILL.md format that the shared hubs publish thousands of skills in.

Smallest useful version: "save what we just did as a skill" from chat, proposed for review
before it is stored (OpenClaw's Skill Workshop pattern), and an importer for the SKILL.md
folder format so a user can install a hub skill into their Moss skill library. Moss does not
need its own registry; it needs to read theirs.

### 5. A place for the assistant to actually do things

The gap: "The AI that really does things." Moss disallows the shell and limits file tools by
design, so it cannot convert a file, run a script, or drive a web page. This is the one item
that touches a deliberate decision, so it needs its own spec and Ben's ruling; it is listed
because it is the second reason people choose the other two.

Smallest useful version that respects the design: a per-user working folder inside the vault
where the assistant may read and write, a sandboxed run tool for scripts against that folder,
and browser control delivered as a connected MCP service (a browser automation server) using
the integrations screen that shipped on 2026-09-01. Results and files land in the user's folder
and show in chat as attachments.

### 6. Voice

The gap: both competitors talk and listen. Smallest useful version: push-to-talk in the web
app's chat drawer using the user's configured speech provider, and voice notes accepted on the
phone channel. Wake words and live conversation can wait.

### 7. Smart home through Home Assistant

The gap: both competitors control Home Assistant out of the box; it only appears in Moss
specs. Smallest useful version: document connecting Home Assistant's own MCP server through the
integrations screen, then decide whether a first-party module with a screen is worth it.

### 8. Import from the others

Hermes ships a one-command importer from OpenClaw; OpenClaw imports memory from Codex, Claude
Code and Hermes; Gemini imports from other assistants. Once Moss has readable memory notes
(item 3) and SKILL.md import (item 4), an importer for an OpenClaw or Hermes workspace is small
and removes the switching cost for exactly the people most likely to try Moss.

## What not to chase

- **Twenty-five chat platforms.** One pairing model and Telegram first. The long tail is
  plugins the community can write once the model exists.
- **Sixty model providers.** Three subscription logins plus any endpoint is enough; add
  providers when a user asks.
- **A skills marketplace.** Read the open format and the existing hubs instead of running one.
- **Phone-as-peripheral tricks** (camera, screen snapshot, location, SMS forwarding). Novel,
  but far from what Moss is for.
- **A one-command bare-metal install.** Docker plus Postgres is the right trade for a
  multi-user product with structured data.

## What the July analysis asked for, and where it stands

The July report's top five were an open module system, a workflow layer, custom commands, an
MCP client, and better retrieval. Since then Moss shipped module install from Settings,
Workshop-built modules, workflow approvals in chat, prompt-only skills, and MCP plus OpenAPI
integrations. This report's list is the next layer: reach (phone channel, voice), user-owned
automation, readable memory, self-written skills, and a bounded place to act.

## Filed as issues (2026-09-07)

| Capability | Issue |
|---|---|
| 1. Message Moss from your phone through Telegram | #2387 |
| 2. Schedules and watchers the user creates in chat | #2388 |
| 3. Memory you can read and edit as notes | #2390 |
| 4. Skills the assistant writes, and skills you can import | #2391 |
| 5. A place for the assistant to actually do things (needs Ben's ruling) | #2385 |
| 6. Voice: push-to-talk | #2386 |
| 7. Smart home through Home Assistant's MCP server | #2389 |
| 8. Import from an OpenClaw or Hermes workspace | #2392 |
