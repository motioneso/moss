import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { getMossDatabaseUrls } from "@moss/db";
import { buildChildEnv } from "../../scripts/start-jarv1s.js";

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const customHost = "capture-db.example.test";
const roles = ["APP", "AUTH", "WORKER"] as const;

describe("capture maintenance deployment role configuration", () => {
  it("dev Compose API supplies all three runtime role URLs for its non-local database", () => {
    const compose = source("infra/docker-compose.yml");
    const api = compose.match(/^ {2}api:\n([\s\S]*?)(?=^ {2}\S)/m)?.[1] ?? "";
    const environment = Object.fromEntries(
      [...api.matchAll(/^ {6}(JARVIS_\w+_DATABASE_URL): (.+)$/gm)].map((match) => [
        match[1]!,
        match[2]!.replace("@postgres:", `@${customHost}:`)
      ])
    );
    const urls = getMossDatabaseUrls(environment);
    for (const role of roles) {
      expect(environment[`JARVIS_${role}_DATABASE_URL`], `api-${role}-url-present`).toBeTruthy();
      const url = new URL(urls[role.toLowerCase() as "app" | "auth" | "worker"]);
      expect(url.hostname).toBe(customHost);
      expect(url.port).toBe("5432");
    }
  });
  it("production env example reaches both API and worker unchanged through the supervisor", () => {
    const environment = parseEnv(
      source("infra/env.production.example").replaceAll("@postgres:", `@${customHost}:`)
    );
    for (const role of ["api", "worker"] as const) {
      const urls = getMossDatabaseUrls(
        buildChildEnv(role, { ...environment, NODE_ENV: "production" })
      );
      expect(new URL(urls.worker).hostname).toBe(customHost);
      expect(new URL(urls.app).hostname).toBe(customHost);
      expect(new URL(urls.auth).hostname).toBe(customHost);
    }
    const compose = source("infra/docker-compose.prod.yml");
    expect(compose).toMatch(
      /x-app-env-file: &app-env-file\s+env_file:\s+- path: \$\{JARVIS_ENV_FILE:-\.\/env\.production\.local\}/
    );
    expect(compose).toMatch(/\n {2}jarv1s:[\s\S]*?<<: \*app-env-file/);
  });
  it("setup-generated MOSS role names and smoke env include the worker URL in the API environment", () => {
    const setup = source("scripts/setup-prod.ts");
    const smoke = source("scripts/smoke-compose.ts");
    const environment: NodeJS.ProcessEnv = { NODE_ENV: "production" };
    for (const role of ["BOOTSTRAP", "MIGRATION", ...roles]) {
      expect(setup).toContain(`MOSS_${role}_DATABASE_URL=\${`);
      expect(smoke).toContain(`JARVIS_${role}_DATABASE_URL=postgres://`);
      environment[`MOSS_${role}_DATABASE_URL`] =
        `postgres://synthetic@${customHost}:6432/capture_test`;
    }
    const urls = getMossDatabaseUrls(buildChildEnv("api", environment));
    expect(new URL(urls.worker).hostname).toBe(customHost);
    expect(new URL(urls.worker).port).toBe("6432");
  });
});
