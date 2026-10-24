import { resolveMossEnv, type DataContextDb } from "@moss/db";

import {
  EMBED_PROVIDER_CONFIG_KEY,
  getRuntimeConfigEntry,
  type RuntimeConfigKeyEntry,
  type RuntimeConfigType
} from "./runtime-config-keys.js";

export type RuntimeConfigSource = "instance" | "env" | "default";

export interface RuntimeConfigStatus {
  readonly value: string | null;
  readonly source: RuntimeConfigSource;
}

interface ResolvedRuntimeConfig {
  readonly entry: RuntimeConfigKeyEntry;
  readonly value: string;
  readonly source: RuntimeConfigSource;
}

export class RuntimeConfigResolver {
  constructor(
    private readonly scopedDb: DataContextDb,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  async getStatus(key: string): Promise<RuntimeConfigStatus> {
    const resolved = await this.resolve(key);
    return {
      value: resolved.entry.secret ? null : resolved.value,
      source: resolved.source
    };
  }

  async resolveString(key: string): Promise<string> {
    const resolved = await this.resolve(key);
    this.assertType(resolved.entry, key, ["string", "secret"]);
    return resolved.value;
  }

  async resolveEnum<T extends string = string>(key: string): Promise<T> {
    const resolved = await this.resolve(key);
    this.assertType(resolved.entry, key, ["enum"]);
    if (
      !resolved.entry.enumValues?.includes(resolved.value) &&
      !this.isStubEmbeddingEscapeHatch(key, resolved.value)
    ) {
      throw new Error(
        `Invalid runtime config "${key}" value ${this.redact(resolved)} (expected one of: ${resolved.entry.enumValues?.join(", ") ?? ""})`
      );
    }
    return resolved.value as T;
  }

  // #1313: `ai.embed_provider`'s registry entry intentionally excludes "stub" from
  // `enumValues` so the admin/self-operation PATCH write path (runtime-config-routes.ts, which
  // validates against this same field) can never steer a real instance onto the fake,
  // test-only embedding provider. But this resolver's `resolveEnum` is also the READ path the
  // production embedding wiring uses (packages/memory/src/embedding-provider-config.ts, via
  // graph-routes.ts / dashboard-routes.ts / notes/jobs.ts), and test/CI/UAT harnesses
  // legitimately set `JARVIS_EMBED_PROVIDER=stub` in the environment (tests/setup-env.ts,
  // .github/workflows/ci.yml prod-smoke, tests/uat/provisioner.ts) to avoid downloading a real
  // embedding model. Rather than hard-fail those harnesses here, let "stub" resolve through
  // unvalidated for this one key/value pair — `createEmbeddingProvider` is the actual
  // enforcement point: it only ever honors "stub" under the same test/dev signal
  // (NODE_ENV=test / VITEST=true / JARVIS_ALLOW_STUB_EMBEDDINGS=1) and otherwise falls back to
  // "local" with a loud warning naming this setting.
  private isStubEmbeddingEscapeHatch(key: string, value: string): boolean {
    return key === EMBED_PROVIDER_CONFIG_KEY && value === "stub";
  }

  async resolveInt(key: string): Promise<number> {
    const resolved = await this.resolve(key);
    this.assertType(resolved.entry, key, ["int"]);
    const parsed = Number(resolved.value);
    if (!Number.isInteger(parsed)) {
      throw new Error(
        `Invalid runtime config "${key}" value ${this.redact(resolved)} (expected int)`
      );
    }
    return parsed;
  }

  private async resolve(key: string): Promise<ResolvedRuntimeConfig> {
    const entry = getRuntimeConfigEntry(key);
    if (!entry) {
      throw new Error(`Unknown runtime config key "${key}"`);
    }

    const instanceValue = await this.readInstanceValue(key);
    if (typeof instanceValue === "string") {
      return { entry, value: instanceValue, source: "instance" };
    }

    const envValue = resolveMossEnv(this.env, entry.envVar);
    if (envValue && envValue.length > 0) {
      return { entry, value: envValue, source: "env" };
    }

    return { entry, value: entry.defaultValue, source: "default" };
  }

  private async readInstanceValue(key: string): Promise<unknown> {
    const row = await this.scopedDb.db
      .selectFrom("app.instance_settings")
      .select(["value"])
      .where("key", "=", key)
      .executeTakeFirst();
    return (row?.value as { value?: unknown } | null | undefined)?.value;
  }

  private assertType(
    entry: RuntimeConfigKeyEntry,
    key: string,
    expected: readonly RuntimeConfigType[]
  ): void {
    if (!expected.includes(entry.type)) {
      throw new Error(`Runtime config "${key}" is ${entry.type}, not ${expected.join("/")}`);
    }
  }

  private redact(resolved: ResolvedRuntimeConfig): string {
    return resolved.entry.secret ? '"[REDACTED]"' : `"${resolved.value}"`;
  }
}
