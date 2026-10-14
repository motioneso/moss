# Agent plugin and skill ecosystems: candidates for Moss

Date: 2026-10-14. Status: exploratory research for discussion; no implementation plan approved.
Method: official docs, catalogs and skill definitions, retrieved with GitHub CLI. No third-party packages installed or executed. Catalog presence establishes availability, not quality or Moss compatibility.

## Main finding

OpenClaw, Hermes, Gemini CLI and OpenCode all offer extensibility, but use different package/runtime boundaries. Moss can present a unified catalog while supporting instruction-only skills, skills with scripts/CLI dependencies, MCP services and adapted executable integrations. A common SKILL.md format does not make tools, credentials, scheduling or runtime code portable.

## Platform comparison

| Platform | Mechanisms | Useful precedent |
| --- | --- | --- |
| OpenClaw | Skills, native JS/TS plugins and bundles; ClawHub unified catalog | Unified discovery plus prerequisites and installation/enablement distinction. See detailed evidence below. |
| Hermes | AgentSkills-compatible skills, Python plugins, MCP tools | Progressive loading of instructions; separate plugin installation/enablement; bundled skills. [Skills](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/skills.md), [plugins](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/plugins.md). |
| Gemini CLI | Extensions package prompts, MCP servers, commands, themes, hooks, subagents and skills | A single extension can bundle tools with guidance; install/update/enable/disable including workspace scope. [Overview](https://github.com/google-gemini/gemini-cli/blob/main/docs/extensions/index.md), [reference](https://github.com/google-gemini/gemini-cli/blob/main/docs/extensions/reference.md). |
| OpenCode | JS/TS hook plugins from npm/local files, plus separate skills and MCP | Capability examples include Firecrawl, Tavily and Supermemory; plugin code targets OpenCode APIs. [Plugins](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/plugins.mdx), [ecosystem](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/ecosystem.mdx), [skills](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/skills.mdx). |

## Hermes: concrete capability candidates

Hermes maintains both a [bundled skills catalog](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/skills-catalog.md) and an [official optional catalog](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/optional-skills-catalog.md).

| Capability | Actual entries | Requirements / adaptation |
| --- | --- | --- |
| Web extraction | scrapling (optional) | Python and browser dependencies. [Definition](https://github.com/NousResearch/hermes-agent/blob/main/optional-skills/research/scrapling/SKILL.md). Moss should assess its MCP server rather than import Hermes terminal instructions unchanged. |
| Local knowledge search | qmd (optional) | Local collections/index, Node.js and model dependencies. [Definition](https://github.com/NousResearch/hermes-agent/blob/main/optional-skills/research/qmd/SKILL.md). |
| RSS/blog monitoring | blogwatcher, rss-feeds (optional) | CLI and persistent subscriptions for Blogwatcher; translate Hermes scheduling guidance. [Definition](https://github.com/NousResearch/hermes-agent/blob/main/optional-skills/research/blogwatcher/SKILL.md). |
| Web search | duckduckgo-search, searxng-search (optional) | Distinct upstream search backends; assess reliability and existing Moss overlap. [Optional catalog](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/optional-skills-catalog.md). |
| PDF/OCR | pdf (bundled) | Python helpers using pypdf/reportlab/pdfplumber; optional OCR dependencies. [Definition](https://github.com/NousResearch/hermes-agent/blob/main/skills/productivity/pdf/SKILL.md). |
| Office files | docx, xlsx, powerpoint (bundled) | Word, Excel/CSV and presentation processing. [Bundled catalog](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/skills-catalog.md). |
| Video transcripts | youtube-content (bundled) | Python youtube_transcript_api helper; depends on target transcript availability. [Definition](https://github.com/NousResearch/hermes-agent/blob/main/skills/media/youtube-content/SKILL.md). |
| Audio transcription | whisper (optional) | Python/torch, model download and compute. [Definition](https://github.com/NousResearch/hermes-agent/blob/main/optional-skills/mlops/whisper/SKILL.md). |
| Notes/services | obsidian, notion, airtable, box, google-workspace (bundled) | Vault access or account credentials; some may overlap current Moss integrations. [Bundled catalog](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/skills-catalog.md). |
| Workflow guidance | meeting-action-items, document-to-action-items, weekly-review-planning (bundled) | Adapt instructions to Moss actions instead of duplicating task storage. [Bundled catalog](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/skills-catalog.md). |
| Price watches | product-price-monitor (bundled) | Product, flight and listing monitoring with alerts. [Bundled catalog](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/skills-catalog.md). |
| Smart lights | openhue (optional) | Hue Bridge access and OpenHue CLI. [Optional catalog](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/optional-skills-catalog.md). |

Hermes also ships teams_pipeline and google_meet executable plugins for meeting workflows. General plugins can bundle skills and register tools/hooks/providers; these target Hermes APIs. [Built-in plugins](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/built-in-plugins.md).

Documentation inconsistency: the built-in-plugins page introduction suggests automatic loading, while its explicit opt-in section and the general plugins page require enablement. Use the explicit opt-in rule as the documented behavior; no execution test was performed.

## Gemini: a complete bundle example

The official [Google Workspace extension](https://github.com/gemini-cli-extensions/workspace) offers Docs, Sheets, Slides, Gmail, Chat, Drive and Calendar interactions and requires Google account authentication. This illustrates bundling related tools, prompts and commands. Its authentication/runtime needs Moss-specific integration; it is not a verified drop-in package.

## Moss shortlist and design implications

Recommended first capabilities, subject to design discussion:

1. Scrapling: self-hosted web extraction plus Moss-specific tool-use instructions.
2. Document tools: PDF/OCR and Word/Excel/presentation processing.
3. Video/audio understanding: transcript extraction plus optional local transcription.
4. RSS/blog watches, composed with Moss schedules and notification delivery.
5. External knowledge sources such as Obsidian/Notion, with QMD only where it adds to existing search.
6. Smart-home integrations after LAN/device access and credential scope are designed.

Catalog entries should record publisher, upstream source/license, pinned version, backend type, dependencies, credentials, supported OS/runtime, account/user scope and update policy. Distinguish installation from configuration and per-user enablement. Show Ready / Connect account / Needs runtime / Needs companion device so toggles reflect actual availability. Load skill content when relevant. Reuse upstream backends and knowledge; adapt platform-specific hooks and commands.

These are recommendations, not an approved backlog or compatibility assurance. Each candidate needs license review, real integration proof and an overlap check against existing Moss capabilities before shipping.

## Repository snapshots

Observed upstream heads: Hermes main e8c8e464715d11bfb7b3006edabff6b719a29b8b; OpenClaw main 3e3a1a330388c3e9204c518cb658838913090d6b; Gemini CLI main 06d329873703ddabe8a842d962342ac4ad779e83; OpenCode dev 13afea6a1a76360936bbaa7677cff600ad52d452. Branch-linked pages can change. Requests were not all pinned atomically to these heads; current main may differ from published releases.

## OpenClaw: detailed source evidence


Researched 2026-10-14 via agent-reach GitHub/gh CLI using upstream source docs. OpenClaw main at retrieval: 3e3a1a330388c3e9204c518cb658838913090d6b (2026-10-14). Describes current main, not guarantees for older installed releases. No installs, execution of third-party code, or repository edits.

### What exists

- Skills are `SKILL.md` instruction bundles with supporting files. They teach when/how to use tools; eligibility checks operating system, required binaries/environment/config. User enablement alone does not supply executables or credentials. Source: https://github.com/openclaw/openclaw/blob/main/docs/tools/skills.md
- Native plugins are JavaScript/TypeScript code loaded in-process inside the Gateway. They register tools, hooks, background services, routes, CLI commands, channels, model/search/fetch/media providers. Not portable drop-in code for Moss without an adapter. Source: https://github.com/openclaw/openclaw/blob/main/docs/plugins/architecture.md
- A plugin can bundle skills via `skills` directories in `openclaw.plugin.json`; these load only when plugin enabled. Browser plugin bundles `browser-automation`. Source: https://github.com/openclaw/openclaw/blob/main/docs/tools/skills.md#plugins-and-skills
- ClawHub now explicitly has a unified skills + plugins catalog: skills, native code plugins, compatible bundle plugins; main README also describes experimental whole-agent packages. Versioning, changelogs, metadata, security scan summaries, inspect-before-install, publishing. Source: https://github.com/openclaw/clawhub/blob/main/README.md and https://github.com/openclaw/clawhub/blob/main/docs/clawhub.md
- Generated official inventory at retrieval lists 68 core-packaged plugins and 97 official external packages (includes many model providers and message channels, not 165 end-user workflows). Source: https://github.com/openclaw/openclaw/blob/main/docs/plugins/plugin-inventory.md
- Install plugins from ClawHub/npm/git/local sources; configure `plugins.entries.<id>.config`, enable with `openclaw plugins enable <id>`, check allow/deny, runtime registration. Current plugin-management commands apply to a running local Gateway automatically, subject to explicit restart policy. Source: https://github.com/openclaw/openclaw/blob/main/docs/tools/plugin.md
- Shared-gateway personal skills have ownership, team sharing, immutable revisions, per-session selection; UI is Plugins → Skills. Import SKILL.md/ZIP or ClawHub. Ownership is management/discovery, not runtime isolation; shared gateway is one trust domain. Source: https://github.com/openclaw/openclaw/blob/main/docs/tools/skills.md#personal-skills-on-a-shared-gateway

### Concrete useful examples

| Name/type | Capability | Required setup/runtime | Primary citation |
|---|---|---|---|
| Firecrawl — official executable plugin | Web search, scrape tools, web-fetch fallback for complex sites | Install `@openclaw/firecrawl-plugin`; hosted service. Explicit tools require API key; opt-in free search/keyless fetch available | https://github.com/openclaw/openclaw/blob/main/docs/tools/firecrawl.md |
| summarize — bundled skill | Summarize/extract URLs, YouTube, podcasts, PDFs, local files | `summarize` CLI; chosen model provider key for summaries; extraction mode separate | https://github.com/openclaw/openclaw/blob/main/skills/summarize/SKILL.md |
| blogwatcher — bundled skill | Track blogs/RSS/Atom updates | `blogwatcher` Go CLI; persisted subscriptions/read state | https://github.com/openclaw/openclaw/blob/main/skills/blogwatcher/SKILL.md |
| nano-pdf — bundled skill | Natural-language edits to a PDF page | Python/uv-installed `nano-pdf` CLI | https://github.com/openclaw/openclaw/blob/main/skills/nano-pdf/SKILL.md |
| gog — bundled skill | Gmail, Calendar, Drive, Contacts, Sheets, Docs | `gog` CLI, Google OAuth, headless callback/token handling | https://github.com/openclaw/openclaw/blob/main/skills/gog/SKILL.md |
| notion — bundled skill | Notion pages, Markdown, databases/data sources, files/comments/search | Official `ntn` CLI or curl; Notion login/token | https://github.com/openclaw/openclaw/blob/main/skills/notion/SKILL.md |
| himalaya — bundled skill | Generic IMAP/SMTP email reading, searching, writing, organizing | `himalaya` CLI and configured mail account | https://github.com/openclaw/openclaw/blob/main/skills/himalaya/SKILL.md |
| openai-whisper — bundled skill | Local audio transcription and subtitles | `whisper` CLI, model downloads and compute; no API key | https://github.com/openclaw/openclaw/blob/main/skills/openai-whisper/SKILL.md |
| openhue — bundled skill | Philips Hue lights, rooms, scenes | `openhue` CLI and access to Hue Bridge | https://github.com/openclaw/openclaw/blob/main/skills/openhue/SKILL.md |
| sonoscli — bundled skill | Speaker discovery, playback, volume, grouping | `sonos` Go CLI and speaker LAN access; optional Spotify credentials | https://github.com/openclaw/openclaw/blob/main/skills/sonoscli/SKILL.md |
| obsidian — bundled skill | Read/search/edit vault notes, tasks, links, properties | Official `obsidian` CLI; running Obsidian 1.12.7+, CLI enabled; plain Markdown file fallback | https://github.com/openclaw/openclaw/blob/main/skills/obsidian/SKILL.md |
| Peekaboo — bundled skill | Desktop UI inspection and automation | macOS-only CLI/bridge, desktop permissions; companion-host requirement | https://github.com/openclaw/openclaw/blob/main/skills/peekaboo/SKILL.md |
| Voice Call — official executable plugin | Outbound notifications, inbound calls, multi-turn realtime voice | `@openclaw/voice-call`, Twilio/Telnyx/Plivo credentials, number, public webhook | https://github.com/openclaw/openclaw/blob/main/docs/plugins/voice-call.md |
| document-extract — core executable plugin | Text extraction and fallback page images from local attachments | Included in core OpenClaw; runtime-specific integration | https://github.com/openclaw/openclaw/blob/main/docs/plugins/plugin-inventory.md |
| Lobster — official executable plugin | Typed workflow pipelines with resumable approvals | `@openclaw/lobster`; runtime adapter/workflow integration | https://github.com/openclaw/openclaw/blob/main/docs/plugins/plugin-inventory.md |
| mcporter — bundled skill | Inspect/authenticate/call MCP over HTTP or stdio | `mcporter` Node CLI plus individual server credentials/runtime | https://github.com/openclaw/openclaw/blob/main/skills/mcporter/SKILL.md |

### Community scope

Official docs intentionally no longer maintain static third-party plugin lists: ClawHub owns live discovery/release/scan/install metadata, community publishes there. https://github.com/openclaw/openclaw/blob/main/docs/plugins/community.md

One independently discovered community code package: `@kryptt/openclaw-home-auto-plugin` describes Home Assistant state/services/entities; its manifest currently configures a TimescaleDB URL, Telegram chat and anomaly/baseline parameters. Version 0.2.7 declares OpenClaw API compatibility >=2026.4.5 and ClawHub publishing. No README in repository and not executed/tested; discovery example, not recommended proven integration. Sources: https://github.com/kryptt/openclaw-home-auto-plugin/blob/main/package.json and https://github.com/kryptt/openclaw-home-auto-plugin/blob/main/openclaw.plugin.json

### Implications for Moss (analysis)

1. Model a registry entry as user-facing capability plus instructions and explicit backend/dependencies. A skill-only entry may be portable; executable OpenClaw plugins target its Gateway SDK.
2. Useful early catalog: web extraction/research, document processing, transcription/media extraction, feed monitoring. Productivity connectors may duplicate existing Moss integrations, so evaluate against existing capabilities.
3. Catalog should distinguish Ready, Needs account, Needs runtime, Needs companion device. Desktop/home-device capabilities cannot be enabled in a hosted container without user-device/LAN bridge.
4. Borrow ClawHub's unified discovery and dependency metadata, pinned revisions, install/enable distinction, version/compatibility information. Do not copy shared one-trust-domain semantics for per-user isolation.
