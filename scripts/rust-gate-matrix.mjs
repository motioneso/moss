import { pathToFileURL } from "node:url";

// A suite is a Cargo test file, not a test-name filter. Keep companion gates separate too.
export function rustGateEntries(modules, event = "pull_request") {
  return modules.flatMap((module) => {
    const entry = (suite, gates = `test:rust-${module}`) => ({ module, suite, gates });
    // Measured kill tier: these files exceeded 30m after splitting on PR #4420.
    if (event === "push") {
      if (module === "news") return [entry("installed")];
      if (module === "memory") {
        return [
          entry("db"),
          ...["account", "recording", "reembed"].map((suite) => ({
            ...entry(suite),
            controls: "only"
          }))
        ];
      }
      return [];
    }
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
          "refresh",
          "outlook",
          "writes",
          ...(event === "pull_request" ? [] : ["sync_speed"])
        ].map((suite) => entry(suite));
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(rustGateEntries(JSON.parse(process.argv[2]), process.argv[3])));
}
