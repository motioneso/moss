// Writes Weather's place and unit with the real TypeScript preferences repository, lets the
// Rust port read them, then checks that TypeScript reads what Rust wrote.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createDatabase, DataContextRunner, getMossDatabaseUrls } from "@moss/db";
import { PreferencesRepository } from "../../../packages/structured-state/src/preferences-repository.js";

if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
const urls = getMossDatabaseUrls();
const bootstrap = new pg.Client({ connectionString: urls.bootstrap });
const app = createDatabase({ connectionString: urls.app });
const user = randomUUID();
let status = 1;
try {
  await bootstrap.connect();
  await bootstrap.query("INSERT INTO app.users(id,email,name) VALUES($1,$2,'Weather oracle')", [
    user,
    `weather-oracle-${user}@example.test`
  ]);
  const runner = new DataContextRunner(app);
  const repository = new PreferencesRepository();
  await runner.withDataContext({ actorUserId: user }, async (scope) => {
    await repository.upsert(scope, "weather-location", {
      lat: 48.8566,
      lon: 2.3522,
      label: "Paris, France"
    });
    await repository.upsert(scope, "weather-unit", "imperial");
  });
  const run = spawnSync(
    "cargo",
    [
      "+1.95.0",
      "test",
      "--locked",
      "--offline",
      "--manifest-path",
      "rust-spike/module-host/Cargo.toml",
      "--test",
      "weather_preferences_database",
      "--",
      "--include-ignored",
      "--nocapture",
      "--test-threads=1"
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        JS43_APP_URL: urls.app,
        JS43_BOOTSTRAP_URL: urls.bootstrap,
        WEATHER_TS_USER: user
      }
    }
  );
  status = run.status ?? 1;
  if (status === 0) {
    const after = await runner.withDataContext({ actorUserId: user }, (scope) =>
      repository.getMany(scope, ["weather-location", "weather-unit"])
    );
    const expected = {
      "weather-location": { lat: 35.6762, lon: 139.6503, label: "Tokyo" },
      "weather-unit": "metric"
    };
    if (JSON.stringify(after) !== JSON.stringify(expected)) {
      console.error("TypeScript did not read back what Rust wrote", after);
      status = 1;
    } else {
      console.log("PASS: TypeScript reads the place and unit Rust wrote");
    }
  }
} finally {
  await bootstrap.query("DELETE FROM app.users WHERE id=$1", [user]).catch(() => undefined);
  await Promise.allSettled([bootstrap.end(), app.destroy()]);
}
process.exit(status);
