// external-modules/finance/src/worker/ports.ts
//
// FIN-01 (#1146): the per-invocation dependency set every tool handler is
// written against (job-search ai-port.ts pattern). All ports are structural —
// no SDK imports — so handler logic stays testable without the SDK runtime
// and the domain/worker layers stay bundler-independent.
import type { PlaidClient, PlaidCreds } from "../adapters/plaid.js";
import type { PlaidEnv } from "../adapters/types.js";
import type { FinanceDb, FinanceKv, FinanceStore, SharedMirrorKv } from "../domain/index.js";

export type FinanceAiResult =
  | { readonly ok: true; readonly object: unknown }
  | { readonly ok: false; readonly error: string };

export interface FinanceAiInput {
  readonly schema: Record<string, unknown>;
  readonly prompt: string;
  readonly maxOutputTokens?: number;
  readonly tierHint?: "reasoning" | "interactive" | "economy";
}

export interface FinanceAi {
  generateStructured(input: FinanceAiInput): Promise<FinanceAiResult>;
}

/**
 * Plaid access-token map, keyed by Plaid item id. Lives ONLY in
 * app.module_credentials (user slot finance.plaid-tokens) behind this port —
 * never in KV, logs, job payloads, exports, or AI prompts. The real
 * implementation over ctx.auth lands in Task 5 (auth-port.ts); nothing else
 * may touch ctx.auth.
 */
export type TokenMap = Record<string, { accessToken: string; institutionId: string | null }>;

export interface TokensPort {
  /**
   * Returns null on ANY read error: worker-runtime collapses host RPC errors
   * to a generic "rpc_failed", so credential_missing (first connect) is
   * indistinguishable from a transient failure. Callers MUST apply the D5
   * clobber guard: null while finance.connections shows ≥1 connected item
   * means ABORT, never "write a fresh empty map".
   */
  read(): Promise<TokenMap | null>;
  write(map: TokenMap): Promise<void>;
}

/**
 * Instance Plaid API keys (auth slots finance.plaid-client-id/-secret, Ben's
 * keys entered by the admin). get() throws InputError("needs_config", ...)
 * when either credential is unreadable — the caller-facing remediation is
 * always "an admin must enter Plaid keys", so no distinction is surfaced.
 */
export interface CredsPort {
  get(): Promise<PlaidCreds>;
}

/** finance.settings instance key "plaid" → { environment }, default production. */
export interface InstanceSettingsPort {
  getEnvironment(): Promise<PlaidEnv>;
}

/** The per-invocation dependencies every tool handler is written against. */
export interface WorkerPorts {
  readonly kv: FinanceKv;
  /**
   * FIN-04 (#1149): the `finance.shared` household mirror — the module's only
   * instance-scope writable namespace. Scope AND namespace are pinned inside
   * the port, so mirror writers structurally cannot reach any other namespace.
   */
  readonly mirror: SharedMirrorKv;
  /**
   * Plaid client factory over the module fetch port (env/creds resolved per
   * invocation — the admin can rotate keys or flip sandbox without a worker
   * restart). Nullable: an older host omitting ctx.fetch degrades to a
   * structured error, never a crash.
   */
  readonly plaid: ((env: PlaidEnv, creds: PlaidCreds) => PlaidClient) | null;
  /** Nullable: categorization (FIN-02) degrades gracefully when no AI bridge exists. */
  readonly ai: FinanceAi | null;
  /**
   * FIN-06b (#1166): raw module db.query access, present only when ctx.db
   * exists on this host (#1167). Every OTHER handler must go through
   * store() instead — this exists solely for storage-migrate's insert +
   * count-verify SQL, which the FinanceStore interface deliberately doesn't
   * expose (DO NOTHING upserts and raw counts are migration-only concerns).
   */
  readonly db: FinanceDb | null;
  readonly tokens: TokensPort;
  readonly creds: CredsPort;
  readonly settings: InstanceSettingsPort;
  /** Admin-gated inputs (connect.start environment override) are dropped when false. */
  readonly isAdmin: boolean;
  /**
   * The actor's tier for one of this module's action families (#3171).
   * Absent on a host without the read; callers then treat every family as
   * "ask_each_time", so Moss never confirms on its own.
   */
  readonly actionPolicy?: {
    get(familyId: string): Promise<"ask_each_time" | "trusted_auto" | "always_confirm">;
  };
  now(): Date;
  /**
   * FIN-06b (#1166 F6-D4): the per-owner storage selector — async, memoized
   * per invocation (worker/store.ts is the ONLY dual-read point). Every
   * handler calls this once and uses the returned FinanceStore for the rest
   * of the invocation, never mixing kv/db reads directly.
   */
  store(): Promise<FinanceStore>;
}

/**
 * Wrap a raw context AI port so rejections become a plain result. The
 * rejection reason is deliberately dropped: transport errors could carry
 * provider/model names, and module outputs must stay provider-agnostic.
 */
export function aiFromWorkerContext(ai: FinanceAi): FinanceAi {
  return {
    async generateStructured(input) {
      try {
        return await ai.generateStructured(input);
      } catch {
        return { ok: false, error: "provider_error" };
      }
    }
  };
}
