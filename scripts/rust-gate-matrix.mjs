import { pathToFileURL } from "node:url";

// A suite is a Cargo test file, not a test-name filter. Keep companion gates separate too.
export function rustGateEntries(modules, event = "pull_request") {
  return modules.flatMap((module) => {
    const entry = (suite, gates = `test:rust-${module}`) => ({ module, suite, gates });
    switch (module) {
      case "memory":
        return [
          ...[
            ...(event === "pull_request" ? [] : ["db"]),
            "dashboard",
            "recording",
            "reembed",
            "account"
          ].map((suite) => ({
            ...entry(suite),
            controls: event === "pull_request" ? "skip" : "all"
          })),
          entry("index", "test:rust-memory-index"),
          entry("oracle", "test:rust-memory-oracle")
        ];
      case "news":
        return [
          ...(event === "pull_request" ? [] : [entry("installed")]),
          entry("reader", "test:rust-news-reader")
        ];
      case "connectors":
        // Preserve the existing PR opt-out and full manual-run benchmark coverage.
        return [
          "package",
          "registry",
          "mail_probe",
          "db",
          "google_sync",
          "google",
          "imap",
          ...(event === "pull_request" ? [] : ["refresh"]),
          "outlook",
          "writes",
          ...(event === "pull_request" ? [] : ["sync_speed"])
        ].map((suite) => ({
          ...entry(suite),
          controls: event === "pull_request" ? "skip" : "all"
        }));
      case "notes":
        return [
          entry("package", "test:rust-notes"),
          entry("server", "test:rust-notes-server"),
          entry("ingest", "test:rust-notes-ingest")
        ];
      case "calendar":
        return [
          entry("package", "test:rust-calendar"),
          entry("server", "test:rust-calendar-server")
        ];
      case "finance":
        return [entry("full", "test:rust-finance test:rust-finance-ui-unit")];
      case "meetings":
        return [
          entry("full", "test:rust-meetings test:rust-meetings-oracle test:rust-recording-oracle")
        ];
      case "people":
        return [entry("full", "test:rust-people-large")];
      default:
        return [entry("full")];
    }
  });
}

// The host PR tier replaces the all-module fan-out for shared code. A mixed PR still
// runs the gates of modules it directly touches. Main and nightly run every module.
export const rustModules = [
  "backtrack",
  "briefings",
  "calendar",
  "commitments",
  "connectors",
  "email",
  "finance",
  "goals",
  "meals",
  "meetings",
  "memory",
  "news",
  "notes",
  "people",
  "scratchpad",
  "sports",
  "tasks",
  "weather",
  "web-research",
  "wellness"
];

export const hostGates = [
  "module-bootstrap",
  "phase6-lifecycle-api",
  "install-endpoints",
  "module-assembly",
  "public-web",
  "tasks-server",
  "people-server",
  "proactive-server",
  "proactive-feedback",
  "weather-preferences",
  "module-ai",
  "integrations",
  "standins",
  "calendar-check"
];

export function rustCiEntries(modules, event, hostChanged = false, liveCandidate = false) {
  if (!["pull_request", "push", "schedule"].includes(event)) {
    throw new Error(`Unknown Rust CI tier: ${event}`);
  }
  const entries = rustGateEntries(event === "pull_request" ? modules : rustModules, event);
  if ((event === "pull_request" && hostChanged) || event === "schedule") {
    entries.push(
      ...hostGates.map((gate) => ({
        module: "host",
        suite: gate,
        gates: `test:rust-${gate}`
      }))
    );
  }
  // Promote one account-free live gate; other live suites remain outside the schedule.
  if (event === "schedule" || liveCandidate) {
    entries.push({ module: "live", suite: "scratchpad", gates: "test:rust-scratchpad-live" });
  }
  return entries;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const modules = JSON.parse(process.argv[2]);
  console.log(
    JSON.stringify(
      process.argv[4] === undefined
        ? rustGateEntries(modules, process.argv[3])
        : rustCiEntries(
            modules,
            process.argv[3],
            process.argv[4] === "true",
            process.argv[5] === "true"
          )
    )
  );
}
