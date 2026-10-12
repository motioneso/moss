/* Moss repository-review mockups. No backend, storage, or network integration. */
(() => {
  "use strict";
  const STEPS = [
    "Install Moss",
    "Your account",
    "A little about you",
    "AI assistance",
    "Your notes",
    "Email",
    "News",
    "Sports",
    "Ready",
    "Today"
  ];
  const CITIES = [
    {
      id: "new-york",
      name: "New York",
      region: "New York, United States",
      timezone: "America/New_York"
    },
    { id: "london", name: "London", region: "United Kingdom", timezone: "Europe/London" },
    {
      id: "seattle",
      name: "Seattle",
      region: "Washington, United States",
      timezone: "America/Los_Angeles"
    },
    { id: "sydney", name: "Sydney", region: "Australia", timezone: "Australia/Sydney" },
    {
      id: "san-francisco",
      name: "San Francisco",
      region: "California, United States",
      timezone: "America/Los_Angeles"
    },
    {
      id: "chicago",
      name: "Chicago",
      region: "Illinois, United States",
      timezone: "America/Chicago"
    },
    { id: "denver", name: "Denver", region: "Colorado, United States", timezone: "America/Denver" },
    {
      id: "phoenix",
      name: "Phoenix",
      region: "Arizona, United States",
      timezone: "America/Phoenix"
    },
    { id: "paris", name: "Paris", region: "France", timezone: "Europe/Paris" },
    { id: "tokyo", name: "Tokyo", region: "Japan", timezone: "Asia/Tokyo" }
  ];
  // Fixture labels from the existing Moss timezone-city fallback table; no IP or device lookup.
  const WEATHER_FALLBACK = {
    "America/New_York": "New York, US",
    "America/Chicago": "Chicago, US",
    "America/Denver": "Denver, US",
    "America/Los_Angeles": "Los Angeles, US",
    "America/Anchorage": "Anchorage, US",
    "Pacific/Honolulu": "Honolulu, US",
    "America/Sao_Paulo": "São Paulo, Brazil",
    "America/Mexico_City": "Mexico City, Mexico",
    "America/Toronto": "Toronto, Canada",
    "America/Vancouver": "Vancouver, Canada",
    "America/Argentina/Buenos_Aires": "Buenos Aires, Argentina",
    "America/Bogota": "Bogotá, Colombia",
    "America/Lima": "Lima, Peru",
    "America/Santiago": "Santiago, Chile",
    "Europe/London": "London, UK",
    "Europe/Paris": "Paris, France",
    "Europe/Berlin": "Berlin, Germany",
    "Europe/Madrid": "Madrid, Spain",
    "Europe/Rome": "Rome, Italy",
    "Europe/Amsterdam": "Amsterdam, Netherlands",
    "Europe/Brussels": "Brussels, Belgium",
    "Europe/Vienna": "Vienna, Austria",
    "Europe/Zurich": "Zurich, Switzerland",
    "Europe/Dublin": "Dublin, Ireland",
    "Europe/Lisbon": "Lisbon, Portugal",
    "Europe/Stockholm": "Stockholm, Sweden",
    "Europe/Oslo": "Oslo, Norway",
    "Europe/Copenhagen": "Copenhagen, Denmark",
    "Europe/Helsinki": "Helsinki, Finland",
    "Europe/Warsaw": "Warsaw, Poland",
    "Europe/Prague": "Prague, Czechia",
    "Europe/Athens": "Athens, Greece",
    "Europe/Moscow": "Moscow, Russia",
    "Europe/Istanbul": "Istanbul, Turkey",
    "Atlantic/Reykjavik": "Reykjavík, Iceland",
    "Africa/Cairo": "Cairo, Egypt",
    "Africa/Lagos": "Lagos, Nigeria",
    "Africa/Johannesburg": "Johannesburg, South Africa",
    "Africa/Nairobi": "Nairobi, Kenya",
    "Africa/Casablanca": "Casablanca, Morocco",
    "Asia/Dubai": "Dubai, UAE",
    "Asia/Karachi": "Karachi, Pakistan",
    "Asia/Kolkata": "New Delhi, India",
    "Asia/Dhaka": "Dhaka, Bangladesh",
    "Asia/Bangkok": "Bangkok, Thailand",
    "Asia/Jakarta": "Jakarta, Indonesia",
    "Asia/Singapore": "Singapore",
    "Asia/Kuala_Lumpur": "Kuala Lumpur, Malaysia",
    "Asia/Manila": "Manila, Philippines",
    "Asia/Hong_Kong": "Hong Kong",
    "Asia/Shanghai": "Shanghai, China",
    "Asia/Taipei": "Taipei, Taiwan",
    "Asia/Seoul": "Seoul, South Korea",
    "Asia/Tokyo": "Tokyo, Japan",
    "Asia/Tel_Aviv": "Tel Aviv, Israel",
    "Asia/Riyadh": "Riyadh, Saudi Arabia",
    "Australia/Sydney": "Sydney, Australia",
    "Australia/Melbourne": "Melbourne, Australia",
    "Australia/Brisbane": "Brisbane, Australia",
    "Australia/Perth": "Perth, Australia",
    "Pacific/Auckland": "Auckland, New Zealand"
  };
  const weatherLabel = (s) =>
    s.city
      ? `${s.city} · chosen city`
      : WEATHER_FALLBACK[s.timezone]
        ? `${WEATHER_FALLBACK[s.timezone]} · time zone fallback`
        : "Weather location unresolved · choose a city later";
  const emailContextReady = (s) =>
    (s.email === "connected" && s.emailSync === "ready") ||
    Boolean(s.savedEmail && s.savedEmailSync === "ready");
  function chooseCity(state, id) {
    const city = CITIES.find((c) => c.id === id);
    if (!city) return false;
    state.city = city.name;
    state.cityId = city.id;
    if (state.timezoneSource !== "manual") {
      state.timezone = city.timezone;
      state.timezoneSource = "city";
    }
    return true;
  }
  const initialState = () => ({
    version: 1,
    schemaRevision: 3,
    step: 0,
    setupRoute: "local",
    installPanel: "route",
    hostPlatform: "macos",
    runtimeTarget: "linux-aarch64",
    dockerStatus: "unknown",
    installStatus: "unprepared",
    protectedContinuation: false,
    installIdentity: "demo-installation-1",
    hostNotesChoice: "existing",
    hostFolder: "",
    notesPrepared: false,
    providers: [],
    registryQuery: "",
    registryOpen: false,
    registrySelection: "",
    newsCustom: [],
    topicLabel: "",
    topicGuidance: "",
    newsStructured: false,
    newsSearch: false,
    name: "Alex",
    assistant: "Moss",
    city: "",
    cityId: "",
    cityQuery: "",
    units: "fahrenheit",
    timezoneSource: "sample",
    timezone: "Etc/UTC",
    account: false,
    provider: "claude",
    ai: "idle",
    aiMethod: "account",
    model: "",
    notesChoice: "existing",
    notes: "idle",
    notesRoot: "",
    email: "idle",
    emailSync: "pending",
    savedEmailSync: null,
    news: [],
    sports: [],
    completed: false,
    transport: "secure",
    theme: "forest",
    mode: "light",
    pendingSave: false,
    accessMode: "local",
    browserConnection: "protected",
    accessDraft: "local",
    accessPanel: "",
    accessStatus: "idle",
    accessReturnStep: 8,
    furthest: 0,
    savedAi: null,
    savedNotes: null,
    skipped: []
  });
  const esc = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
    );
  function toggleItem(items, value) {
    return items.includes(value) ? items.filter((x) => x !== value) : [...items, value];
  }
  const aiReady = (s) =>
    s.providers?.some((p) => p.chat === true) ||
    (s.ai === "connected" && ["claude", "codex", "opencode", "local"].includes(s.provider)) ||
    Boolean(s.savedAi?.chat);
  const installationReady = (s) =>
    s.installStatus === "running" && s.protectedContinuation === true;
  const newsTopicsReady = (s) => s.newsStructured === true && s.newsSearch === true;
  const ACP_REGISTRY = [
    {
      id: "agoragentic-acp",
      name: "Agoragentic",
      version: "1.3.0",
      description:
        "Agent marketplace with 174+ AI capabilities. Browse, invoke, and pay for agent services settled in USDC on Base L2.",
      website: null,
      license: "MIT",
      publisher: [],
      runtimeKinds: ["npx"],
      binaryTargets: []
    },
    {
      id: "amp-acp",
      name: "Amp",
      version: "0.10.0",
      description: "ACP wrapper for Amp - the frontier coding agent",
      website: null,
      license: "Apache-2.0",
      publisher: [],
      runtimeKinds: ["binary"],
      binaryTargets: [
        "darwin-aarch64",
        "darwin-x86_64",
        "linux-aarch64",
        "linux-x86_64",
        "windows-x86_64"
      ]
    },
    {
      id: "antigravity-acp",
      name: "Google Antigravity",
      version: "1.3.0",
      description: "Google’s AI coding agent",
      website: null,
      license: "proprietary",
      publisher: [],
      runtimeKinds: ["binary"],
      binaryTargets: [
        "darwin-aarch64",
        "darwin-x86_64",
        "linux-x86_64",
        "linux-aarch64",
        "windows-x86_64",
        "windows-aarch64"
      ]
    },
    {
      id: "auggie",
      name: "Auggie CLI",
      version: "0.36.0",
      description:
        "Augment Code's powerful software agent, backed by industry-leading context engine",
      website: null,
      license: "proprietary",
      publisher: [],
      runtimeKinds: ["npx"],
      binaryTargets: []
    },
    {
      id: "autohand",
      name: "Autohand Code",
      version: "0.2.1",
      description: "Autohand Code - AI coding agent powered by Autohand AI",
      website: null,
      license: "Apache-2.0",
      publisher: [],
      runtimeKinds: ["npx"],
      binaryTargets: []
    },
    {
      id: "claude-acp",
      name: "Claude Agent",
      version: "0.89.1",
      description: "ACP wrapper for Anthropic's Claude",
      website: null,
      license: "proprietary",
      publisher: [],
      runtimeKinds: ["npx"],
      binaryTargets: []
    },
    {
      id: "cline",
      name: "Cline",
      version: "3.0.70",
      description:
        "Autonomous coding agent CLI - capable of creating/editing files, running commands, using the browser, and more",
      website: null,
      license: "Apache-2.0",
      publisher: [],
      runtimeKinds: ["npx"],
      binaryTargets: []
    },
    {
      id: "codebuddy-code",
      name: "Codebuddy Code",
      version: "2.164.0",
      description: "Tencent Cloud's official intelligent coding tool",
      website: null,
      license: "Proprietary",
      publisher: [],
      runtimeKinds: ["npx"],
      binaryTargets: []
    },
    {
      id: "codex-acp",
      name: "Codex",
      version: "2.2.2",
      description: "ACP adapter for OpenAI's coding assistant",
      website: null,
      license: "Apache-2.0",
      publisher: [],
      runtimeKinds: ["npx"],
      binaryTargets: []
    },
    {
      id: "cortex-code",
      name: "Cortex Code",
      version: "1.0.73",
      description: "Snowflake's Cortex Code coding agent",
      website: null,
      license: "proprietary",
      publisher: [],
      runtimeKinds: ["binary"],
      binaryTargets: [
        "darwin-aarch64",
        "darwin-x86_64",
        "linux-x86_64",
        "linux-aarch64",
        "windows-x86_64",
        "windows-aarch64"
      ]
    },
    {
      id: "corust-agent",
      name: "Corust Agent",
      version: "0.6.0",
      description: "Co-building with a seasoned Rust partner.",
      website: null,
      license: "GPL-3.0-or-later",
      publisher: [],
      runtimeKinds: ["binary"],
      binaryTargets: ["darwin-aarch64", "darwin-x86_64", "linux-x86_64", "windows-x86_64"]
    },
    {
      id: "crow-cli",
      name: "crow-cli",
      version: "0.1.24",
      description: "Minimal ACP Native Coding Agent",
      website: null,
      license: "Apache-2.0",
      publisher: [],
      runtimeKinds: ["binary"],
      binaryTargets: [
        "darwin-aarch64",
        "darwin-x86_64",
        "linux-aarch64",
        "linux-x86_64",
        "windows-x86_64"
      ]
    },
    {
      id: "cursor",
      name: "Cursor",
      version: "2026.10.01",
      description: "Cursor's coding agent",
      website: null,
      license: "proprietary",
      publisher: [],
      runtimeKinds: ["binary"],
      binaryTargets: [
        "darwin-aarch64",
        "darwin-x86_64",
        "linux-aarch64",
        "linux-x86_64",
        "windows-aarch64",
        "windows-x86_64"
      ]
    },
    {
      id: "deepagents",
      name: "DeepAgents",
      version: "0.1.7",
      description: "Batteries-included AI coding and general purpose agent powered by LangChain.",
      website: null,
      license: "MIT",
      publisher: [],
      runtimeKinds: ["npx"],
      binaryTargets: []
    },
    {
      id: "devin",
      name: "Devin",
      version: "3000.11.3",
      description: "Devin CLI coding agent by Cognition",
      website: null,
      license: "proprietary",
      publisher: [],
      runtimeKinds: ["binary"],
      binaryTargets: [
        "darwin-aarch64",
        "darwin-x86_64",
        "linux-aarch64",
        "linux-x86_64",
        "windows-aarch64",
        "windows-x86_64"
      ]
    },
    {
      id: "dimcode",
      name: "DimCode",
      version: "0.5.16",
      description: "A coding agent that puts leading models at your command.",
      website: null,
      license: "proprietary",
      publisher: [],
      runtimeKinds: ["npx"],
      binaryTargets: []
    },
    {
      id: "dirac",
      name: "Dirac",
      version: "0.5.19",
      description:
        "Reduces API costs by more than 50%, produces better and faster work. Uses Hash anchored parallel edits, AST manipulation and a whole lot of neat optimizations. Fully Open Source.",
      website: null,
      license: "Apache-2.0",
      publisher: [],
      runtimeKinds: ["npx"],
      binaryTargets: []
    },
    {
      id: "factory-droid",
      name: "Factory Droid",
      version: "0.238.0",
      description: "Factory Droid - AI coding agent powered by Factory AI",
      website: null,
      license: "proprietary",
      publisher: [],
      runtimeKinds: ["npx"],
      binaryTargets: []
    },
    {
      id: "fast-agent",
      name: "fast-agent",
      version: "0.10.1",
      description: "Code and build agents with comprehensive multi-provider support",
      website: null,
      license: "Apache 2.0",
      publisher: [],
      runtimeKinds: ["uvx"],
      binaryTargets: []
    },
    {
      id: "gemini",
      name: "Gemini CLI",
      version: "0.63.0",
      description: "Google's official CLI for Gemini",
      website: null,
      license: "Apache-2.0",
      publisher: [],
      runtimeKinds: ["npx"],
      binaryTargets: []
    },
    {
      id: "github-copilot-cli",
      name: "Copilot",
      version: "1.0.95",
      description: "GitHub's AI pair programmer",
      website: null,
      license: "proprietary",
      publisher: [],
      runtimeKinds: ["npx"],
      binaryTargets: []
    },
    {
      id: "glm-acp-agent",
      name: "GLM Agent",
      version: "1.14.0",
      description:
        "ACP agent powered by Zhipu AI's GLM Coding Plan models (glm-5.1, glm-5-turbo, glm-4.7, glm-4.5-air). Supports streaming, tool calls, mid-session model switching, image input via Z.AI Coding Plan Vision MCP, and session load/fork/resume with on-disk persistence.",
      website: null,
      license: "Apache-2.0",
      publisher: [],
      runtimeKinds: ["npx"],
      binaryTargets: []
    },
    {
      id: "goose",
      name: "goose",
      version: "1.54.0",
      description: "A local, extensible, open source AI agent that automates engineering tasks",
      website: null,
      license: "Apache-2.0",
      publisher: [],
      runtimeKinds: ["binary"],
      binaryTargets: [
        "darwin-aarch64",
        "darwin-x86_64",
        "linux-aarch64",
        "linux-x86_64",
        "windows-x86_64"
      ]
    },
    {
      id: "grok-build",
      name: "Grok Build",
      version: "1.0.51",
      description: "xAI's coding agent and CLI",
      website: null,
      license: "proprietary",
      publisher: [],
      runtimeKinds: ["npx"],
      binaryTargets: []
    },
    {
      id: "harn",
      name: "Harn",
      version: "0.10.163",
      description: "Harn runs .harn agent pipelines as a native ACP coding agent over stdio.",
      website: null,
      license: "Apache-2.0",
      publisher: [],
      runtimeKinds: ["binary"],
      binaryTargets: [
        "darwin-aarch64",
        "darwin-x86_64",
        "linux-aarch64",
        "linux-x86_64",
        "windows-x86_64"
      ]
    },
    {
      id: "junie",
      name: "Junie",
      version: "3579.5.0",
      description: "AI Coding Agent by JetBrains",
      website: null,
      license: "proprietary",
      publisher: [],
      runtimeKinds: ["binary"],
      binaryTargets: [
        "darwin-aarch64",
        "darwin-x86_64",
        "linux-aarch64",
        "linux-x86_64",
        "windows-x86_64",
        "windows-aarch64"
      ]
    },
    {
      id: "kilo",
      name: "Kilo",
      version: "7.8.8",
      description: "The open source coding agent",
      website: null,
      license: "MIT",
      publisher: [],
      runtimeKinds: ["binary", "npx"],
      binaryTargets: [
        "darwin-aarch64",
        "darwin-x86_64",
        "linux-aarch64",
        "linux-x86_64",
        "windows-x86_64"
      ]
    },
    {
      id: "kimchi",
      name: "Kimchi",
      version: "1.9.1",
      description: "Coding agent powered by multi-model orchestration",
      website: null,
      license: "Apache-2.0",
      publisher: [],
      runtimeKinds: ["binary"],
      binaryTargets: [
        "darwin-aarch64",
        "darwin-x86_64",
        "linux-aarch64",
        "linux-x86_64",
        "windows-x86_64"
      ]
    },
    {
      id: "kimi",
      name: "Kimi CLI",
      version: "1.52.0",
      description: "Moonshot AI's coding assistant",
      website: null,
      license: "MIT",
      publisher: [],
      runtimeKinds: ["binary"],
      binaryTargets: [
        "darwin-aarch64",
        "linux-aarch64",
        "linux-x86_64",
        "windows-aarch64",
        "windows-x86_64"
      ]
    },
    {
      id: "minimax-code",
      name: "MiniMax Code",
      version: "0.2.7",
      description: "MiniMax Code is an AI coding agent with Agent Client Protocol support.",
      website: null,
      license: "MIT",
      publisher: [],
      runtimeKinds: ["npx"],
      binaryTargets: []
    },
    {
      id: "minion-code",
      name: "Minion Code",
      version: "0.1.44",
      description:
        "An enhanced AI code assistant built on the Minion framework with rich development tools",
      website: null,
      license: "AGPL-3.0",
      publisher: [],
      runtimeKinds: ["uvx"],
      binaryTargets: []
    },
    {
      id: "mistral-vibe",
      name: "Mistral Vibe",
      version: "2.26.1",
      description: "Mistral's open-source coding assistant",
      website: null,
      license: "Apache-2.0",
      publisher: [],
      runtimeKinds: ["binary"],
      binaryTargets: [
        "darwin-aarch64",
        "darwin-x86_64",
        "linux-aarch64",
        "linux-x86_64",
        "windows-x86_64"
      ]
    },
    {
      id: "nova",
      name: "Nova",
      version: "1.1.51",
      description: "Nova by Compass AI - a fully-fledged software engineer at your command",
      website: null,
      license: "proprietary",
      publisher: [],
      runtimeKinds: ["npx"],
      binaryTargets: []
    },
    {
      id: "opencode",
      name: "OpenCode",
      version: "1.19.0",
      description: "The open source coding agent",
      website: null,
      license: "MIT",
      publisher: [],
      runtimeKinds: ["binary"],
      binaryTargets: [
        "darwin-aarch64",
        "darwin-x86_64",
        "linux-aarch64",
        "linux-x86_64",
        "windows-aarch64",
        "windows-x86_64"
      ]
    },
    {
      id: "pi-acp",
      name: "pi ACP",
      version: "0.0.34",
      description: "ACP adapter for pi coding agent",
      website: null,
      license: "MIT",
      publisher: [],
      runtimeKinds: ["npx"],
      binaryTargets: []
    },
    {
      id: "poolside",
      name: "Poolside",
      version: "1.0.16",
      description: "Poolside's coding agent",
      website: null,
      license: "proprietary",
      publisher: [],
      runtimeKinds: ["binary"],
      binaryTargets: [
        "darwin-aarch64",
        "darwin-x86_64",
        "linux-aarch64",
        "linux-x86_64",
        "windows-aarch64",
        "windows-x86_64"
      ]
    },
    {
      id: "qoder",
      name: "Qoder CLI",
      version: "0.2.14",
      description: "AI coding assistant with agentic capabilities",
      website: null,
      license: "proprietary",
      publisher: [],
      runtimeKinds: ["npx"],
      binaryTargets: []
    },
    {
      id: "qwen-code",
      name: "Qwen Code",
      version: "0.25.1",
      description: "Alibaba's Qwen coding assistant",
      website: null,
      license: "Apache-2.0",
      publisher: [],
      runtimeKinds: ["npx"],
      binaryTargets: []
    },
    {
      id: "sigit",
      name: "siGit Code",
      version: "1.6.7",
      description:
        "Local-first coding agent. Runs entirely on your machine with optional on-device LLM inference via Onde.",
      website: null,
      license: "Apache-2.0",
      publisher: [],
      runtimeKinds: ["binary", "npx"],
      binaryTargets: [
        "darwin-aarch64",
        "darwin-x86_64",
        "linux-aarch64",
        "linux-x86_64",
        "windows-aarch64",
        "windows-x86_64"
      ]
    },
    {
      id: "stakpak",
      name: "Stakpak",
      version: "0.3.88",
      description: "Open-source DevOps agent in Rust with enterprise-grade security",
      website: null,
      license: "Apache-2.0",
      publisher: [],
      runtimeKinds: ["binary"],
      binaryTargets: [
        "darwin-aarch64",
        "darwin-x86_64",
        "linux-aarch64",
        "linux-x86_64",
        "windows-x86_64"
      ]
    },
    {
      id: "vtcode",
      name: "VT Code",
      version: "0.96.14",
      description:
        "An open-source coding agent with LLM-native code understanding and robust shell safety. Supports multiple LLM providers with automatic failover and efficient context management.",
      website: null,
      license: "MIT",
      publisher: [],
      runtimeKinds: ["binary"],
      binaryTargets: ["darwin-aarch64", "darwin-x86_64", "linux-x86_64", "windows-x86_64"]
    }
  ];
  const ACP_SOURCE = {
    schemaVersion: 1,
    registryVersion: "1.0.0",
    retrievedAt: "2026-10-11T23:50:28Z",
    agentCount: 41,
    sourceUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json",
    sourceSha256: "1d172c5340cd26e9f654940cecb39ceaea83a80801280b1741fb934c6d98a5cb",
    ordering: "upstream-stable-index"
  };
  const ACP_SUPPORT = {
    "agoragentic-acp": {
      status: "integration-needed",
      chatSupported: false,
      providerKind: null,
      testedVersion: null,
      note: "Listed in the official ACP registry; no current Moss chat integration is established by this listing."
    },
    "amp-acp": {
      status: "integration-needed",
      chatSupported: false,
      providerKind: null,
      testedVersion: null,
      note: "Listed in the official ACP registry; no current Moss chat integration is established by this listing."
    },
    "antigravity-acp": {
      status: "integration-needed",
      chatSupported: false,
      providerKind: "google",
      testedVersion: null,
      note: "Moss declares its Google adapter not chat-ready. Separate ACP login and a verified native shell/file-write denial mechanism remain unresolved."
    },
    auggie: {
      status: "integration-needed",
      chatSupported: false,
      providerKind: null,
      testedVersion: null,
      note: "Listed in the official ACP registry; no current Moss chat integration is established by this listing."
    },
    autohand: {
      status: "integration-needed",
      chatSupported: false,
      providerKind: null,
      testedVersion: null,
      note: "Listed in the official ACP registry; no current Moss chat integration is established by this listing."
    },
    "claude-acp": {
      status: "supported-tested-route",
      chatSupported: true,
      providerKind: "anthropic",
      testedVersion: "0.75.1",
      note: "Moss declares this pinned adapter chat-ready. Registry discovery versions are separate; selecting an entry must not upgrade the tested route."
    },
    cline: {
      status: "integration-needed",
      chatSupported: false,
      providerKind: null,
      testedVersion: null,
      note: "Listed in the official ACP registry; no current Moss chat integration is established by this listing."
    },
    "codebuddy-code": {
      status: "integration-needed",
      chatSupported: false,
      providerKind: null,
      testedVersion: null,
      note: "Listed in the official ACP registry; no current Moss chat integration is established by this listing."
    },
    "codex-acp": {
      status: "supported-tested-route",
      chatSupported: true,
      providerKind: "openai",
      testedVersion: "1.10.0",
      note: "Moss declares this pinned adapter chat-ready. Registry discovery versions are separate; selecting an entry must not upgrade the tested route."
    },
    "cortex-code": {
      status: "integration-needed",
      chatSupported: false,
      providerKind: null,
      testedVersion: null,
      note: "Listed in the official ACP registry; no current Moss chat integration is established by this listing."
    },
    "corust-agent": {
      status: "integration-needed",
      chatSupported: false,
      providerKind: null,
      testedVersion: null,
      note: "Listed in the official ACP registry; no current Moss chat integration is established by this listing."
    },
    "crow-cli": {
      status: "integration-needed",
      chatSupported: false,
      providerKind: null,
      testedVersion: null,
      note: "Listed in the official ACP registry; no current Moss chat integration is established by this listing."
    },
    cursor: {
      status: "integration-needed",
      chatSupported: false,
      providerKind: null,
      testedVersion: null,
      note: "Listed in the official ACP registry; no current Moss chat integration is established by this listing."
    },
    deepagents: {
      status: "integration-needed",
      chatSupported: false,
      providerKind: null,
      testedVersion: null,
      note: "Listed in the official ACP registry; no current Moss chat integration is established by this listing."
    },
    devin: {
      status: "integration-needed",
      chatSupported: false,
      providerKind: null,
      testedVersion: null,
      note: "Listed in the official ACP registry; no current Moss chat integration is established by this listing."
    },
    dimcode: {
      status: "integration-needed",
      chatSupported: false,
      providerKind: null,
      testedVersion: null,
      note: "Listed in the official ACP registry; no current Moss chat integration is established by this listing."
    },
    dirac: {
      status: "integration-needed",
      chatSupported: false,
      providerKind: null,
      testedVersion: null,
      note: "Listed in the official ACP registry; no current Moss chat integration is established by this listing."
    },
    "factory-droid": {
      status: "integration-needed",
      chatSupported: false,
      providerKind: null,
      testedVersion: null,
      note: "Listed in the official ACP registry; no current Moss chat integration is established by this listing."
    },
    "fast-agent": {
      status: "integration-needed",
      chatSupported: false,
      providerKind: null,
      testedVersion: null,
      note: "Listed in the official ACP registry; no current Moss chat integration is established by this listing."
    },
    gemini: {
      status: "integration-needed",
      chatSupported: false,
      providerKind: null,
      testedVersion: null,
      note: "Gemini CLI is listed in the ACP registry. It is a different entry from Google Antigravity and does not establish current Moss chat support."
    },
    "github-copilot-cli": {
      status: "integration-needed",
      chatSupported: false,
      providerKind: null,
      testedVersion: null,
      note: "Listed in the official ACP registry; no current Moss chat integration is established by this listing."
    },
    "glm-acp-agent": {
      status: "integration-needed",
      chatSupported: false,
      providerKind: null,
      testedVersion: null,
      note: "Listed in the official ACP registry; no current Moss chat integration is established by this listing."
    },
    goose: {
      status: "integration-needed",
      chatSupported: false,
      providerKind: null,
      testedVersion: null,
      note: "Listed in the official ACP registry; no current Moss chat integration is established by this listing."
    },
    "grok-build": {
      status: "integration-needed",
      chatSupported: false,
      providerKind: null,
      testedVersion: null,
      note: "Listed in the official ACP registry; no current Moss chat integration is established by this listing."
    },
    harn: {
      status: "integration-needed",
      chatSupported: false,
      providerKind: null,
      testedVersion: null,
      note: "Listed in the official ACP registry; no current Moss chat integration is established by this listing."
    },
    junie: {
      status: "integration-needed",
      chatSupported: false,
      providerKind: null,
      testedVersion: null,
      note: "Listed in the official ACP registry; no current Moss chat integration is established by this listing."
    },
    kilo: {
      status: "integration-needed",
      chatSupported: false,
      providerKind: null,
      testedVersion: null,
      note: "Listed in the official ACP registry; no current Moss chat integration is established by this listing."
    },
    kimchi: {
      status: "integration-needed",
      chatSupported: false,
      providerKind: null,
      testedVersion: null,
      note: "Listed in the official ACP registry; no current Moss chat integration is established by this listing."
    },
    kimi: {
      status: "integration-needed",
      chatSupported: false,
      providerKind: null,
      testedVersion: null,
      note: "Listed in the official ACP registry; no current Moss chat integration is established by this listing."
    },
    "minimax-code": {
      status: "integration-needed",
      chatSupported: false,
      providerKind: null,
      testedVersion: null,
      note: "Listed in the official ACP registry; no current Moss chat integration is established by this listing."
    },
    "minion-code": {
      status: "integration-needed",
      chatSupported: false,
      providerKind: null,
      testedVersion: null,
      note: "Listed in the official ACP registry; no current Moss chat integration is established by this listing."
    },
    "mistral-vibe": {
      status: "integration-needed",
      chatSupported: false,
      providerKind: null,
      testedVersion: null,
      note: "Listed in the official ACP registry; no current Moss chat integration is established by this listing."
    },
    nova: {
      status: "integration-needed",
      chatSupported: false,
      providerKind: null,
      testedVersion: null,
      note: "Listed in the official ACP registry; no current Moss chat integration is established by this listing."
    },
    opencode: {
      status: "supported-tested-route",
      chatSupported: true,
      providerKind: "opencode",
      testedVersion: "1.18.29",
      note: "Moss declares this pinned adapter chat-ready. Registry discovery versions are separate; selecting an entry must not upgrade the tested route. Account-login reuse remains unverified in the Moss adapter row."
    },
    "pi-acp": {
      status: "integration-needed",
      chatSupported: false,
      providerKind: null,
      testedVersion: null,
      note: "Listed in the official ACP registry; no current Moss chat integration is established by this listing."
    },
    poolside: {
      status: "integration-needed",
      chatSupported: false,
      providerKind: null,
      testedVersion: null,
      note: "Listed in the official ACP registry; no current Moss chat integration is established by this listing."
    },
    qoder: {
      status: "integration-needed",
      chatSupported: false,
      providerKind: null,
      testedVersion: null,
      note: "Listed in the official ACP registry; no current Moss chat integration is established by this listing."
    },
    "qwen-code": {
      status: "integration-needed",
      chatSupported: false,
      providerKind: null,
      testedVersion: null,
      note: "Listed in the official ACP registry; no current Moss chat integration is established by this listing."
    },
    sigit: {
      status: "integration-needed",
      chatSupported: false,
      providerKind: null,
      testedVersion: null,
      note: "Listed in the official ACP registry; no current Moss chat integration is established by this listing."
    },
    stakpak: {
      status: "integration-needed",
      chatSupported: false,
      providerKind: null,
      testedVersion: null,
      note: "Listed in the official ACP registry; no current Moss chat integration is established by this listing."
    },
    vtcode: {
      status: "integration-needed",
      chatSupported: false,
      providerKind: null,
      testedVersion: null,
      note: "Listed in the official ACP registry; no current Moss chat integration is established by this listing."
    }
  };
  const notesReady = (s) => s.notes === "ready" || Boolean(s.savedNotes);
  function summary(s) {
    const aiStates = {
      "integration-needed": ["Saved selection · chat capability unverified", "attention"],
      connected: ["Demo model ready", "connected"],
      "no-chat": ["Background configured · chat unavailable", "attention"],
      awaiting: ["Awaiting provider sign-in", "pending"],
      failed: ["Connection failed · needs attention", "attention"],
      unavailable: ["Provider catalog unverified", "attention"]
    };
    const noteStates = {
      "recreate-failed": ["Host is not back online · needs attention", "attention"],
      ready: [
        s.notesChoice === "existing" ? "Existing vault · read & write" : "Moss-managed folder",
        "connected"
      ],
      pending: ["Host step waiting", "pending"],
      checking: ["Folder check pending", "pending"],
      "read-only": ["Read-only folder · needs attention", "attention"],
      "browse-error": ["Folder availability unverified", "attention"],
      "verify-failed": ["Write check failed · needs attention", "attention"],
      browse: ["Folder choice in progress", "pending"]
    };
    const emailStates = {
      unavailable: ["Email service unreachable · needs attention", "attention"],
      connected: [
        s.emailSync === "ready" ? "Demo connected · sync ready" : "Demo connected · sync pending",
        "connected"
      ],
      awaiting: ["Awaiting email sign-in", "pending"],
      failed: ["Connection failed · needs attention", "attention"]
    };
    const row = (label, item, fallback) => ({
      label,
      value: (item || fallback)[0],
      state: (item || fallback)[1]
    });
    let ai = aiStates[s.ai],
      notes = noteStates[s.notes],
      email = emailStates[s.email];
    if (s.providers?.length && s.ai === "connected")
      ai = [s.providers.map((p) => p.name).join(", ") + " · demo ready", "connected"];
    if (s.savedAi && s.ai !== "connected")
      ai = [
        `${s.savedAi.provider} remains ready · replacement ${s.ai === "awaiting" ? "pending" : s.ai === "failed" ? "failed" : "not applied"}`,
        "attention"
      ];
    if (s.savedNotes && s.hostChangePending)
      notes = [`${s.savedNotes.root} remains ready · folder change pending`, "attention"];
    if (s.savedNotes && s.notes !== "ready")
      notes = [`${s.savedNotes.root} remains ready · replacement not applied`, "attention"];
    if (s.savedEmail && s.email !== "connected")
      email = [`${s.savedEmail} remains connected · replacement not applied`, "attention"];
    return [
      row("Your account", s.account ? ["Demo owner created", "connected"] : null, [
        "Not created",
        "later"
      ]),
      row("AI assistance", ai, [
        s.skipped.includes(3) ? "Skipped for now" : "Add when you’re ready",
        "later"
      ]),
      row("Your notes", notes, [
        s.skipped.includes(4) ? "Skipped for now" : "Set up later",
        "later"
      ]),
      row("Email", email, [s.skipped.includes(5) ? "Skipped for now" : "Add later", "later"]),
      row(
        "News",
        s.news.length || s.newsCustom?.length
          ? [
              [...s.news, ...(s.newsCustom || []).map((t) => t.label)].join(", ") +
                (s.newsUnverified ? " · catalog unverified" : ""),
              s.newsUnverified ? "attention" : "connected"
            ]
          : null,
        ["Default sources · no custom topics", "later"]
      ),
      row(
        "Sports",
        s.sports.length
          ? [
              s.sports.join(", ") + (s.sportsUnverified ? " · catalog unverified" : ""),
              s.sportsUnverified ? "attention" : "connected"
            ]
          : null,
        ["No teams yet", "later"]
      )
    ];
  }

  const cssEscape = (value) =>
    globalThis.CSS?.escape
      ? CSS.escape(String(value))
      : String(value).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c);
  const $ = (selector) => document.querySelector(selector);
  let state = initialState();
  let fault = "";
  let error = "";
  let saved = false;
  let saveFailed = false;
  let notesHostClosed = false;
  let exitMode = false;
  let lastFocus = null;
  const icons = {
    check: '<path d="m5 12 4 4L19 6"/>',
    arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
    folder: '<path d="M3 7h6l2 2h10v11H3zM3 7V4h7l2 3h9v2"/>',
    note: '<path d="M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h5"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 1v2m0 18v2M1 12h2m18 0h2M4.2 4.2l1.4 1.4m12.8 12.8 1.4 1.4M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="1"/><path d="m3 6 9 7 9-7"/>',
    globe:
      '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
    brain:
      '<path d="M12 6c-1-5-8-3-7 2-4 2-3 7 0 8-1 4 4 6 7 3 3 3 8 1 7-3 3-1 4-6 0-8 1-5-6-7-7-2zm0 0v13M5 8l3 1m11-1-3 1M5 16l3-1m11 1-3-1"/>',
    flag: '<path d="M5 22V3m0 0c5-3 9 3 14 0v10c-5 3-9-3-14 0"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',
    book: '<path d="M12 5C8 2 4 3 2 4v15c3-1 7-1 10 2 3-3 7-3 10-2V4c-2-1-6-2-10 1zm0 0v16"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
    sport:
      '<circle cx="12" cy="12" r="9"/><path d="m8 3 4 5 4-5M3 11l6 1 3-4 3 4 6-1M6 19l3-7m6 0 3 7m-9-7 3 5 3-5"/>',
    location:
      '<path d="M19 10c0 6-7 12-7 12S5 16 5 10a7 7 0 1 1 14 0z"/><circle cx="12" cy="10" r="2"/>'
  };
  const icon = (name) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.info}</svg>`;
  const button = (text, action, kind = "primary", extra = "") =>
    `<button class="btn ${kind === "primary" ? "btn-primary" : kind === "quiet" ? "btn-quiet" : ""}" type="button" data-action="${action}" ${extra}>${text}</button>`;
  const note = (title, body, tone = "", symbol = "info") =>
    `<div class="status-note ${tone}" ${tone === "error" ? 'role="alert"' : ""}>${icon(symbol)}<div><strong>${title}</strong>${body ? `<p>${body}</p>` : ""}</div></div>`;
  const intro = (eyebrow, title, body) =>
    `<div class="intro"><p class="eyebrow">${eyebrow}</p><h1 id="screen-title" tabindex="-1">${title}</h1>${body ? `<p class="lede">${body}</p>` : ""}</div>`;
  const help = (label, body) =>
    `<details class="context-help"><summary>${label}</summary><div class="help-body">${body}</div></details>`;
  const art = (kind = "welcome") =>
    `<div class="park-art" aria-hidden="true"><img src="assets/park-${kind}.svg" alt="" width="240" height="140"></div>`;
  const announce = (text) => {
    $("#announcer").textContent = text;
  };
  function save() {
    saved = !["save", "offline"].includes(fault);
    saveFailed = !saved;
    document
      .querySelectorAll(".save-label")
      .forEach(
        (el) => (el.textContent = saved ? "Demo choices kept in this tab" : "Simulated save failed")
      );
    return saved;
  }
  function go(step) {
    if (step !== 8) state.accessPanel = "";
    if (step > 0 && !installationReady(state)) {
      state.step = 0;
      error = "Prepare Moss and verify a protected browser connection before continuing.";
      render();
      return false;
    }
    if (state.transport !== "secure" && step > 0) {
      error = "This connection is not verified. Setup stays paused.";
      render();
      return false;
    }
    if (fault === "offline" || fault === "save") {
      error =
        fault === "offline"
          ? "You’re offline in this scenario. Your earlier choices are still here. Reconnect and try saving again."
          : "That save didn’t go through. Your choices are still here. Try again when you’re ready.";
      render();
      return false;
    }
    const oldStep = state.step;
    state.step = step;
    state.furthest = Math.max(state.furthest || 0, step);
    error = "";
    exitMode = false;
    if (!save()) {
      state.step = oldStep;
      error =
        "Your latest changes could not be kept in this tab. Keep this tab open and retry; setup has not advanced.";
      render();
      return false;
    }
    history.pushState(
      {
        step,
        installPanel: step === 0 ? state.installPanel : undefined,
        personalPanel: step === 2 ? state.personalPanel || "names" : undefined
      },
      ""
    );
    render();
    return true;
  }
  function commitStep(change, step) {
    const previous = JSON.parse(JSON.stringify(state));
    change();
    if (go(step)) return true;
    state = previous;
    render();
    return false;
  }
  function finish() {
    if (fault === "finish") {
      error = "Your setup is still here. Finishing didn’t go through, so Today hasn’t opened yet.";
      render();
      return;
    }
    commitStep(() => {
      state.completed = true;
    }, 9);
  }
  function applyTheme() {
    document.documentElement.dataset.theme = state.theme;
    document.documentElement.dataset.colorMode = state.mode;
  }
  function progressStatus(step) {
    if (step === 1) return state.account ? "Saved" : "Required";
    if (step === 2) return state.furthest > 2 ? "Saved" : state.step === 2 ? "In progress" : "";
    const item = summary(state)[{ 3: 1, 4: 2, 5: 3, 6: 4, 7: 5 }[step]];
    if (item.state === "connected") return "Saved";
    if (item.state === "attention") return "Needs attention";
    if (item.state === "pending") return "In progress";
    if (state.skipped.includes(step)) return "Skipped";
    return state.step === step ? "Optional" : "";
  }
  function rail() {
    const stages = [
      [1, "Account"],
      [2, "You"],
      [3, "AI"],
      [5, "Email"],
      [6, "News"],
      [7, "Sports"]
    ];
    const index = stages.findIndex(([step]) => step === state.step),
      number = index + 1;
    const storageLabel = saved
      ? "Demo choices kept in this tab"
      : saveFailed
        ? "Latest demo changes are not saved"
        : "Demo choices last only in this tab";
    return `<details class="setup-progress"><summary><span>${index >= 0 ? `<b>${String(number).padStart(2, "0")}</b> / 06 <span class="progress-name">${stages[index][1]}</span>` : "Your setup"}</span><span class="progress-ticks" aria-hidden="true">${stages.map(([step]) => `<i class="${state.furthest >= step ? "passed" : ""} ${state.step === step ? "active" : ""}"></i>`).join("")}</span><span class="sr-only">Open setup progress</span></summary><div class="progress-body"><p class="install-saved">Moss prepared · demo</p><ol>${stages.map(([step, label], i) => `<li><button type="button" class="step-link" data-step="${step}" ${state.step === step ? 'aria-current="step"' : ""} ${Math.max(state.step, state.furthest || 0) < step ? "disabled" : ""}><span>${String(i + 1).padStart(2, "0")} · ${label}</span><small>${progressStatus(step)}</small></button></li>`).join("")}</ol><p class="save-label">${storageLabel}</p>${state.account ? `<div class="progress-options"><button class="text-button" data-action="save-leave">Save and leave</button><button class="text-button" data-action="finish-early">Finish with these choices</button></div>` : ""}</div></details>`;
  }

  function footer(
    next = "Continue",
    action = "next",
    { skip = false, back = true, extra = "", secondary = "" } = {}
  ) {
    return `<div class="actions">${back ? button("Back", "back", "quiet") : "<span></span>"}<div class="action-end">${skip ? button("Skip for now", "skip", "quiet") : ""}${secondary}${button(`${next} <span class="arrow" aria-hidden="true">→</span>`, action, "primary", extra)}</div></div>`;
  }

  function connection() {
    const copy =
      state.transport === "unknown"
        ? "We couldn’t verify this connection. Try again before entering account details."
        : state.transport === "certificate"
          ? "The browser reports a certificate problem. Don’t bypass its warning."
          : "The first-owner claim uses a protected local route, SSH tunnel, or verified HTTPS. Set up wider browser access after the owner claim is closed.";
    return `${intro("CONNECTION CHECK", "Protect the first-owner setup.", copy)}<div class="stacked-choices">${button("I’m on the Moss computer", "host-local", "secondary")}${button("Moss runs on another device", "remote-help", "secondary")}</div>${help("Already using trusted HTTPS?", `<p>A trusted local certificate or private network route can work too. A domain is optional.</p>${button("Simulate a verified secure connection", "secure", "secondary")}`)}${help("Why setup is paused", "<p>A private network and Docker do not encrypt this browser connection. The new-owner claim stays blocked until the protected bootstrap route is verified. Existing LAN browser access is a separate, explicit choice near the end.</p><p>This is a simulated gate. Never bypass a browser certificate warning.</p>")}${footer("Check connection again", "recheck")}`;
  }
  const routeNames = {
    local: "This computer",
    remote: "Another computer or home server",
    manual: "I’ll manage Docker myself",
    legacy: "Existing Moss demo"
  };
  const platformNames = { macos: "Mac", windows: "Windows", linux: "Linux" };
  function installerPanel(panel) {
    const previous = state.installPanel;
    state.installPanel = panel;
    error = "";
    if (!save()) {
      state.installPanel = previous;
      error = "Your setup choices have not saved. Retry before continuing.";
      render();
      return false;
    }
    history.pushState({ step: 0, installPanel: panel }, "");
    render();
    return true;
  }
  function installerTransition(changes, panel) {
    const previous = JSON.parse(JSON.stringify(state));
    Object.assign(state, changes);
    if (!installerPanel(panel)) {
      state = previous;
      render();
      return false;
    }
    return true;
  }
  function invalidateHostDraft() {
    if (state.installStatus === "running" || state.installStatus === "needs-update") {
      state.hostChangePending = true;
      state.installStatus = "needs-update";
      state.protectedContinuation = false;
    }
  }
  function hostFolderFixture() {
    return state.setupRoute === "local"
      ? "Sample notes folder on this computer"
      : "Sample notes folder on the Linux host";
  }
  function hostNotes() {
    const local = state.setupRoute === "local",
      native = local && state.hostPlatform !== "linux";
    const choices = `<div class="notes-choice"><button class="choice" data-host-notes="existing" aria-pressed="${state.hostNotesChoice === "existing"}">${icon("folder")}<span><strong>Use my existing notes</strong><small>Obsidian or Markdown folder</small></span></button><button class="choice" data-host-notes="managed" aria-pressed="${state.hostNotesChoice === "managed"}">${icon("note")}<span><strong>Start a private Moss folder</strong><small>Created on the chosen host</small></span></button></div>`;
    const existing = state.hostNotesChoice === "existing";
    return `${intro("INSTALL · YOUR NOTES", "Your notes, already at home.", "Keep your notes in the apps you already use. Use this to give Moss more context about you if you have it.")}${choices}${existing ? `<p class="hint">${native ? "The real installer opens a native folder picker on this computer." : local ? "The Linux helper asks for a path on this computer. A desktop is not required." : "Choose a path in the helper on your Linux server. A picker on this laptop cannot select that folder."}</p>${state.hostFolder ? `<p class="host-path">${esc(state.hostFolder)} · demo folder</p>` : ""}${button(native ? "Choose a folder · demo" : local ? "Choose Linux host folder · demo" : "Choose server folder · demo", "host-pick", "secondary")}` : '<p class="hint">A private folder is prepared on the Moss host.</p>'}<p class="hint">Only this folder becomes available after account setup for owner-scoped reading and writing. This preview opens no files.</p>${footer("Continue", "host-notes-next", { secondary: state.installReturnStep ? (!state.hostApplyStarted ? button("Keep current folder", "host-change-cancel", "quiet") : "") : button("Set up notes later", "host-notes-skip", "quiet") })}`;
  }
  function welcome() {
    if (state.transport !== "secure") return connection();
    const panel =
        state.installStatus === "needs-update" &&
        ["running", "connection"].includes(state.installPanel)
          ? "prepare"
          : state.installPanel || "route",
      local = state.setupRoute === "local",
      remote = state.setupRoute === "remote";
    if (panel === "route")
      return `${art()}${intro("WELCOME TO MOSS", "Where will Moss live?", "One small setup, in a place you choose.")}<div class="route-choices">${[
        ["local", "This computer", "Mac, Windows or Linux"],
        ["remote", "Another computer or home server", "Linux · including headless servers"],
        ["manual", "I’ll manage Docker myself", "Review the configuration on your host"]
      ]
        .map(
          ([id, name, description]) =>
            `<button class="choice route-choice" data-install-route="${id}" aria-pressed="${state.setupRoute === id}"><span><strong>${name}</strong><small>${description}</small></span><span aria-hidden="true">${state.setupRoute === id ? "✓" : "→"}</span></button>`
        )
        .join(
          ""
        )}</div>${footer("Continue", "next", { back: false })}<p class="welcome-signin"><button class="text-button" data-action="sign-in">Already set up? Sign in</button></p>`;
    if (panel === "notes") return hostNotes();
    if (panel === "host") {
      const platforms = local
        ? `<div class="platform-choices" aria-label="This computer’s platform">${Object.entries(
            platformNames
          )
            .map(
              ([id, name]) =>
                `<button class="topic" data-host-platform="${id}" aria-pressed="${state.hostPlatform === id}">${name}</button>`
            )
            .join("")}</div>`
        : '<p class="quiet-status">Linux host · Docker Engine & Compose</p>';
      const status = state.dockerStatus;
      const info =
        status === "ready"
          ? note(
              "Docker is ready in this demo.",
              "Selected host, context and runtime checked.",
              "",
              "check"
            )
          : status === "missing"
            ? note(
                "Docker is missing in this scenario.",
                "Review official setup and any terms before choosing to install it.",
                "warn"
              )
            : status === "stopped"
              ? note(
                  "Docker is installed but stopped.",
                  "Start it deliberately, then check the same host again.",
                  "warn"
                )
              : status === "wrong-context"
                ? note(
                    "This Docker context points elsewhere.",
                    "Choose the intended host before selecting its folders.",
                    "warn"
                  )
                : "";
      const action =
        status === "ready"
          ? "install-notes"
          : status === "missing"
            ? "docker-help"
            : status === "stopped"
              ? "docker-start"
              : status === "wrong-context"
                ? "docker-context"
                : "install-check";
      const label =
        status === "ready"
          ? "Choose notes"
          : status === "missing"
            ? "Review Docker setup"
            : status === "stopped"
              ? "Simulate starting Docker"
              : status === "wrong-context"
                ? "Simulate correct host selected"
                : remote
                  ? "Simulate running host helper"
                  : "Check Docker · demo";
      return `${intro("INSTALL · YOUR HOST", local ? "Let’s get this computer ready." : remote ? "Start on the Moss server." : "Bring your Docker setup.", local ? "Moss runs in Docker on this computer." : remote ? "The proposed helper runs on the Linux host, even when it has no screen." : "Review a template, then prepare the real Docker host.")}${platforms}${info}${remote ? '<p class="hint">Host helper concept only. Nothing is downloaded or run here.</p>' : ""}${!local && !remote ? button("Review demo template", "manual-template", "quiet") : ""}${footer(label, action)}`;
    }
    if (panel === "prepare")
      return `${art("trail")}${intro("INSTALL · READY TO PREPARE", "A home for Moss.", state.account ? "Review this scoped folder change before applying it." : "Review these choices before services start.")}<div class="install-recap"><p><strong>${esc(routeNames[state.setupRoute] || routeNames.legacy)}</strong> · ${esc(platformNames[state.hostPlatform] || "Linux")}</p><p class="host-path">${state.hostNotesChoice === "skip" ? "Notes: set up later" : state.hostNotesChoice === "managed" ? "Notes: private Moss folder" : esc(state.hostFolder)}</p><p>Docker ready · protected connection next</p></div><p class="hint">${state.setupRoute === "manual" ? "The real manual route applies the reviewed template on your host." : "The proposed installer prepares configuration, starts services, then checks health."} Demo only; no installation runs.</p>${state.setupRoute === "manual" ? button("Review demo template", "manual-template", "quiet") : ""}${footer(state.account ? "Prepare folder change · demo" : "Prepare Moss · demo", "install-start")}`;
    if (panel === "prepare-results")
      return `${intro("INSTALL · HEALTH CHECK", state.installStatus === "failed" ? "Moss needs another check." : "Checking the prepared host.", state.installStatus === "failed" ? "Your host and folder choices are kept. Retry the same installation." : "Services must be healthy before account or provider setup.")}<div class="install-checks"><p>${state.installStatus === "failed" ? "Needs attention" : "Awaiting simulated result"} · application and database</p><p>Same deployment identity, configuration and data volumes</p></div><p class="hint">No timer stands in for a health check. No real processes are started.</p>${footer(state.installStatus === "failed" ? "Retry demo preparation" : "Simulate health checks passed", state.installStatus === "failed" ? "install-start" : "install-health")}`;
    return `${art("trail")}${intro("INSTALL · MOSS IS RUNNING", "Now, make it yours.", state.protectedContinuation ? "Your protected demo connection is ready." : "Continue through a protected browser connection.")}<p class="hint">${local ? "The installer opens its verified local browser route." : "The real host helper continues through trusted HTTPS or your existing SSH local forward. It does not collect SSH credentials or expose setup over LAN HTTP."}</p>${!state.protectedContinuation ? help("What is being verified?", "<p>The same installation, a healthy backend and a protected connection. A proposed one-use owner claim stays bound to that installation. This is a simulation, not a generated claim or running helper.</p>") : ""}${footer(state.protectedContinuation ? "Continue setup" : "Continue in this browser · demo", "install-continue", { back: false })}`;
  }

  function account() {
    return `${intro("YOUR ACCOUNT", "What should I call you?", "")}<div class="field"><label class="sr-only" for="owner-name">What should I call you?</label><input id="owner-name" data-field="name" value="${esc(state.name)}" maxlength="40" autocomplete="off" aria-describedby="owner-hint"><p class="hint" id="owner-hint">Use a made-up name for this demo.</p></div><div class="field"><span class="field-label" id="password-label">Password</span><div class="mock-password" role="img" aria-labelledby="password-label password-hint"><span aria-hidden="true">••••••••••••</span><span class="badge">Demo only</span></div><p class="hint" id="password-hint">A pretend password is supplied. This preview cannot accept a real one.</p></div>${state.account ? note("Demo owner created.", "", "", "check") : ""}${footer(state.account ? "Save name and continue" : "Create demo owner account", "account")}`;
  }

  function cityResults(query = "") {
    const normalized = query.trim().toLowerCase();
    const cities = CITIES.filter((c) =>
      `${c.name} ${c.region}`.toLowerCase().includes(normalized)
    ).slice(0, 4);
    return cities.length
      ? cities
          .map(
            (c) =>
              `<button type="button" class="city-result" data-city="${c.id}" aria-pressed="${state.cityId === c.id}"><span><strong>${esc(c.name)}</strong><small>${esc(c.region)}</small></span><span aria-hidden="true">${state.cityId === c.id ? "✓" : "→"}</span></button>`
          )
          .join("")
      : '<p class="hint" role="status">No sample city found. Try London, New York, Seattle or Sydney.</p>';
  }
  function localTimeLabel(zone) {
    try {
      return new Intl.DateTimeFormat("en", {
        timeZone: zone,
        hour: "numeric",
        minute: "2-digit"
      }).format(new Date());
    } catch {
      return "Local time unavailable";
    }
  }
  function personal() {
    if (state.personalPanel !== "location")
      return `${intro("A LITTLE ABOUT YOU", `Hi, ${esc(state.name || "Alex")}, I’m Moss. But you can change my name if you want. What would you like to call me?`, "")}<div class="field"><label class="sr-only" for="assistant-name">Your assistant’s name</label><input id="assistant-name" data-field="assistant" value="${esc(state.assistant)}" maxlength="40" autocomplete="off"></div>${footer("Continue", "personal-location")}`;
    const zones = [...new Set([...CITIES.map((c) => c.timezone), "Etc/UTC"])];
    return `${intro("YOUR DAY", "Where does your day begin?", "Find your city for weather and local time.")}<div class="field search-field"><label for="city">Find your city</label><input type="search" id="city" data-city-search value="${esc(state.cityQuery || "")}" placeholder="Search a city" autocomplete="off" maxlength="60" aria-describedby="city-hint"><p class="hint" id="city-hint">Sample cities only. No device location is requested.</p></div><div class="city-results" id="city-results" aria-label="Sample city results">${cityResults(state.cityQuery || "")}</div><p class="location-summary" id="location-summary" role="status">${state.city ? `${esc(state.city)} · Weather in ${state.units === "celsius" ? "°C" : "°F"} · ${esc(state.timezone)} · ${esc(localTimeLabel(state.timezone))}${state.timezoneSource === "manual" ? " (manual)" : ""}` : `${esc(state.timezone)} · ${state.timezoneSource === "manual" ? "Manual time zone" : "Sample time zone"}`}</p>${help("Time zone & weather units", `<div class="field"><label for="timezone">Time zone override</label><select id="timezone" data-field="timezone">${!zones.includes(state.timezone) ? `<option selected value="${esc(state.timezone)}">${esc(state.timezone)}</option>` : ""}${zones.map((z) => `<option value="${z}" ${state.timezone === z ? "selected" : ""}>${z.replaceAll("_", " ")}</option>`).join("")}</select><p class="hint">${state.timezoneSource === "manual" ? "Your manual choice stays when you change cities." : state.cityId ? "Set from your chosen city. You can override it." : "Sample time zone until you choose a city."}</p>${state.timezoneSource === "manual" && state.cityId ? button("Use city time zone", "city-timezone", "quiet") : ""}</div><div class="field"><label for="units">Weather units</label><select id="units" data-field="units"><option value="fahrenheit" ${state.units !== "celsius" ? "selected" : ""}>Fahrenheit · °F</option><option value="celsius" ${state.units === "celsius" ? "selected" : ""}>Celsius · °C</option></select></div>`)}${footer("Continue", "personal", { skip: true })}`;
  }

  const providerNames = {
    claude: "Claude",
    codex: "Codex",
    opencode: "OpenCode",
    local: "Local model"
  };
  const providerRegistry = { claude: "claude-acp", codex: "codex-acp", opencode: "opencode" };
  function preserveAi() {
    if (state.ai !== "connected") return;
    const name = providerNames[state.provider] || state.provider;
    state.savedAi = { provider: name, chat: true };
    const entry = {
      id: state.provider,
      name,
      chat: true,
      method: state.aiMethod,
      model: state.model || "Demo chat model"
    };
    state.providers = [...(state.providers || []).filter((p) => p.id !== entry.id), entry];
  }
  function chooseProvider(id) {
    if (!providerNames[id]) return false;
    preserveAi();
    state.provider = id;
    state.aiMethod = id === "local" ? "local" : "account";
    const savedProvider = state.providers.find((p) => p.id === id && p.chat);
    state.ai = savedProvider ? "connected" : "idle";
    state.model = savedProvider?.model || "";
    state.registryOpen = false;
    state.registrySelection = "";
    save();
    render(false);
    return true;
  }
  function registryStatus(entry) {
    const onlyBinary = entry.runtimeKinds.length === 1 && entry.runtimeKinds[0] === "binary";
    if (onlyBinary && !entry.binaryTargets.includes(state.runtimeTarget))
      return { kind: "platform", label: "Unavailable for this runtime" };
    const support = ACP_SUPPORT[entry.id];
    if (support?.status === "supported-tested-route")
      return { kind: "supported", label: "Supported Moss route" };
    return { kind: "integration", label: "Moss integration needed" };
  }
  function registryRows() {
    const query = (state.registryQuery || "").trim().toLowerCase();
    const items = ACP_REGISTRY.filter((x) =>
      `${x.name} ${x.description} ${x.publisher.join(" ")}`.toLowerCase().includes(query)
    );
    return items.length
      ? items
          .map(
            (x) =>
              `<button class="registry-row" data-registry-id="${esc(x.id)}"><span><strong>${esc(x.name)}</strong><small>${esc(registryStatus(x).label)}</small></span><span aria-hidden="true">→</span></button>`
          )
          .join("")
      : '<p class="hint" role="status">No agents match this search.</p>';
  }
  function registryView() {
    const entry = ACP_REGISTRY.find((x) => x.id === state.registrySelection);
    if (entry) {
      const status = registryStatus(entry),
        support = ACP_SUPPORT[entry.id],
        provider = Object.keys(providerRegistry).find((k) => providerRegistry[k] === entry.id);
      return `${intro("ACP AGENT", esc(entry.name), esc(entry.description))}${note(status.label, status.kind === "supported" ? `Moss uses tested adapter ${esc(support.testedVersion)}. Installation, sign-in and model availability still need a check.` : status.kind === "platform" ? `No binary is listed for the demo runtime ${esc(state.runtimeTarget)}.` : "A registry listing does not establish a supported Moss chat route.", status.kind === "supported" ? "" : "warn")}<p class="hint">Registry version ${esc(entry.version)} · discovery only. Selecting this entry never upgrades Moss.</p>${entry.id === "opencode" ? '<p class="hint">OpenCode account-login reuse remains unverified.</p>' : ""}${entry.id === "gemini" || entry.id === "antigravity-acp" ? '<p class="hint">Gemini CLI and Antigravity are separate entries. Neither is verified as a ready Moss chat path.</p>' : ""}<div class="registry-links">${entry.website ? `<span>Official project reference in attribution</span>` : ""}${entry.license ? `<span>License: ${esc(entry.license)}</span>` : ""}</div>${footer(status.kind === "supported" ? "Use tested route · demo" : "Browse other agents", status.kind === "supported" ? "registry-use" : "registry-back", { secondary: button("Featured providers", "registry-close", "quiet"), extra: provider ? "" : status.kind === "supported" ? "disabled" : "" })}`;
    }
    return `${intro("ACP DISCOVERY", "Find an agent.", "Registry entries are discovery, not a promise of Moss compatibility.")}<div class="field search-field"><label class="sr-only" for="agent-search">Search all ACP agents</label><input type="search" id="agent-search" data-field="registryQuery" value="${esc(state.registryQuery || "")}" placeholder="Search agents" autocomplete="off" maxlength="100"></div><p class="hint">${ACP_REGISTRY.length} agents · pinned ${esc(ACP_SOURCE.retrievedAt.slice(0, 10))} · runtime ${esc(state.runtimeTarget)}</p><div id="registry-results" class="registry-results">${registryRows()}</div><p class="hint"><a href="provenance.json">Snapshot sources and capability limits</a></p>${footer("Back to featured", "registry-close", { back: false })}`;
  }
  function ai() {
    if (state.registryOpen) return registryView();
    const local = state.aiMethod === "local",
      name = providerNames[state.provider] || "Claude";
    let panel = "",
      label = local ? "Explore local setup · demo" : `Connect ${name} · demo`,
      action = "ai-connect";
    if (state.ai === "connected") {
      panel = note(
        `${name} is ready in this demo.`,
        "Model capability verified only in the simulation.",
        "",
        "check"
      );
      label = "Continue";
      action = "next";
    } else if (state.ai === "no-chat") {
      panel = note(
        "Background help is configured.",
        "Chat is not ready. A saved API key alone doesn’t enable it.",
        "warn"
      );
      label = "Continue";
      action = "next";
    } else if (state.ai === "awaiting") {
      panel = local
        ? note(
            "Proposed local chat setup.",
            "A compatible local endpoint through OpenCode, or a separately implemented Ollama route, needs runtime proof. Inside Docker, localhost means the container. No endpoint is contacted.",
            "info",
            "clock"
          )
        : note(
            state.provider === "opencode"
              ? "Check OpenCode setup."
              : `Waiting for ${name} sign-in.`,
            state.provider === "opencode"
              ? "The tested adapter exists; account-login reuse is unverified. The demo supplies model readiness."
              : "The real authorization opens your system browser. The demo supplies installed-adapter and sign-in checks.",
            "info",
            "clock"
          );
      panel += button("Cancel demo setup", "ai-cancel", "quiet");
      label = local
        ? "Simulate proposed local readiness"
        : state.provider === "opencode"
          ? "Simulate verified model"
          : "Simulate approved sign-in";
      action = "ai-approved";
    } else if (state.ai === "failed") {
      panel = note(
        "That connection didn’t go through.",
        "Your other providers are kept. Try again or continue later.",
        "error"
      );
      label = "Retry demo connection";
    } else if (state.ai === "integration-needed") {
      panel = note(
        "This saved provider needs integration review.",
        "Your selection is kept, but current chat capability is unverified. Choose a supported route to continue.",
        "warn"
      );
      label = "Choose a supported provider";
      action = "ai-choose";
    } else if (state.ai === "unavailable") {
      panel = note(
        "The provider catalog is unavailable.",
        "We haven’t treated it as an empty list.",
        "error"
      );
      label = "Reload demo catalog";
      action = "ai-reload";
    } else if (local)
      panel =
        '<p class="hint local-capability">Ollama or a compatible local endpoint. Chat is proposed work, not verified current capability.</p>';
    const chooser = `<div class="choice-grid provider-grid" aria-label="Featured AI providers">${Object.entries(
      providerNames
    )
      .map(
        ([id, n]) =>
          `<button type="button" class="choice provider-choice" aria-pressed="${state.provider === id}" data-provider="${id}"><span class="choice-icon provider-logo" aria-hidden="true"><img src="assets/providers/${id === "codex" ? "openai" : id === "local" ? "ollama" : id}.svg" alt="" width="30" height="30"></span><strong>${n}</strong>${id === "local" ? "<small>Proposed chat path</small>" : ""}</button>`
      )
      .join("")}</div>`;
    const savedList = state.providers.length
      ? `<p class="provider-summary">Saved in this demo: ${state.providers.map((p) => esc(p.name) + (p.chat ? "" : " · capability unverified")).join(", ")}</p>`
      : "";
    return `${intro("AI ASSISTANCE", `Give ${esc(state.assistant || "Moss")} a little brainpower.`, "Choose a featured provider, or explore the agent registry.")}${["connected", "awaiting", "no-chat"].includes(state.ai) ? help("Choose another provider", chooser) : chooser}${button("Browse all ACP agents", "registry-open", "quiet")}${savedList}${state.savedAi && state.ai !== "connected" ? `<p class="saved-draft">Your saved ${esc(state.savedAi.provider)} connection remains ready until another is verified.</p>` : ""}${panel}${footer(label, action, { skip: state.ai !== "connected", secondary: state.ai === "connected" ? button("Add another AI provider", "ai-add", "quiet") : "" })}`;
  }

  function notes() {
    if (
      ["pending", "checking", "verify-failed", "recreate-failed"].includes(state.notes) &&
      !notesHostClosed
    )
      return notesHost();
    let area = "",
      label = "Connect my existing folder",
      action = "notes-browse",
      extra = "";
    const choices = `<div class="notes-choice"><button class="choice" aria-pressed="${state.notesChoice === "existing"}" data-notes-choice="existing"><span class="choice-icon">${icon("folder")}</span><span><strong>Use my existing notes</strong><small>Obsidian or Markdown · read & write</small></span><span class="choice-check" aria-hidden="true">${state.notesChoice === "existing" ? "✓" : ""}</span></button><button class="choice" aria-pressed="${state.notesChoice === "managed"}" data-notes-choice="managed"><span class="choice-icon">${icon("note")}</span><span><strong>Start a Moss folder</strong><small>A private place for your notes</small></span><span class="choice-check" aria-hidden="true">${state.notesChoice === "managed" ? "✓" : ""}</span></button></div>`;
    if (state.notes === "ready") {
      area = note(
        "Your notes folder is ready in this demo.",
        `${esc(state.notesRoot || "Personal vault")} · simulated read-and-write check passed.`,
        "",
        "check"
      );
      label = "Continue";
      action = "next";
    } else if (["pending", "checking", "verify-failed", "recreate-failed"].includes(state.notes)) {
      area = note(
        "Your host step is still waiting.",
        "Resume when the folder is available.",
        "info",
        "clock"
      );
      label = "Resume host setup";
      action = "notes-host";
    } else if (state.notes === "browse") {
      area = `<p class="hint">Choose an existing folder available to Moss. Your notes stay in your current app.</p><div class="tree"><button class="folder-row ${state.notesRoot === "Personal vault" ? "selected" : ""}" data-root="Personal vault">${icon("folder")}<span>Personal vault<small>Markdown + Obsidian</small></span><span class="badge">Read & write</span></button><button class="folder-row ${state.notesRoot === "Reference archive" ? "selected" : ""}" data-root="Reference archive">${icon("folder")}<span>Reference archive<small>Markdown</small></span><span class="badge warn">Read only</span></button></div><button class="text-button" data-action="notes-host">Connect a folder not listed</button>`;
      label = "Use this demo folder";
      action = "notes-use";
      extra = state.notesRoot ? "" : "disabled";
    } else if (state.notes === "read-only") {
      area = note(
        "This folder is read-only.",
        "Choose another folder to create and update notes.",
        "warn"
      );
      label = "Choose a different folder";
    } else if (state.notes === "browse-error") {
      area = note(
        "We couldn’t read the folder list.",
        "Your saved choice is kept. Availability is unverified.",
        "error"
      );
      label = "Retry folder list";
    } else if (state.notesChoice === "managed") {
      label = "Create my demo notes folder";
      action = "notes-managed";
    }
    const initial = ["idle", "read-only", "browse-error"].includes(state.notes);
    return `${intro("YOUR NOTES", state.notes === "browse" ? "Where are your notes?" : "Your notes, already at home.", "Keep your notes in the apps you already use. Use this to give Moss more context about you if you have it.")}${initial ? choices : help("Change notes source", choices)}${state.savedNotes && state.notes !== "ready" ? `<p class="saved-draft">${esc(state.savedNotes.root)} remains the saved source until a replacement is verified.</p>` : ""}${area}${help("What can Moss access?", "<p>Only your configured folder. Existing notes stay in place and support reading and writing. Selecting a source doesn’t authorize arbitrary edits or deletion.</p><p>The picker lists server-mounted folders, not files on this browser’s device. A Moss-managed folder is private to this account on the Moss host. The demo doesn’t access any files.</p>")}${footer(label, action, { skip: true, extra })}`;
  }
  function notesHost() {
    const panel =
      state.notes === "recreate-failed"
        ? note(
            "Moss hasn’t come back after the host step.",
            "Check the instance on the Moss computer, then retry. This is a simulated recreate failure.",
            "error"
          )
        : state.notes === "verify-failed"
          ? note(
              "The folder isn’t ready yet.",
              "The simulated write check failed. Check its mount and permissions, then retry.",
              "error"
            )
          : "";
    return `${intro("YOUR NOTES · CONNECT A FOLDER", "Connect your existing folder.", "Your notes stay where they are. Moss gets access to this folder only.")}${panel}<ol class="host-steps"><li><strong>Find the folder on the Moss computer.</strong><p>It may be a different device from this browser.</p></li><li><strong>Make that folder available to Moss.</strong><p>A trusted host helper would add a scoped mount. This helper is proposed, not installed by this preview.</p></li><li><strong>Return and check access.</strong><p>Verify reading and writing before saving the connection.</p></li></ol>${help("Host setup details", "<p>An installed, trusted helper must verify the same owner and instance and preserve configuration, keys and data volumes. Never run a helper from an untrusted LAN page.</p><p>A Docker mount change requires container recreation; restart alone won’t apply it. A browser file picker cannot add the server mount. No secrets belong in commands or URLs.</p>")}<p class="hint">Demo only. No folder is opened and no command runs.</p><div class="contextual-actions">${button("Simulate restart & resume", "restart", "quiet")}${button("Continue without notes", "notes-later", "quiet")}</div>${footer(state.notes === "recreate-failed" ? "Retry simulated server & folder check" : state.notes === "verify-failed" ? "Retry simulated verification" : "Simulate host setup and return", "notes-verify")}`;
  }

  const emailProviders = ["Google", "Yahoo", "Proton Bridge", "iCloud", "Fastmail"];
  function email() {
    const p = state.emailProvider || "Google";
    const info =
      p === "Google"
        ? "Google currently needs your own Desktop OAuth app setup and a manual return-URL step. Requested scopes include Gmail modify and Calendar access. Review them in the real consent screen."
        : p === "Proton Bridge"
          ? "Proton Bridge must be reachable from the Moss host. Localhost inside its container is not this browser’s computer. Use the credentials shown by Bridge only in the real, protected setup."
          : `${p} uses its supported account or app-password setup. The real flow must use a verified secure connection.`;
    let panel = "",
      label = state.email === "failed" ? "Retry demo email connection" : "Connect email · demo",
      action = "email-connect";
    if (state.email === "connected") {
      panel = note(
        "Your demo inbox is connected.",
        state.emailSync === "ready"
          ? "Simulated sync ready. No actual mail was read."
          : "Initial sync pending. No actual mail was read.",
        "",
        "check"
      );
      label = "Continue";
      action = "next";
    } else if (state.email === "awaiting") {
      panel =
        note("Waiting for the demo sign-in.", "No real provider was opened.", "info", "clock") +
        button("Cancel", "email-cancel", "quiet");
      label = "Simulate approved access";
      action = "email-approved";
    } else if (state.email === "unavailable")
      panel = note(
        "The email service isn’t reachable.",
        "Check that the service is reachable from the Moss host.",
        "warn"
      );
    else if (state.email === "failed")
      panel = note(
        "The inbox connection needs another try.",
        "Your other choices are still saved.",
        "error"
      );
    return `${intro("EMAIL · OPTIONAL", "Bring your inbox along.", "Connect email for a little more context in your day.")}<div class="field"><label for="email-provider">Email provider</label><select id="email-provider" data-field="emailProvider">${emailProviders.map((x) => `<option ${p === x ? "selected" : ""}>${x}</option>`).join("")}</select><p class="hint permission-summary">${p === "Google" ? "Requested access: Gmail modify and Calendar." : "Review the requested mailbox access before approving."} Sending email is a separate action.</p></div>${state.savedEmail && state.email !== "connected" ? `<p class="saved-draft">${esc(state.savedEmail)} remains connected until a replacement is verified.</p>` : ""}${panel}${help("Setup and permissions", `<p>${info}</p><p>Review the requested access before authorizing. Connecting email does not grant permission to send messages. This preview simulates every step and never accepts credentials.</p>`)}${footer(label, action, { skip: state.email !== "connected" })}`;
  }

  const topics = [
    ["World", "The wider picture", "globe"],
    ["Technology", "What’s changing", "brain"],
    ["Science", "Discoveries and ideas", "sun"],
    ["U.S.", "Across the United States", "flag"],
    ["Politics", "Policy and public life", "book"],
    ["Business", "Economy and enterprise", "book"],
    ["Culture", "Arts, books, and more", "note"],
    ["Health", "Research and wellbeing", "location"]
  ];
  function news() {
    if (fault === "news-read")
      return `${intro("NEWS · OPTIONAL", "Your news choices are still here.", "We couldn’t refresh the sample topic catalog.")}${note("Catalog status is unverified.", `Saved topics: ${state.news.length ? esc(state.news.join(", ")) : "none selected before this attempt"}. A failed read has not cleared them.`, "error")}${footer("Retry demo catalog", "clear-fault", { skip: true })}`;
    if (state.topicEditing)
      return `${intro("NEWS · YOUR OWN TOPIC", "What would you like to follow?", "A subject, a place, or something you’re curious about.")}<div class="field"><label for="topic-label">Topic</label><input id="topic-label" data-field="topicLabel" value="${esc(state.topicLabel || "")}" maxlength="80" autocomplete="off" placeholder="For example, urban gardening"></div><div class="field"><label for="topic-guidance">What should we include or leave out? <span class="optional-label">Optional</span></label><textarea id="topic-guidance" data-field="topicGuidance" maxlength="1000" rows="3">${esc(state.topicGuidance || "")}</textarea></div>${!newsTopicsReady(state) ? note("Topic setup needs a check.", "Custom topics need both a structured-output AI model and working web search. Chat alone doesn’t prove those are ready.", "warn") : '<p class="hint">AI and web-search readiness are simulated. No search or topic check runs here.</p>'}${footer(newsTopicsReady(state) ? "Add demo topic" : "Check topic setup · demo", newsTopicsReady(state) ? "topic-add" : "news-check", { secondary: button("Cancel", "topic-cancel", "quiet"), back: false })}`;
    return `${intro("NEWS · OPTIONAL", "What would you like to read?", "Pick a few topics, or add one of your own.")}<div class="topic-list news-topics" aria-label="News topics">${topics.map(([title]) => `<button class="topic" type="button" aria-pressed="${state.news.includes(title)}" data-topic="${title}"><strong>${title}</strong><span class="select-check" aria-hidden="true">✓</span></button>`).join("")}</div>${state.newsCustom.length ? `<div class="custom-topics">${state.newsCustom.map((t) => `<div class="custom-topic"><p class="custom-topic-copy" data-topic-id="${esc(t.id)}"><strong>${esc(t.label)}</strong>${t.guidance ? `<span>${esc(t.guidance)}</span>` : ""}</p><button class="text-button" data-remove-topic="${esc(t.id)}" aria-label="Remove custom topic">Remove</button></div>`).join("")}</div>` : ""}${button("Add another topic", "topic-open", "quiet", state.newsCustom.length >= 10 ? "disabled" : "")}<p class="preview-line">${state.news.length} suggested topics · ${state.newsCustom.length}/10 custom topics</p>${help("What happens if I skip?", "<p>Default sources stay on: BBC News, The Guardian, AP News, and NPR. Refine sources later in News. This prototype doesn’t fetch stories.</p>")}${footer("Continue", "next", { skip: true })}`;
  }

  const teams = [
    ["Dallas Cowboys", "NFL"],
    ["New England Patriots", "NFL"],
    ["Arsenal", "Premier League"],
    ["Liverpool", "Premier League"],
    ["Boston Celtics", "NBA"],
    ["Golden State Warriors", "NBA"]
  ];
  function sports() {
    if (fault === "sports-read")
      return `${intro("SPORTS · OPTIONAL", "Your teams are still here.", "We couldn’t refresh the sample team catalog.")}${note("Team catalog status is unverified.", `Saved teams: ${state.sports.length ? esc(state.sports.join(", ")) : "none selected before this attempt"}. Retry without replacing saved follows.`, "error")}${footer("Retry demo catalog", "clear-fault", { skip: true })}`;
    const query = state.teamQuery || "";
    const shown = teams.filter((x) => x.join(" ").toLowerCase().includes(query.toLowerCase()));
    return `${intro("SPORTS · OPTIONAL", "Who do you follow?", "Keep a place for the teams you care about.")}<div class="field search-field"><label class="sr-only" for="team-search">Find a team</label><input type="search" id="team-search" data-field="teamQuery" value="${esc(query)}" placeholder="Find a team" autocomplete="off" maxlength="50"></div><div class="topic-list team-list" id="team-results" aria-label="Sports teams">${teamResults(shown)}</div><p class="preview-line" id="team-count">${state.sports.length} teams selected</p>${help("About this team list", "<p>This small sample catalog shows league context. No live scores or team data are requested.</p>")}${footer("Review my setup", "next", { skip: true })}`;
  }
  function teamResults(items) {
    return items.length
      ? items
          .map(
            ([title, league]) =>
              `<button type="button" class="topic" aria-pressed="${state.sports.includes(title)}" data-team="${title}"><span><strong>${title}</strong><small>${league}</small></span><span class="select-check" aria-hidden="true">✓</span></button>`
          )
          .join("")
      : '<p class="muted" role="status">No demo teams found. Try “Arsenal”, “NBA”, or “Cowboys”.</p>';
  }
  function setupSummary() {
    return `<p class="deployment-summary">Moss running · ${esc(routeNames[state.setupRoute] || "Existing demo")} · ${state.browserConnection === "http" ? "HTTP browser connection (unencrypted)" : "protected browser connection"}</p><div class="profile-summary"><strong>${esc(state.name || "Alex")} + ${esc(state.assistant || "Moss")}</strong><span>${esc(weatherLabel(state))} · Weather ${state.units === "celsius" ? "°C" : "°F"}</span><span>${esc(state.timezone)} · ${state.timezoneSource === "manual" ? "manual time zone" : state.cityId ? "city time zone" : "sample time zone"}</span><button class="text-button" data-step="2">Edit assistant & location</button></div>${accessRecap()}${summary(
      state
    )
      .map(
        (row, i) =>
          `<div class="summary-row"><div><strong>${row.label}</strong><p>${esc(row.value)}</p></div><button class="text-button" ${i === 2 ? 'data-action="edit-host-notes"' : `data-step="${[1, 3, 4, 5, 6, 7][i]}"`}>Edit <span class="sr-only">${row.label}</span></button></div>`
      )
      .join("")}`;
  }

  const accessNames = {
    local: "This computer only",
    "lan-http": "Home network (HTTP, unencrypted)",
    https: "HTTPS"
  };
  const accessBadge = () =>
    '<p class="revision-note">Revision proposal · visual review pending</p>';
  function accessRecap() {
    return `<div class="summary-row access-recap"><div><strong>Access</strong><p>${esc(accessNames[state.accessMode] || accessNames.local)}</p>${state.accessStatus === "pending" || state.accessStatus === "failed" ? "<p>Requested change is not verified; previous access is kept.</p>" : ""}</div><button class="text-button" data-action="access-open">Use Moss from other devices</button></div>`;
  }
  function openAccess() {
    state.accessReturnStep = state.step;
    state.step = 8;
    if (!["pending", "failed"].includes(state.accessStatus))
      state.accessDraft = state.accessMode || "local";
    state.accessPanel = ["pending", "failed"].includes(state.accessStatus) ? "verify" : "choose";
    history.pushState({ step: 8, accessPanel: state.accessPanel }, "");
    save();
    render();
  }
  function access() {
    const mode = state.accessDraft || "local",
      current = state.accessMode || "local";
    if (state.accessPanel === "choose")
      return `${accessBadge()}${intro("ACCESS · OPTIONAL", "Use Moss from other devices", "Choose how you’ll open Moss on your other devices.")}<div class="route-choices">${[
        ["local", "Keep local", "Continue on this computer."],
        [
          "lan-http",
          "Home network (HTTP, unencrypted)",
          "Use a phone or computer browser on your network."
        ],
        ["https", "HTTPS", "Recommended for other devices and required for a remote companion."]
      ]
        .map(
          ([id, name, body]) =>
            `<button class="choice route-choice" data-access-mode="${id}" aria-pressed="${mode === id}"><span><strong>${name}</strong><small>${body}</small></span><span aria-hidden="true">${mode === id ? "✓" : "→"}</span></button>`
        )
        .join(
          ""
        )}</div>${mode === "lan-http" ? note("HTTP is unencrypted.", "People or software on this network may read or alter your credentials and content. Some device features need HTTPS.", "warn") : ""}${mode === "https" ? '<p class="hint">Choose a trusted HTTPS route when you’re ready. A domain, certificate setup, or Tailscale is not required to finish onboarding.</p>' : ""}<p class="hint">Current access: ${esc(accessNames[current])}. Existing deployments keep this unless you explicitly change it. A remote companion requires HTTPS; an ordinary browser can use the disclosed LAN HTTP mode.</p>${footer(mode === current ? "Continue" : "Review access change", "access-review")}`;
    if (state.accessPanel === "plan")
      return `${accessBadge()}${intro("ACCESS · REVIEW HOST PLAN", "Review the access change.", "The real installer must show the exact host, interface, port, and resulting address before asking you to apply it.")}<div class="install-recap"><p><strong>${esc(accessNames[current])} → ${esc(accessNames[mode])}</strong></p><p>Host: &lt;chosen Moss host&gt;</p><p>Bind: ${mode === "local" ? "loopback only, port 3000" : mode === "lan-http" ? "&lt;selected home-network interface&gt;, port 3000" : "&lt;reviewed HTTPS proxy interface&gt;, port 443"}</p><p class="host-path">${mode === "local" ? "http://localhost:3000" : mode === "lan-http" ? "http://&lt;moss-host&gt;:3000" : "https://&lt;trusted-moss-address&gt;"}</p><p>First-owner claim: closed before widening access.</p></div>${note("Illustrative placeholders only.", "No host, address, port, firewall rule, certificate, or account is changed by this review.", "info")}<p class="hint">${mode === "https" ? "The host plan must verify certificate trust and the selected HTTPS route. No tunnel or network service is silently installed." : mode === "lan-http" ? "The reviewed host plan must warn before widening any interface or port. Remote companions remain unavailable over this HTTP address." : "Returning to local-only access may disconnect remote browsers or companions; the real host plan must explain this before applying."}</p>${footer("Simulate applying reviewed plan", "access-apply", { secondary: button("Keep current access", "access-cancel", "quiet") })}`;
    return `${accessBadge()}${intro("ACCESS · CHECK CONNECTION", state.accessStatus === "failed" ? "The access check needs another try." : "Return through the chosen connection.", state.accessStatus === "failed" ? "The saved access mode has not been replaced. Check the same host and retry." : "Verify the same instance and owner before marking the new route ready.")}<div class="install-checks"><p>Saved checkpoint: same owner, instance, configuration, keys, and data.</p><p>Requested: ${esc(accessNames[mode])}</p><p>Previous verified access: ${esc(accessNames[current])}</p><p>${mode === "https" ? "Check HTTPS trust, host health, and same-owner session." : mode === "lan-http" ? "Check the reviewed LAN address and same-owner browser session. The connection remains unencrypted." : "Check the host-local route and same-owner session."}</p></div><p class="hint">A host-side change and connection check are required in the product. This tab only simulates their results. Get started never opens a port.</p>${footer("Simulate connection verified", "access-verify", { secondary: button("Simulate failed check", "access-fail", "quiet") })}`;
  }
  function reviewAccess() {
    if (state.accessDraft === state.accessMode) {
      state.accessPanel = "";
      go(state.accessReturnStep || 8);
      return;
    }
    if (!save()) {
      error = "The checkpoint was not saved in this scenario. Retry before reviewing the change.";
      render();
      return;
    }
    state.accessPanel = "plan";
    history.pushState({ step: 8, accessPanel: "plan" }, "");
    render();
  }
  function applyAccess() {
    if (state.accessPanel !== "plan" || !state.account || !installationReady(state)) return;
    if (!save()) {
      error = "The checkpoint was not saved. No host change is assumed.";
      render();
      return;
    }
    state.accessStatus = "pending";
    state.accessPanel = "verify";
    history.pushState({ step: 8, accessPanel: "verify" }, "");
    render();
  }
  function verifyAccess() {
    if (state.accessPanel !== "verify" || !["pending", "failed"].includes(state.accessStatus))
      return;
    if (!save()) {
      error = "The new route is not verified. Previous access is kept.";
      render();
      return;
    }
    state.accessMode = state.accessDraft;
    state.browserConnection = state.accessMode === "lan-http" ? "http" : "protected";
    state.accessStatus = "idle";
    state.accessPanel = "";
    go(state.accessReturnStep || 8);
    announce("Access check simulated. No real network settings changed.");
  }

  function ready() {
    if (state.accessPanel) return access();
    const waiting = summary(state).filter((x) => ["attention", "pending"].includes(x.state));
    return `${art("trail")}${intro("READY WHEN YOU ARE", `Your ${esc(state.assistant || "Moss")}, taking shape.`, "Everything you picked can change later.")}${waiting.length ? note(`${waiting.length} ${waiting.length === 1 ? "item is" : "items are"} still waiting.`, waiting.map((x) => `${x.label}: ${esc(x.value)}`).join("<br>"), "warn") : ""}${!aiReady(state) ? '<p class="quiet-status">Chat will wait until you connect a capable AI provider.</p>' : ""}<section class="saved-recap" aria-labelledby="recap-title"><h2 id="recap-title">Your saved choices</h2>${setupSummary()}</section>${footer(fault === "finish" ? "Try finishing" : "Get started", "finish")}`;
  }
  function today() {
    const date = new Date(),
      zone = state.timezone || "Etc/UTC";
    let formatted, hello;
    try {
      formatted = new Intl.DateTimeFormat("en", {
        timeZone: zone,
        weekday: "long",
        day: "numeric",
        month: "long"
      }).format(date);
      const hour = Number(
        new Intl.DateTimeFormat("en", { timeZone: zone, hour: "numeric", hourCycle: "h23" }).format(
          date
        )
      );
      hello = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
    } catch {
      formatted = "Your first day";
      hello = "Welcome";
    }
    return `<main class="main today-welcome" id="main" tabindex="-1"><div class="content">${art("trail")}${intro(esc(formatted), `${hello}, ${esc(state.name || "Alex")}.`, "Make yourself at home.")}<div class="welcome-action">${button(`${aiReady(state) ? "Start a chat" : "Connect AI"} <span aria-hidden="true">→</span>`, "today-start")}</div>${help("Your setup", setupSummary() + `<p class="hint">${esc(weatherLabel(state))} · Live weather is not loaded in this demo.</p><p class="hint">No messages, note editor or live briefing are shown in this preview.</p>`)}</div></main>`;
  }

  function resumeGate() {
    const gates = {
      "wrong-instance": [
        "This is a different Moss instance.",
        "Your saved setup belongs to another installation. We haven’t copied any settings here.",
        "Return to the original instance before continuing.",
        "Simulate returning to the right instance"
      ],
      "signed-out": [
        "Welcome back. Sign in to continue.",
        "The secure address has changed in this example. Sign back in to the same instance and account to resume your saved step.",
        "No real credentials are requested. Your saved progress is checked after the demo session is restored.",
        "Simulate same-owner sign-in"
      ],
      "claim-expired": [
        "This setup invitation has expired.",
        "Start again from the trusted host setup to get a fresh invitation. Your instance is not opened for anyone else to claim.",
        "The protected first-owner claim is a proposed product requirement. This demo never creates a real claim token.",
        "Simulate a fresh host invitation"
      ],
      "claim-used": [
        "This Moss already has an owner.",
        "This invitation has already been used. Sign in as the existing owner to continue, rather than making another owner account.",
        "This is a simulated already-used claim. No ownership, session, or access is changed.",
        "Simulate existing-owner sign-in"
      ]
    };
    const [title, body, help, label] = gates[state.resumeGate] || gates["signed-out"];
    return `${intro("RESUMING YOUR SETUP", title, body)}${note("Demo access check", help, "info")}${button(label, "resume-gate", "secondary")}`;
  }
  function leave() {
    return `${art("trail")}${intro("SEE YOU SOON", "Your place is kept.", "Your demo choices are kept in this tab. Refreshing resets them.")}<p class="quiet-status">Next up: ${esc(STEPS[state.step])}</p><div class="welcome-action">${button("Resume setup", "resume")}</div>${help("About saving", "<p>The real product needs durable, owner-specific progress. This review keeps choices in memory only until refresh.</p>")}`;
  }
  function render(focus = true) {
    const active = document.activeElement;
    let focusSelector = active?.id ? "#" + cssEscape(active.id) : null;
    if (!focusSelector && active?.dataset) {
      for (const key of ["provider", "method", "notesChoice", "root", "action"])
        if (active.dataset[key]) {
          focusSelector =
            "[data-" +
            key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()) +
            '="' +
            cssEscape(active.dataset[key]) +
            '"]';
          break;
        }
    }
    const openHelp = [...document.querySelectorAll("#app details[open]")].map(
      (x) => x.querySelector("summary")?.textContent
    );
    applyTheme();
    const views = [welcome, account, personal, ai, notes, email, news, sports, ready];
    const body =
      state.step === 9 &&
      !state.resumeGate &&
      state.transport === "secure" &&
      installationReady(state)
        ? today()
        : `<div class="wizard ${state.step === 0 ? "welcome-stage" : ""}">${state.step > 0 && !exitMode ? rail() : ""}<main id="main" class="main" tabindex="-1"><div class="content">${state.transport !== "secure" ? connection() : state.resumeGate ? resumeGate() : exitMode ? leave() : state.step > 0 && !installationReady(state) ? welcome() : views[state.step]()}${error ? `<div class="status-note error" role="alert">${icon("info")}<div><strong>${error}</strong><div class="transport-actions">${button("Retry with a working connection", "clear-fault", "secondary")}</div></div></div>` : ""}${saveFailed ? '<p class="save-error" role="status">Latest demo changes are not saved</p>' : ""}</div></main></div>`;
    $("#app").innerHTML = body;
    document.title = `${STEPS[state.step]} · Moss setup prototype`;
    const brand = $(".brand-name");
    if (brand) brand.textContent = state.account ? state.assistant || "Moss" : "Moss";
    if (!focus) {
      document.querySelectorAll("#app details").forEach((x) => {
        if (openHelp.includes(x.querySelector("summary")?.textContent)) x.open = true;
      });
      if (focusSelector) document.querySelector(focusSelector)?.focus({ preventScroll: true });
    }
    if (focus)
      requestAnimationFrame(() => {
        $("#screen-title")?.focus({ preventScroll: true });
        window.scrollTo({ top: 0, behavior: "instant" });
      });
  }

  function scenario(id) {
    fault = "";
    error = "";
    exitMode = false;
    notesHostClosed = false;
    state.personalPanel = "names";
    state.transport = "secure";
    state.resumeGate = "";
    state.newsUnverified = false;
    state.sportsUnverified = false;
    state.accessPanel = "";
    switch (id) {
      case "fresh":
        state = initialState();
        break;
      case "access":
        state = { ...initialState(), step: 8, account: true, accessPanel: "choose" };
        break;
      case "access-http":
        state = {
          ...initialState(),
          step: 8,
          account: true,
          accessDraft: "lan-http",
          accessPanel: "choose"
        };
        break;
      case "access-https":
        state = {
          ...initialState(),
          step: 8,
          account: true,
          accessDraft: "https",
          accessPanel: "choose"
        };
        break;
      case "legacy-lan":
        state = {
          ...initialState(),
          step: 8,
          account: true,
          setupRoute: "legacy",
          accessMode: "lan-http",
          accessDraft: "lan-http",
          browserConnection: "http"
        };
        break;
      case "legacy-https":
        state = {
          ...initialState(),
          step: 8,
          account: true,
          setupRoute: "legacy",
          accessMode: "https",
          accessDraft: "https"
        };
        break;
      case "install-missing":
        state = { ...initialState(), installPanel: "host", dockerStatus: "missing" };
        break;
      case "install-stopped":
        state = { ...initialState(), installPanel: "host", dockerStatus: "stopped" };
        break;
      case "install-context":
        state = { ...initialState(), installPanel: "host", dockerStatus: "wrong-context" };
        break;
      case "install-failed":
        state = {
          ...initialState(),
          installPanel: "prepare-results",
          dockerStatus: "ready",
          installStatus: "failed",
          hostNotesChoice: "managed"
        };
        break;
      case "headless":
        state = {
          ...initialState(),
          setupRoute: "remote",
          hostPlatform: "linux",
          runtimeTarget: "linux-x86_64",
          installPanel: "host"
        };
        break;
      case "manual-docker":
        state = {
          ...initialState(),
          setupRoute: "manual",
          hostPlatform: "linux",
          runtimeTarget: "linux-x86_64",
          installPanel: "host"
        };
        break;
      case "news-ready":
        state = { ...initialState(), step: 6, newsStructured: true, newsSearch: true };
        break;
      case "happy":
        state = {
          ...initialState(),
          step: 8,
          account: true,
          city: "London",
          cityId: "london",
          timezone: "Europe/London",
          timezoneSource: "city",
          ai: "connected",
          notes: "ready",
          notesRoot: "Personal vault",
          email: "connected",
          emailSync: "ready",
          news: ["World", "Technology"],
          sports: ["Arsenal"]
        };
        break;
      case "email-ready":
        state = {
          ...initialState(),
          step: 9,
          account: true,
          ai: "connected",
          email: "connected",
          emailSync: "ready",
          completed: true
        };
        break;
      case "skip-all":
        state = { ...initialState(), step: 8, account: true, skipped: [3, 4, 5, 6, 7] };
        break;
      case "http":
        state = { ...state, step: 0, transport: "http" };
        break;
      case "unknown":
        state = { ...state, step: 0, transport: "unknown" };
        break;
      case "certificate":
        state = { ...state, step: 0, transport: "certificate" };
        break;
      case "claim-expired":
        state.step = 1;
        state.resumeGate = "claim-expired";
        break;
      case "claim-used":
        state.step = 1;
        state.resumeGate = "claim-used";
        break;
      case "host-recreate":
        state.step = 4;
        state.notes = "recreate-failed";
        break;
      case "wrong-instance":
        state.step = 4;
        state.resumeGate = "wrong-instance";
        break;
      case "signed-out":
        state.step = 4;
        state.resumeGate = "signed-out";
        break;
      case "email-failed":
        state.step = 5;
        state.email = "failed";
        break;
      case "email-unavailable":
        state.step = 5;
        state.emailProvider = "Proton Bridge";
        state.email = "unavailable";
        break;
      case "news-read":
        state.step = 6;
        state.newsUnverified = true;
        fault = "news-read";
        break;
      case "sports-read":
        state.step = 7;
        state.sportsUnverified = true;
        fault = "sports-read";
        break;
      case "save":
        state.step = 2;
        fault = "save";
        break;
      case "offline":
        state.step = 2;
        fault = "offline";
        break;
      case "ai-failed":
        state.step = 3;
        state.ai = "failed";
        break;
      case "ai-awaiting":
        state.step = 3;
        state.ai = "awaiting";
        break;
      case "ai-unavailable":
        state.step = 3;
        state.ai = "unavailable";
        break;
      case "no-chat":
        state.step = 3;
        state.ai = "no-chat";
        state.savedAi = null;
        state.providers = [];
        state.aiMethod = "key";
        break;
      case "notes-mount":
        state.step = 4;
        state.notes = "pending";
        break;
      case "notes-readonly":
        state.step = 4;
        state.notes = "read-only";
        break;
      case "notes-error":
        state.step = 4;
        state.notes = "browse-error";
        break;
      case "notes-verify":
        state.step = 4;
        state.notes = "verify-failed";
        break;
      case "finish":
        state.step = 8;
        fault = "finish";
        break;
      case "resume":
        state = { ...initialState(), step: 4, account: true, ai: "connected", notes: "pending" };
        break;
      case "owner-switch":
        state = { ...initialState(), name: "Jamie", step: 1 };
        error =
          "Demo owner changed. Previous-owner responses were discarded; no choices were copied into this owner.";
        break;
      case "navigation":
        state.step = 6;
        state.ai = "awaiting";
        error =
          "Demo navigation changed while sign-in was pending. The old result cannot move you away from News.";
        break;
    }
    if (state.step > 0) {
      state.installStatus = "running";
      state.dockerStatus = "ready";
      state.protectedContinuation = true;
      state.installPanel = "running";
      if (!state.setupRoute) state.setupRoute = "legacy";
    }
    if (state.step > 1) state.account = true;
    state.furthest = Math.max(state.furthest || 0, state.step);
    save();
    render();
    announce(`Review scenario: ${id}. Demonstration only.`);
  }
  function showReview() {
    lastFocus = document.activeElement;
    $("#review-content").innerHTML =
      `<div class="review-links"><a href="screen-contract.md">Screen contract</a><a href="README.md">Review guide</a></div><div class="review-group"><h3>Start & finish</h3><div class="review-buttons">${[
        ["fresh", "Fresh installation"],
        ["headless", "Linux headless"],
        ["manual-docker", "Manual Docker"],
        ["install-missing", "Docker missing"],
        ["install-stopped", "Docker stopped"],
        ["install-context", "Wrong Docker host"],
        ["install-failed", "Preparation fails"],
        ["happy", "Happy path summary"],
        ["skip-all", "Skip optional setup"],
        ["resume", "Restart & resume"],
        ["finish", "Finish fails"]
      ]
        .map(([id, label]) => button(label, "scenario", "secondary", `data-scenario="${id}"`))
        .join(
          ""
        )}</div></div><div class="review-group"><h3>Connection & recovery</h3><div class="review-buttons">${[
        ["http", "First-owner HTTP gate"],
        ["unknown", "Unknown connection"],
        ["certificate", "Certificate warning"],
        ["wrong-instance", "Wrong-instance resume"],
        ["signed-out", "Signed-out resume"],
        ["claim-expired", "Expired owner claim"],
        ["claim-used", "Used owner claim"],
        ["save", "Save fails"],
        ["offline", "Offline"],
        ["navigation", "Newer navigation"],
        ["owner-switch", "Account switch"]
      ]
        .map(([id, label]) => button(label, "scenario", "secondary", `data-scenario="${id}"`))
        .join(
          ""
        )}</div><p class="hint">“Save fails” and “Offline” stop the next save. Your previous state remains available.</p></div><div class="review-group"><h3>AI & notes</h3><div class="review-buttons">${[
        ["ai-awaiting", "Awaiting sign-in"],
        ["ai-failed", "Provider error"],
        ["ai-unavailable", "Catalog unavailable"],
        ["no-chat", "Background-only AI"],
        ["notes-mount", "Host mount pending"],
        ["notes-readonly", "Read-only notes"],
        ["notes-error", "Folder browse error"],
        ["notes-verify", "Write check fails"],
        ["host-recreate", "Host recreate fails"],
        ["email-failed", "Email error"],
        ["email-unavailable", "Bridge unavailable"],
        ["email-ready", "Email ready for chat"],
        ["news-read", "News read error"],
        ["news-ready", "Custom topics ready"],
        ["sports-read", "Sports read error"]
      ]
        .map(([id, label]) => button(label, "scenario", "secondary", `data-scenario="${id}"`))
        .join(
          ""
        )}</div></div><div class="review-group"><h3>Access revision proposal</h3><div class="review-buttons">${[
        ["access", "Use other devices"],
        ["access-http", "Home network disclosure"],
        ["access-https", "HTTPS choice"],
        ["legacy-lan", "Existing LAN browser"],
        ["legacy-https", "Existing HTTPS"]
      ]
        .map(([id, label]) => button(label, "scenario", "secondary", `data-scenario="${id}"`))
        .join(
          ""
        )}</div></div><div class="review-group"><h3>Appearance</h3><div class="review-theme"><label>Color mode<select id="review-mode"><option value="light" ${state.mode === "light" ? "selected" : ""}>Light</option><option value="dark" ${state.mode === "dark" ? "selected" : ""}>Dark</option></select></label><label>Park theme<select id="review-theme"><option value="forest" ${state.theme === "forest" ? "selected" : ""}>Forest</option><option value="teal" ${state.theme === "teal" ? "selected" : ""}>Teal</option></select></label></div></div><div class="review-group"><button class="text-button" data-action="reset">Reset only this prototype</button><p class="hint">Resets this tab’s in-memory choices. This bundle never writes browser storage.</p></div>`;
    $("#review-dialog").showModal();
    $("#review-close").focus();
  }
  function closeReview() {
    $("#review-dialog").close();
    lastFocus?.focus();
  }
  function detail(title, body, actionLabel, action) {
    lastFocus = document.activeElement;
    $("#detail-dialog").innerHTML =
      `<div class="dialog-head"><div><p class="eyebrow">DESIGN SIMULATION</p><h2 id="detail-title">${title}</h2></div><button class="icon-button" data-action="detail-close" aria-label="Close dialog">×</button></div><div class="muted">${body}</div><div class="transport-actions">${actionLabel ? button(actionLabel, action) : ""}${button("Close", "detail-close", "quiet")}</div>`;
    $("#detail-dialog").showModal();
  }
  function closeDetail() {
    $("#detail-dialog").close();
    lastFocus?.focus();
  }
  function dispatch(action, target) {
    error = "";
    if (
      [
        "account",
        "ai-connect",
        "ai-approved",
        "email-connect",
        "email-approved",
        "finish",
        "finish-early"
      ].includes(action) &&
      !installationReady(state)
    ) {
      go(1);
      return;
    }
    switch (action) {
      case "access-open":
        openAccess();
        break;
      case "access-review":
        reviewAccess();
        break;
      case "access-apply":
        applyAccess();
        break;
      case "access-verify":
        verifyAccess();
        break;
      case "access-fail":
        state.accessStatus = "failed";
        state.accessPanel = "verify";
        render();
        break;
      case "access-cancel":
        state.accessPanel = "";
        state.accessStatus = "idle";
        go(state.accessReturnStep || 8);
        break;
      case "next":
        if (state.step === 0) {
          installerPanel("host");
          break;
        }
        go(state.step === 3 ? 5 : Math.min(8, state.step + 1));
        break;
      case "back":
        if (state.accessPanel) {
          if (state.accessPanel === "choose" || state.accessPanel === "verify") {
            state.accessPanel = "";
            go(state.accessReturnStep || 8);
          } else {
            state.accessPanel = "choose";
            render();
          }
          break;
        }
        if (state.step === 0 && state.transport === "secure") {
          const previous =
            {
              host: "route",
              notes: "host",
              prepare: "notes",
              "prepare-results": "prepare",
              running: "prepare",
              connection: "running"
            }[state.installPanel] || "route";
          installerPanel(previous);
          break;
        }
        if (state.step === 5) {
          go(3);
          break;
        }
        if (state.step === 2 && state.personalPanel === "location") {
          state.personalPanel = "names";
          save();
          history.pushState({ step: 2, personalPanel: "names" }, "");
          render();
          break;
        }
        if (
          state.step === 4 &&
          ["pending", "checking", "verify-failed", "recreate-failed"].includes(state.notes) &&
          !notesHostClosed
        ) {
          notesHostClosed = true;
          render();
          break;
        }
        if (state.step === 4 && state.notes === "browse") {
          state.notes = "idle";
          save();
          render();
          break;
        }
        if (state.transport !== "secure") {
          error =
            "This route is still unencrypted. Choose a simulated verified connection to continue.";
          render();
        } else go(Math.max(0, state.step - 1));
        break;
      case "skip":
        if (state.step === 2) {
          detail(
            "Keep this time zone for now?",
            `<p class="location-summary">${esc(state.timezone)}. ${esc(weatherLabel(state))}.</p><p>You can choose a city later; no location lookup runs in this demo.</p>`,
            "Keep and continue",
            "location-skip"
          );
          break;
        }
        state.skipped = Array.from(new Set([...(state.skipped || []), state.step]));
        go(state.step === 3 ? 5 : state.step + 1);
        break;
      case "account":
        if (!state.name.trim()) {
          error = "Add a demo name to continue.";
          render();
          $("#owner-name")?.focus();
          break;
        }
        {
          const existed = state.account;
          if (
            commitStep(() => {
              state.account = true;
              if (state.notesPrepared && state.preparedNotesChoice !== "skip") {
                state.notes = "ready";
                state.notesChoice = state.preparedNotesChoice || state.hostNotesChoice;
                state.notesRoot =
                  state.notesChoice === "managed"
                    ? "Moss Notes"
                    : state.preparedHostFolder || state.hostFolder;
                state.savedNotes = { root: state.notesRoot, choice: state.notesChoice };
              }
            }, 2)
          )
            announce(existed ? "Demo name saved." : "Demo owner created.");
        }
        break;
      case "personal-location":
        if (!state.assistant.trim()) {
          error = "Add a name for your assistant.";
          render();
          break;
        }
        if (fault === "save" || fault === "offline") {
          go(2);
          break;
        }
        state.personalPanel = "location";
        if (!save()) {
          state.personalPanel = "names";
          error = "Your latest changes haven’t saved. Retry before continuing.";
          render();
          break;
        }
        history.pushState({ step: 2, personalPanel: "location" }, "");
        render();
        break;
      case "personal":
        if (!state.cityId) {
          error = "Choose a demo city from the results to continue.";
          render();
          $("#city")?.focus();
          break;
        }
        go(3);
        break;
      case "location-skip":
        closeDetail();
        go(3);
        break;
      case "city-timezone":
        state.timezoneSource = "city";
        chooseCity(state, state.cityId);
        save();
        render(false);
        announce("Time zone set from your city.");
        break;
      case "ai-connect":
        if (state.transport !== "secure") {
          go(0);
          break;
        }
        state.ai = state.aiMethod === "key" ? "no-chat" : "awaiting";
        save();
        render();
        break;
      case "ai-approved":
        if (!providerNames[state.provider]) {
          error = "Choose a supported or explicitly proposed demo route first.";
          render();
          break;
        }
        state.ai = "connected";
        state.model =
          state.aiMethod === "local" ? "Proposed local model · demo" : "Demo chat model";
        preserveAi();
        save();
        render();
        announce("Demo chat-capable model ready.");
        break;
      case "ai-choose":
        chooseProvider("claude");
        break;
      case "ai-add":
        preserveAi();
        state.provider =
          Object.keys(providerNames).find((id) => !state.providers.some((p) => p.id === id)) ||
          "claude";
        state.aiMethod = state.provider === "local" ? "local" : "account";
        state.ai = "idle";
        save();
        render();
        break;
      case "registry-open":
        state.registryOpen = true;
        state.registrySelection = "";
        save();
        render();
        break;
      case "registry-close":
        state.registryOpen = false;
        state.registrySelection = "";
        save();
        render();
        break;
      case "registry-back":
        state.registrySelection = "";
        save();
        render();
        break;
      case "registry-use": {
        const entry = ACP_REGISTRY.find((x) => x.id === state.registrySelection),
          id = Object.keys(providerRegistry).find(
            (k) => providerRegistry[k] === state.registrySelection
          );
        if (!entry || registryStatus(entry).kind !== "supported" || !id) {
          error = "This discovery entry does not have an available tested Moss route.";
          render();
          break;
        }
        chooseProvider(id);
        break;
      }
      case "ai-cancel":
        state.ai = "idle";
        save();
        render();
        break;
      case "ai-reload":
        state.ai = "idle";
        save();
        render();
        break;
      case "notes-browse":
        state.notes = "browse";
        save();
        render();
        break;
      case "notes-host":
        notesHostClosed = false;
        if (!save()) {
          error = "We couldn’t save your progress. Retry before leaving for the host step.";
          render();
          break;
        }
        state.notes = "pending";
        save();
        render();
        break;
      case "notes-use":
        if (state.notesRoot === "Reference archive") state.notes = "read-only";
        else {
          state.notes = "ready";
          state.savedNotes = { root: state.notesRoot, choice: state.notesChoice };
        }
        save();
        render();
        break;
      case "notes-managed":
        state.notes = "ready";
        state.notesRoot = "Moss Notes";
        state.savedNotes = { root: "Moss Notes", choice: "managed" };
        save();
        render();
        break;
      case "notes-verify":
        state.notes = "ready";
        state.notesRoot = "Personal vault";
        state.savedNotes = { root: "Personal vault", choice: "existing" };
        save();
        render();
        announce("Simulated read-and-write verification passed.");
        break;
      case "notes-later":
        go(5);
        break;
      case "email-connect":
        state.email = "awaiting";
        save();
        render();
        break;
      case "email-approved":
        state.email = "connected";
        state.emailSync = "pending";
        state.savedEmailSync = "pending";
        state.savedEmail = state.emailProvider || "Google";
        save();
        render();
        announce("Demo mailbox connected. No mail has been read.");
        break;
      case "email-cancel":
        state.email = "idle";
        save();
        render();
        break;
      case "finish":
        finish();
        break;
      case "finish-early":
        if (!aiReady(state)) {
          detail(
            "Begin without AI?",
            "Your other saved choices will carry over. Chat and AI-powered help will wait until a capable provider is ready.",
            "Review my choices",
            "confirm-early"
          );
        } else go(8);
        break;
      case "confirm-early":
        closeDetail();
        go(8);
        break;
      case "save-leave":
        if (save()) {
          exitMode = true;
          render();
        } else {
          error = "Your latest changes haven’t saved. Retry before leaving.";
          render();
        }
        break;
      case "resume-gate": {
        const gate = state.resumeGate;
        state.resumeGate = "";
        if (gate === "claim-used") {
          state.account = true;
          go(2);
        } else {
          save();
          render();
        }
        break;
      }
      case "resume":
        exitMode = false;
        render();
        break;
      case "restart":
        save();
        exitMode = false;
        render();
        announce("Restart simulated within this tab. Refreshing the page resets the review.");
        break;
      case "scenario":
        closeReview();
        scenario(target.dataset.scenario);
        break;
      case "clear-fault":
        fault = "";
        state.newsUnverified = false;
        state.sportsUnverified = false;
        save();
        render();
        announce("Demo connection restored. You can try again.");
        break;
      case "secure":
        state.transport = "secure";
        save();
        render();
        announce("Secure connection check simulated.");
        break;
      case "host-local":
        detail(
          "A browser on the Moss computer.",
          "The proposed setup uses a protected host-local bootstrap. On a remote laptop, localhost means that laptop, not the Moss server. Current main does not yet provide the protected first-owner claim described in this design.",
          "Simulate verified host-local access",
          "confirm-secure"
        );
        break;
      case "remote-help":
        detail(
          "Moss is on another computer.",
          "A domain-free route is an SSH local forward from your browser’s computer to the Moss host, or trusted HTTPS configured for your network. The real setup must verify the route and protect the first-owner claim. This prototype does not run SSH, change networking, or open a server.",
          "Simulate verified secure route",
          "confirm-secure"
        );
        break;
      case "confirm-secure":
        closeDetail();
        state.transport = "secure";
        save();
        render();
        break;
      case "recheck":
        error =
          "Still blocked in this scenario. Simulate a verified route above to continue; no safety checkbox overrides this gate.";
        render();
        break;
      case "sign-in":
        detail(
          "Welcome back.",
          "This is a simulated existing-owner session. No credentials are requested, and no real account is signed in.",
          "Use demo session",
          "signed-in"
        );
        break;
      case "signed-in":
        closeDetail();
        state.account = true;
        state.installStatus = "running";
        state.protectedContinuation = true;
        state.installPanel = "running";
        go(2);
        break;
      case "demo-chat":
        detail(
          "Ready for a real conversation.",
          "In the product, this opens chat with the verified provider and selected model. The prototype does not generate a pretend conversation."
        );
        break;
      case "today-start":
        if (aiReady(state))
          detail(
            "Your Moss is ready.",
            "The product continues into the assistant with your verified provider. This preview ends here."
          );
        else go(3);
        break;
      case "chat-email":
        if (aiReady(state) && emailContextReady(state))
          detail(
            "Summarize your email.",
            "This proposed starter opens assistant chat with a connected, synced mailbox. Readiness is simulated here; no messages are read and no summary is invented."
          );
        break;
      case "edit-host-notes":
        state.installReturnStep = state.step;
        state.step = 0;
        state.hostNotesChoice =
          state.preparedNotesChoice || state.savedNotes?.choice || state.notesChoice || "existing";
        state.hostFolder =
          state.preparedHostFolder || state.savedNotes?.root || state.notesRoot || "";
        state.preparedNotesChoice = state.hostNotesChoice;
        state.preparedHostFolder = state.hostFolder;
        state.hostChangePending = false;
        state.hostApplyStarted = false;
        installerPanel("notes");
        break;
      case "host-change-cancel":
        if (state.hostApplyStarted) {
          error =
            "Preparation has started. Resume its readiness checks; a rollback is not assumed.";
          render();
          break;
        }
        state.hostNotesChoice = state.preparedNotesChoice || "existing";
        state.hostFolder = state.preparedHostFolder || "";
        state.hostChangePending = false;
        state.installStatus = "running";
        state.protectedContinuation = true;
        {
          const destination = state.installReturnStep || 8;
          state.installReturnStep = null;
          go(destination);
        }
        break;
      case "install-check":
        state.dockerStatus = "ready";
        save();
        render();
        break;
      case "docker-start":
      case "docker-context":
        state.dockerStatus = "ready";
        save();
        render();
        break;
      case "docker-help":
        detail(
          "Review Docker setup.",
          `<p>${state.hostPlatform === "linux" ? "Use Docker’s official Engine instructions for your supported Linux distribution. System and group changes require deliberate permission." : "Use the official Docker Desktop installer. Review its terms and licensing before accepting; Windows prerequisites may require administrator action or a restart."}</p><p>Official Docker installation guidance${state.hostPlatform === "linux" ? "" : " · Docker Desktop terms"}</p><p>This preview installs nothing and accepts no terms.</p>`,
          "Simulate reviewed setup complete",
          "docker-approved"
        );
        break;
      case "docker-approved":
        closeDetail();
        state.dockerStatus = "ready";
        save();
        render();
        break;
      case "install-notes":
        if (state.dockerStatus !== "ready") {
          error = "Check Docker on the selected host first.";
          render();
          break;
        }
        installerPanel("notes");
        break;
      case "host-pick":
        if (state.installStatus === "checking" || state.hostApplyStarted) {
          error = "Resolve the pending preparation before changing its folder.";
          render();
          break;
        }
        detail(
          state.setupRoute === "local" && state.hostPlatform !== "linux"
            ? "Native folder picker · simulation"
            : "Host folder selection · simulation",
          `<p>${state.setupRoute === "local" && state.hostPlatform !== "linux" ? "The real installer asks the operating system to choose a folder on this computer." : state.setupRoute === "local" ? "The real Linux helper asks for an existing path on this computer, including on headless systems." : "The real Linux helper asks for a path on the server. This browser cannot mount a folder from your laptop."}</p><p class="host-path">Demo folder: ${esc(hostFolderFixture())}</p><p>No file picker, upload or mount runs in this preview.</p>`,
          "Use this demo folder",
          "host-picked"
        );
        break;
      case "host-picked":
        closeDetail();
        state.hostFolder = hostFolderFixture();
        invalidateHostDraft();
        save();
        render();
        break;
      case "host-notes-next":
        if (state.hostNotesChoice === "existing" && !state.hostFolder) {
          error = "Choose a demo folder, or set up notes later.";
          render();
          break;
        }
        installerPanel("prepare");
        break;
      case "host-notes-skip":
        if (state.installStatus === "checking" || state.hostApplyStarted) {
          error = "Resume preparation before changing or skipping its folder.";
          render();
          break;
        }
        if (state.account && state.savedNotes) {
          dispatch("host-change-cancel");
          break;
        }
        invalidateHostDraft();
        state.hostNotesChoice = "skip";
        state.hostFolder = "";
        installerPanel("prepare");
        break;
      case "install-start":
        if (state.installStatus === "checking") {
          installerPanel("prepare-results");
          break;
        }
        if (
          state.dockerStatus !== "ready" ||
          (state.hostNotesChoice === "existing" && !state.hostFolder)
        ) {
          error = "Check Docker and the chosen host folder before preparing Moss.";
          render();
          break;
        }
        if (state.installStatus === "running" && !state.hostChangePending) {
          installerPanel("running");
          break;
        }
        installerTransition(
          {
            installStatus: "checking",
            protectedContinuation: false,
            hostApplyStarted: state.hostChangePending === true
          },
          "prepare-results"
        );
        break;
      case "install-health":
        if (state.installStatus !== "checking") {
          error = "Prepare this host before checking readiness.";
          render();
          break;
        }
        installerTransition(
          {
            installStatus: "running",
            notesPrepared: state.hostNotesChoice !== "skip",
            preparedHostFolder: state.hostFolder,
            preparedNotesChoice: state.hostNotesChoice
          },
          "running"
        );
        break;
      case "install-continue":
        if (state.installStatus !== "running") {
          error = "Moss has not passed the simulated health check.";
          render();
          break;
        }
        {
          const destination = state.account ? state.installReturnStep || 2 : 1;
          commitStep(() => {
            state.protectedContinuation = true;
            if (state.account && state.hostChangePending && state.preparedNotesChoice !== "skip") {
              state.notes = "ready";
              state.notesChoice = state.preparedNotesChoice;
              state.notesRoot =
                state.notesChoice === "managed" ? "Moss Notes" : state.preparedHostFolder;
              state.savedNotes = { root: state.notesRoot, choice: state.notesChoice };
            }
            state.hostChangePending = false;
            state.hostApplyStarted = false;
            state.installReturnStep = null;
          }, destination);
        }
        break;
      case "manual-template":
        detail(
          "Review the host configuration.",
          `<p>Illustrative template only. The real release must supply verified image pins and full configuration.</p><pre class="template-preview">services:
  moss:
    image: &lt;verified-release-digest&gt;
    ports: ["127.0.0.1:3000:3000"]
    volumes:
      - type: bind
        source: &lt;existing-path-on-Docker-host&gt;
        target: /notes
        bind: { create_host_path: false }
</pre><p>Boot secrets are generated once in protected storage on the host. Preserve the same keys, volumes and deployment identity on retry. This sketch contains no secrets and is not a runnable installer.</p>`
        );
        break;
      case "topic-open":
        state.topicEditing = true;
        save();
        render();
        break;
      case "topic-cancel":
        state.topicEditing = false;
        save();
        render();
        break;
      case "news-check":
        detail(
          "Custom topics need AI and search.",
          "The product verifies a structured-output model and working web search before checking and saving a topic. In this preview you can simulate that prerequisite check.",
          "Simulate prerequisites ready",
          "news-ready"
        );
        break;
      case "news-ready":
        closeDetail();
        state.newsStructured = true;
        state.newsSearch = true;
        save();
        render();
        break;
      case "topic-add": {
        const label = (state.topicLabel || "").trim(),
          guidance = (state.topicGuidance || "").trim();
        if (!newsTopicsReady(state)) {
          error = "Check structured AI and web-search availability before adding a topic.";
          render();
          break;
        }
        if (!label || label.length > 80 || guidance.length > 1000) {
          error = "Use a topic of 1–80 characters and guidance of up to 1,000 characters.";
          render();
          break;
        }
        if (state.newsCustom.length >= 10) {
          error = "You can add up to 10 custom topics.";
          render();
          break;
        }
        if (
          [...state.news, ...state.newsCustom.map((t) => t.label)].some(
            (x) => x.toLowerCase() === label.toLowerCase()
          )
        ) {
          error = "That topic is already in your list.";
          render();
          break;
        }
        const previous = JSON.parse(JSON.stringify(state));
        state.topicNextId = (state.topicNextId || 0) + 1;
        while (state.newsCustom.some((t) => t.id === "topic-" + state.topicNextId))
          state.topicNextId++;
        state.newsCustom.push({ id: "topic-" + state.topicNextId, label, guidance });
        state.topicLabel = "";
        state.topicGuidance = "";
        state.topicEditing = false;
        if (!save()) {
          state = previous;
          error =
            "Your topic was not saved. Your draft is still here; retry when the simulated save works.";
          render();
          break;
        }
        render();
        announce("Demo topic saved. No live search was run.");
        break;
      }
      case "detail-close":
        closeDetail();
        break;
      case "reset":
        closeReview();
        detail(
          "Reset this prototype?",
          "This clears only this tab’s in-memory demo choices. No Moss account, real settings, or files are affected.",
          "Reset demo",
          "confirm-reset"
        );
        break;
      case "confirm-reset":
        closeDetail();
        state = initialState();
        fault = "";
        saved = false;
        render();
        announce("Prototype reset.");
        break;
    }
  }
  $("#app").addEventListener("click", (event) => {
    const target = event.target.closest("button");
    if (!target) return;
    if (target.dataset.accessMode) {
      state.accessDraft = target.dataset.accessMode;
      state.accessStatus = "idle";
      save();
      render(false);
      return;
    }
    if (target.dataset.action) {
      dispatch(target.dataset.action, target);
      return;
    }
    if (target.dataset.step) {
      go(Number(target.dataset.step));
      return;
    }
    if (target.dataset.installRoute) {
      if (
        ["running", "checking", "failed", "needs-update"].includes(state.installStatus) ||
        state.account ||
        state.preparedNotesChoice
      ) {
        error =
          "This installation has a prepared or pending host. Keep its installation identity when resuming.";
        render();
        return;
      }
      state.setupRoute = target.dataset.installRoute;
      state.hostPlatform = state.setupRoute === "local" ? "macos" : "linux";
      state.runtimeTarget = state.setupRoute === "local" ? "linux-aarch64" : "linux-x86_64";
      state.dockerStatus = "unknown";
      state.hostFolder = "";
      state.hostNotesChoice = "existing";
      state.notesPrepared = false;
      state.installStatus = "unprepared";
      state.protectedContinuation = false;
      save();
      render(false);
      return;
    }
    if (target.dataset.hostPlatform) {
      if (
        ["running", "checking", "failed", "needs-update"].includes(state.installStatus) ||
        state.account ||
        state.preparedNotesChoice
      ) {
        error = "Keep the prepared or pending host when editing its folder.";
        render();
        return;
      }
      state.hostPlatform = target.dataset.hostPlatform;
      state.runtimeTarget = state.hostPlatform === "macos" ? "linux-aarch64" : "linux-x86_64";
      state.dockerStatus = "unknown";
      state.hostFolder = "";
      save();
      render(false);
      return;
    }
    if (target.dataset.hostNotes) {
      if (state.installStatus === "checking" || state.hostApplyStarted) {
        error = "Resolve the pending preparation before changing its folder choice.";
        render();
        return;
      }
      invalidateHostDraft();
      state.hostNotesChoice = target.dataset.hostNotes;
      state.hostFolder = "";
      save();
      render(false);
      return;
    }
    if (target.dataset.city) {
      chooseCity(state, target.dataset.city);
      state.cityQuery = "";
      save();
      render(false);
      announce(
        "Demo city and weather set. " +
          (state.timezoneSource === "manual"
            ? "Your manual time zone is kept."
            : "Time zone set from your city.")
      );
      return;
    }
    if (target.dataset.provider) {
      chooseProvider(target.dataset.provider);
      return;
    }
    if (target.dataset.registryId) {
      state.registrySelection = target.dataset.registryId;
      save();
      render();
      return;
    }
    if (target.dataset.removeTopic) {
      const previous = state.newsCustom;
      state.newsCustom = state.newsCustom.filter((t) => t.id !== target.dataset.removeTopic);
      if (!save()) {
        state.newsCustom = previous;
        error = "That topic was not removed. Your saved list is kept.";
      }
      render(false);
      return;
    }
    if (target.dataset.method) {
      preserveAi();
      state.aiMethod = target.dataset.method;
      state.ai = "idle";
      save();
      render(false);
      return;
    }
    if (target.dataset.notesChoice) {
      if (state.notes === "ready")
        state.savedNotes = { root: state.notesRoot, choice: state.notesChoice };
      state.notesChoice = target.dataset.notesChoice;
      state.notes = state.notesChoice === "existing" ? "browse" : "idle";
      state.notesRoot = "";
      save();
      render(false);
      return;
    }
    if (target.dataset.root) {
      state.notesRoot = target.dataset.root;
      save();
      render(false);
      return;
    }
    if (target.dataset.topic) {
      state.news = toggleItem(state.news, target.dataset.topic);
      save();
      target.setAttribute("aria-pressed", String(state.news.includes(target.dataset.topic)));
      $(".preview-line").textContent = `${state.news.length} topics selected · sample catalog`;
      return;
    }
    if (target.dataset.team) {
      state.sports = toggleItem(state.sports, target.dataset.team);
      save();
      target.setAttribute("aria-pressed", String(state.sports.includes(target.dataset.team)));
      $("#team-count").textContent = `${state.sports.length} teams selected`;
    }
  });
  $("#app").addEventListener("input", (event) => {
    if (event.target.hasAttribute("data-city-search")) {
      state.cityQuery = event.target.value;
      save();
      $("#city-results").innerHTML = cityResults(state.cityQuery);
      return;
    }
    const field = event.target.dataset.field;
    if (
      ![
        "name",
        "assistant",
        "timezone",
        "units",
        "emailProvider",
        "teamQuery",
        "registryQuery",
        "topicLabel",
        "topicGuidance"
      ].includes(field)
    )
      return;
    state[field] = event.target.value;
    if (field === "timezone") state.timezoneSource = "manual";
    save();
    if (field === "timezone" || field === "units") {
      render(false);
      return;
    }
    if (field === "registryQuery") {
      $("#registry-results").innerHTML = registryRows();
      return;
    }
    if (field === "teamQuery") {
      $("#team-results").innerHTML = teamResults(
        teams.filter((x) => x.join(" ").toLowerCase().includes(state.teamQuery.toLowerCase()))
      );
    }
  });
  $("#app").addEventListener("change", (event) => {
    if (event.target.dataset.field === "emailProvider") {
      if (state.email === "connected") {
        state.savedEmail = state.savedEmail || "Previously saved mailbox";
        state.savedEmailSync = state.emailSync;
      }
      state.email = "idle";
      state.emailSync = "pending";
      save();
      render(false);
    }
  });
  $("#review-open").addEventListener("click", showReview);
  $("#review-close").addEventListener("click", closeReview);
  $("#review-dialog").addEventListener("click", (event) => {
    const t = event.target.closest("button[data-action]");
    if (t) dispatch(t.dataset.action, t);
  });
  $("#review-dialog").addEventListener("change", (event) => {
    if (event.target.id === "review-theme") state.theme = event.target.value;
    if (event.target.id === "review-mode") state.mode = event.target.value;
    save();
    applyTheme();
  });
  $("#detail-dialog").addEventListener("click", (event) => {
    const t = event.target.closest("button[data-action]");
    if (t) dispatch(t.dataset.action, t);
  });
  $("#review-dialog").addEventListener("cancel", () => {
    lastFocus?.focus();
  });
  $("#detail-dialog").addEventListener("cancel", () => {
    lastFocus?.focus();
  });
  history.replaceState(
    {
      step: state.step,
      installPanel: state.step === 0 ? state.installPanel : undefined,
      personalPanel: state.step === 2 ? state.personalPanel || "names" : undefined
    },
    ""
  );
  window.addEventListener("popstate", (event) => {
    if (Number.isInteger(event.state?.step)) {
      state.step = event.state.step;
      state.accessPanel = state.step === 8 ? event.state.accessPanel || "" : "";
      if (state.step > 0 && !installationReady(state)) {
        state.step = 0;
        error = "Finish protected host preparation before continuing.";
      }
      if (state.step === 0 && event.state.installPanel)
        state.installPanel = event.state.installPanel;
      if (state.step === 2) state.personalPanel = event.state.personalPanel || "names";
      error = "";
      save();
      render();
    }
  });
  render(false);
  const reviewId = new URLSearchParams(location.hash.slice(1)).get("review");
  const reviewIds = [
    "fresh",
    "headless",
    "manual-docker",
    "install-missing",
    "install-stopped",
    "install-context",
    "install-failed",
    "happy",
    "skip-all",
    "resume",
    "finish",
    "http",
    "unknown",
    "certificate",
    "wrong-instance",
    "signed-out",
    "claim-expired",
    "claim-used",
    "save",
    "offline",
    "navigation",
    "owner-switch",
    "ai-awaiting",
    "ai-failed",
    "ai-unavailable",
    "no-chat",
    "notes-mount",
    "notes-readonly",
    "notes-error",
    "notes-verify",
    "host-recreate",
    "email-failed",
    "email-unavailable",
    "email-ready",
    "news-read",
    "news-ready",
    "sports-read",
    "access",
    "access-http",
    "access-https",
    "legacy-lan",
    "legacy-https"
  ];
  if (reviewIds.includes(reviewId)) scenario(reviewId);
})();
