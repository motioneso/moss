import { pathToFileURL } from "node:url";

// A suite is a Cargo test file, not a test-name filter. Keep companion gates separate too.
export function rustGateEntries(modules) {
  return modules.flatMap((module) => {
    const entry = (suite, gates = `test:rust-${module}`) => ({ module, suite, gates });
    switch (module) {
      case "memory":
        return [
          ...["db", "dashboard", "recording", "reembed", "account"].map((suite) => entry(suite)),
          entry("index", "test:rust-memory-index"),
          entry("oracle", "test:rust-memory-oracle")
        ];
      case "news":
        return [entry("installed"), entry("reader", "test:rust-news-reader")];
      case "connectors":
        // sync_speed retains its existing PR opt-out; the full local gate still includes it.
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
          "writes"
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
  console.log(JSON.stringify(rustGateEntries(JSON.parse(process.argv[2]))));
}
