import { sql } from "kysely";

import {
  createModuleStorageRpc,
  ModuleQueryError,
  type AccessContext,
  type DataContextDb,
  type DataContextRunner
} from "@moss/db";
import type { EmbeddingProvider } from "@moss/memory";
import { isSameOriginAppPath, type CreateNotificationInput } from "@moss/notifications";
import type { ModuleAssistantToolRisk } from "@moss/module-sdk";
import { EMBED_BATCH_MAX } from "@moss/module-sdk";
import type { ModuleFetchRequest, ModuleFetchResponse } from "@moss/module-sdk";
import { createHostPinnedFetch } from "@moss/host-fetch";
import {
  deleteModuleKvKey,
  getModuleKvValue,
  listModuleKvKeys,
  readModuleCredentialSecret,
  recordAuditEvent,
  setModuleKvValue,
  upsertModuleCredential,
  type ModuleCredentialCipher
} from "@moss/settings";

import type { ExternalModuleDiscovery } from "./types.js";

export class ExternalModuleRpcError extends Error {
  constructor(
    readonly code:
      | "credential_missing"
      | "undeclared_auth"
      | "undeclared_namespace"
      | "forbidden_kv_mutation"
      | "forbidden_instance_kv_write"
      | "forbidden_instance_credential_write"
      | "forbidden_credential_write"
      | "credential_value_invalid"
      | "forbidden_ai_call"
      | "forbidden_secret_in_ai_input"
      | "undeclared_database"
      | "forbidden_db_statement"
      | "forbidden_db_mutation"
      | "invalid_rpc"
      // Task 2b (#1283): notify.post's own two failure modes. forbidden_notify_mutation
      // mirrors forbidden_kv_mutation/forbidden_credential_write — a read-risk tool may
      // not post a notification, because unlike db.query there is no degraded read-only
      // mode to fall back into. rate_limited is the per-invocation cap tripping.
      | "forbidden_notify_mutation"
      | "rate_limited",
    /**
     * Human-readable reason. Never crosses the worker boundary to the module —
     * it is for host logs and tests. The module still sees only the code.
     */
    readonly detail?: string
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ExternalModuleRpcError";
  }
}

export interface ExternalModuleAiRequest {
  readonly schema: Record<string, unknown>;
  readonly prompt: string;
  readonly maxOutputTokens?: number;
  readonly tierHint?: "reasoning" | "interactive" | "economy";
  // #1286 Task 2e: host-side only, set from the runtime's per-invocation
  // AbortController below — never parsed out of the wire params (see aiRequest's
  // allow-list). Both ai-bridge implementations spread this request straight into
  // generateStructured's input, which already honours `signal` end to end.
  readonly signal?: AbortSignal;
}

// "usage_limited" is produced by the RPC layer's per-invocation cap (spec D6);
// the injected callback itself only ever returns the other four.
export type ExternalModuleAiError =
  | "needs_config"
  | "validation_failed"
  | "provider_error"
  | "usage_limited"
  | "aborted";

export type ExternalModuleAiResult =
  | { readonly ok: true; readonly object: unknown }
  | { readonly ok: false; readonly error: ExternalModuleAiError };

export interface ExternalModuleAttachmentText {
  readonly fileName: string;
  readonly mimeType: string;
  readonly text: string;
}

// Max ctx.ai.generateStructured calls per tool invocation (spec D6: platform
// config, enforced in parent memory — the handler is built per invocation).
//
// This is a RUNAWAY GUARD, not a quota. Every module on this instance is one we wrote,
// so the thing worth stopping is a loop that never terminates — not a module that
// legitimately needs to read a hundred things in one pass. The old value of 8 was set
// as if the caller were untrusted, and it showed: Job Search could score seven postings
// per crawl against a board of a hundred and thirty, so the board sat mostly unread and
// looked broken. The real bound on an invocation is the per-queue `timeoutMs` ceiling
// (MAX_INVOCATION_MS, ten minutes) — a number of calls is a poor proxy for cost when the
// clock already stops the work.
//
// When third-party modules become installable, the quota this used to pretend to be
// belongs with them: declared per queue in the manifest, clamped host-side, visible to
// the admin at install. That is a different mechanism from this line, and building it
// now would only guess at requirements no third-party module has yet.
export const AI_CALLS_PER_INVOCATION_CAP = 500;

const AI_ERRORS = new Set<string>([
  "needs_config",
  "validation_failed",
  "provider_error",
  "usage_limited",
  "aborted"
]);
const AI_TIERS = new Set(["reasoning", "interactive", "economy"]);
const AI_MAX_OUTPUT_TOKENS_CAP = 32_768;

// Max ctx.notify.post calls per tool invocation (Task 2b, #1283): five distinct
// things to tell the user about in one run is generous; a runaway loop posting
// hundreds is the failure mode this caps, not a legitimate burst.
export const NOTIFY_CALLS_PER_INVOCATION_CAP = 5;

export function createExternalModuleRpcHandler(input: {
  readonly module: ExternalModuleDiscovery;
  readonly toolRisk: ModuleAssistantToolRisk;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly workerDataContext: DataContextRunner;
  readonly cipher: ModuleCredentialCipher;
  readonly isActorAdmin: () => Promise<boolean>;
  /**
   * Resolver for the instance embedder behind ctx.embed (#1281). Required, not
   * optional: there are exactly two production construction sites and Job
   * Search embeds on the scheduled-crawl one, so an optional field would let a
   * missed site pass typecheck and fail only at run time. Lazy, because most
   * invocations never embed and resolving reads runtime config.
   */
  readonly embeddingProvider: () => Promise<EmbeddingProvider>;
  readonly readAttachmentText?: (
    access: AccessContext,
    attachmentId: string
  ) => Promise<ExternalModuleAttachmentText | null>;
  /**
   * ctx.notify (Task 2b, #1283): posts/updates an in-app notification for the
   * active actor. Optional like readAttachmentText — not every construction
   * site wires it (the briefing invoker shares this same input shape but its
   * calls are always toolRisk "read", so notify.post is rejected there before
   * this even runs). Typed against the repository's real CreateNotificationInput,
   * never an inline shape, so a shape drift there fails typecheck here instead
   * of silently dropping a field at the RPC boundary.
   */
  readonly postNotification?: (
    access: AccessContext,
    input: CreateNotificationInput
  ) => Promise<void>;
  readonly createFetch?: (allowedHosts: readonly string[]) => typeof fetch;
  readonly ai?: (
    scopedDb: DataContextDb,
    request: ExternalModuleAiRequest
  ) => Promise<ExternalModuleAiResult>;
}): (
  method: string,
  params: unknown,
  rememberSecret: (value: string) => void,
  // Host-side only (#1286 Task 2e): the runtime's per-invocation AbortController
  // signal, aborted at the hard ceiling. Forwarded into the pinned fetch below and
  // attached to the ai.generateStructured request; never reaches the module.
  hostSignal?: AbortSignal
) => Promise<unknown> {
  const declarations = new Map((input.module.manifest.auth ?? []).map((item) => [item.id, item]));
  const storage = new Map(
    (input.module.manifest.storage ?? []).map((item) => [item.namespace, item])
  );
  // Per-invocation state: the handler is constructed per tool invocation, so
  // these closures implement D6's composition guard and call cap in memory.
  const resolvedSecrets = new Set<string>();
  let aiCalls = 0;
  let notifyCalls = 0;

  return async (method, rawParams, rememberSecret, hostSignal) => {
    if (method === "attachments.readText") {
      const attachmentId = attachmentIdParam(rawParams);
      if (!input.readAttachmentText || !attachmentId) return null;
      try {
        return await input.readAttachmentText(
          { actorUserId: input.actorUserId, requestId: input.requestId },
          attachmentId
        );
      } catch {
        return null;
      }
    }
    const params = record(rawParams);
    if (method === "notify.post") {
      if (!input.postNotification) throw new ExternalModuleRpcError("invalid_rpc");
      // Read-risk tools must not mutate — the same policy as kv.set and
      // auth.setCredential. A notification is not an internal side effect: it's
      // a row the user SEES and a badge count that moves, so an exception here
      // would be exactly the mismatch the read/write split exists to prevent.
      // Unlike db.query, there is no degraded read-only mode to fall back into.
      if (input.toolRisk === "read") {
        throw new ExternalModuleRpcError("forbidden_notify_mutation");
      }
      notifyCalls += 1;
      if (notifyCalls > NOTIFY_CALLS_PER_INVOCATION_CAP) {
        throw new ExternalModuleRpcError("rate_limited");
      }
      const notifyInput = notifyRequest(params);
      await input.postNotification(
        { actorUserId: input.actorUserId, requestId: input.requestId },
        {
          moduleId: input.module.id,
          title: notifyInput.title,
          body: notifyInput.body,
          eventKey: notifyInput.key,
          ...(notifyInput.href === undefined ? {} : { href: notifyInput.href })
        }
      );
      return undefined;
    }
    if (method === "fetch.request") {
      const request = fetchRequest(params);
      const staticHosts = input.module.manifest.fetchHosts ?? [];
      // #1309 (Task 24): merge in runtime-granted hosts from the module's own manifest-declared
      // KV namespace, if it has one. Opens and closes its own short-lived DataContext here — a
      // DB connection must not be held open for the duration of the outbound fetch below, which
      // targets an adversarial remote host. No new RPC branch: this calls the same
      // listModuleKvKeys the generic kv.list branch already uses, directly, since the host
      // already has workerDataContext in hand.
      const grantsNamespace = input.module.manifest.fetchHostGrantsNamespace;
      const grantedHosts = grantsNamespace
        ? await input.workerDataContext.withDataContext(
            { actorUserId: input.actorUserId, requestId: input.requestId },
            (scopedDb) =>
              listModuleKvKeys(scopedDb, {
                moduleId: input.module.id,
                namespace: grantsNamespace,
                scope: "user",
                ownerUserId: input.actorUserId
              })
          )
        : [];
      const hosts = [...staticHosts, ...grantedHosts];
      if (!hosts.length) throw new ExternalModuleRpcError("invalid_rpc");
      // A host present in `hosts` but not matching request.url's hostname is not this branch's
      // problem to catch: createHostPinnedFetch's own internal check throws
      // HostPinningViolationError ("host_not_declared"), uncaught here, same as it already does
      // today for manifest-only fetchHosts. This branch only changes what `hosts` contains.
      const response = await (input.createFetch ?? createHostPinnedFetch)(hosts)(request.url, {
        method: request.method ?? "GET",
        ...(request.headers ? { headers: request.headers } : {}),
        ...(request.bodyBase64
          ? { body: new Uint8Array(Buffer.from(request.bodyBase64, "base64")) }
          : {}),
        // #1286 Task 2e: aborts this fetch the moment the hard ceiling fires, instead
        // of letting it resolve into a dead invocation after the child is killed.
        ...(hostSignal ? { signal: hostSignal } : {})
      });
      const headers: Record<string, string> = {};
      for (const name of ["content-type", "content-length", "last-modified", "etag"]) {
        const value = response.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      return {
        status: response.status,
        headers,
        bodyBase64: Buffer.from(await response.arrayBuffer()).toString("base64")
      } satisfies ModuleFetchResponse;
    }
    // Embedding touches no table, so these three sit outside withDataContext
    // alongside fetch.request rather than beside ai.generateStructured: opening
    // a data context for a CPU-bound transform would hold a pooled connection
    // for the whole batch.
    if (method === "embed.dimensions") {
      return { dimensions: (await input.embeddingProvider()).dimensions };
    }
    if (method === "embed.embedQuery") {
      const text = stringParam(params, "text");
      // embedQuery, never embedDocument: the embedder applies a different task
      // prefix to each, and using the wrong one degrades retrieval silently.
      return { vector: await (await input.embeddingProvider()).embedQuery(text) };
    }
    if (method === "embed.embedDocuments") {
      const texts = embedTexts(params);
      const provider = await input.embeddingProvider();
      const vectors: number[][] = [];
      // Sequential on purpose: the in-process embedder is CPU-bound, so a
      // 128-wide Promise.all would stall the worker host for every other module.
      for (const text of texts) vectors.push(await provider.embedDocument(text));
      return { vectors };
    }
    return input.workerDataContext.withDataContext(
      { actorUserId: input.actorUserId, requestId: input.requestId },
      async (scopedDb) => {
        await sql`SELECT set_config('app.current_module_id', ${input.module.id}, true)`.execute(
          scopedDb.db
        );

        if (method === "db.query") {
          // #1167: only modules that declared owned tables get the SQL door; the
          // tables themselves are created/guarded by the platform installer (RLS,
          // owner-only, jarvis_mod_<slug>_runtime role) — this check is the manifest
          // gate, not the security boundary.
          const ownedTables = input.module.manifest.database?.ownedTables ?? [];
          if (ownedTables.length === 0) throw new ExternalModuleRpcError("undeclared_database");
          const text = stringParam(params, "text");
          if (params.params !== undefined && !Array.isArray(params.params)) {
            throw new ExternalModuleRpcError("invalid_rpc");
          }
          const storageRpc = createModuleStorageRpc(scopedDb, input.module.id, {
            // Read-risk tools must not mutate — same policy as kv.set's
            // forbidden_kv_mutation. "write" and "destructive" may.
            readOnly: input.toolRisk === "read"
          });
          try {
            return await storageRpc.query(
              text,
              (params.params as readonly unknown[] | undefined) ?? []
            );
          } catch (error) {
            if (error instanceof ModuleQueryError) {
              if (error.code === "forbidden_statement") {
                throw new ExternalModuleRpcError("forbidden_db_statement");
              }
              if (error.code === "forbidden_mutation") {
                throw new ExternalModuleRpcError("forbidden_db_mutation");
              }
            }
            // Cap and db_query_failed errors cross as-is: already redacted at the
            // @moss/db layer (SQLSTATE + primary message only, no detail/hint).
            // worker-runtime.ts forwards workers a generic rpc_failed regardless and
            // logs nothing for rpc errors (verified #1167 grounding).
            throw error;
          }
        }

        if (method === "ai.generateStructured") {
          // Handlers built without the ai dep (e.g. the queued-jobs path) fail
          // closed: resume prose must never flow through pg-boss payloads.
          if (!input.ai) throw new ExternalModuleRpcError("invalid_rpc");
          if (input.toolRisk === "read") throw new ExternalModuleRpcError("forbidden_ai_call");
          // #1286 Task 2e: hostSignal is host-side only and never part of the wire
          // params aiRequest() parses — attach it after parsing, not inside it, so it
          // can never be spoofed by anything the module sends.
          const request: ExternalModuleAiRequest = {
            ...aiRequest(params),
            ...(hostSignal ? { signal: hostSignal } : {})
          };
          // D6 composition guard: reject prompts/schemas containing any credential
          // resolved via auth.getCredential during this invocation (defense in
          // depth on top of the child-side transport containsSecret check).
          const schemaJson = JSON.stringify(request.schema);
          for (const secret of resolvedSecrets) {
            if (request.prompt.includes(secret) || schemaJson.includes(secret)) {
              throw new ExternalModuleRpcError("forbidden_secret_in_ai_input");
            }
          }
          aiCalls += 1;
          if (aiCalls > AI_CALLS_PER_INVOCATION_CAP) {
            return { ok: false, error: "usage_limited" } satisfies ExternalModuleAiResult;
          }
          const result = await input.ai(scopedDb, request);
          // Rebuild the envelope from scratch: host-side extras (usage, model or
          // provider ids) must never cross into module workers.
          if (result.ok) return { ok: true, object: result.object };
          return {
            ok: false,
            error: AI_ERRORS.has(result.error) ? result.error : "provider_error"
          } satisfies ExternalModuleAiResult;
        }

        if (method === "auth.getCredential") {
          const authId = stringParam(params, "authId");
          const declaration = declarations.get(authId);
          if (!declaration) throw new ExternalModuleRpcError("undeclared_auth");
          const envelope = await readModuleCredentialSecret(scopedDb, {
            moduleId: input.module.id,
            credentialId: authId,
            scope: declaration.scope,
            ownerUserId: declaration.scope === "user" ? input.actorUserId : null
          });
          if (!envelope) throw new ExternalModuleRpcError("credential_missing");
          const value = input.cipher.decryptJson(envelope).value;
          if (typeof value !== "string") throw new ExternalModuleRpcError("credential_missing");
          rememberSecret(value);
          resolvedSecrets.add(value);
          return value;
        }

        if (method === "auth.setCredential") {
          // FIN-00 #1145: workers may persist runtime-minted secrets (e.g. an
          // OAuth-style token exchange) into DECLARED, USER-scope slots only.
          // Instance slots stay human-written via admin settings routes, and
          // migration 0171 enforces the same rule at the database.
          const authId = stringParam(params, "authId");
          const declaration = declarations.get(authId);
          if (!declaration) throw new ExternalModuleRpcError("undeclared_auth");
          if (declaration.scope !== "user") {
            throw new ExternalModuleRpcError("forbidden_instance_credential_write");
          }
          if (input.toolRisk === "read") {
            throw new ExternalModuleRpcError("forbidden_credential_write");
          }
          const value = params.value;
          if (
            typeof value !== "string" ||
            value.length === 0 ||
            Buffer.byteLength(value, "utf8") > 32 * 1024
          ) {
            throw new ExternalModuleRpcError("credential_value_invalid");
          }
          await upsertModuleCredential(
            scopedDb,
            {
              moduleId: input.module.id,
              credentialId: authId,
              scope: "user",
              ownerUserId: input.actorUserId,
              displayName: declaration.displayName,
              encryptedSecret: input.cipher.encryptJson({ value }),
              actorUserId: input.actorUserId,
              requestId: input.requestId
            },
            // Metadata-only audit via the sanctioned cross-module API; override
            // the repository's default action so worker writes are distinguishable
            // from owner-PUT writes in the audit trail (spec D1).
            (event) =>
              recordAuditEvent(scopedDb, { ...event, action: "module.credential.worker-set" })
          );
          // Same redaction posture as getCredential: the just-written value must
          // never appear in ai/fetch inputs or worker stdout for this invocation.
          rememberSecret(value);
          resolvedSecrets.add(value);
          return undefined;
        }

        const scope = scopeParam(params);
        const namespace = stringParam(params, "namespace");
        const declaration = storage.get(namespace);
        if (!declaration || !declaration.scopes.includes(scope)) {
          throw new ExternalModuleRpcError("undeclared_namespace");
        }
        const ownerUserId = scope === "user" ? input.actorUserId : null;
        const base = { moduleId: input.module.id, namespace, scope, ownerUserId };
        if (method === "kv.list") return listModuleKvKeys(scopedDb, base);
        const key = stringParam(params, "key");
        const target = { ...base, key };
        if (method === "kv.get") return getModuleKvValue(scopedDb, target);
        if (method !== "kv.set" && method !== "kv.delete") {
          throw new ExternalModuleRpcError("invalid_rpc");
        }
        if (input.toolRisk === "read") {
          throw new ExternalModuleRpcError("forbidden_kv_mutation");
        }
        // FIN-00 #1145: default stays admin-gated; a namespace whose reviewed,
        // hash-pinned manifest declares instanceWritePolicy "module" opts its
        // instance rows into handler writes for any acting user.
        if (
          scope === "instance" &&
          declaration.instanceWritePolicy !== "module" &&
          !(await input.isActorAdmin())
        ) {
          throw new ExternalModuleRpcError("forbidden_instance_kv_write");
        }
        if (method === "kv.delete") return deleteModuleKvKey(scopedDb, target);
        const value = record(params.value);
        await setModuleKvValue(scopedDb, target, value);
        return undefined;
      }
    );
  };
}

function fetchRequest(value: Record<string, unknown>): ModuleFetchRequest {
  const allowed = new Set(["url", "method", "headers", "bodyBase64"]);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    typeof value.url !== "string" ||
    (value.method !== undefined && value.method !== "GET" && value.method !== "POST") ||
    (value.bodyBase64 !== undefined &&
      (typeof value.bodyBase64 !== "string" ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.bodyBase64)))
  ) {
    throw new ExternalModuleRpcError("invalid_rpc");
  }
  let headers: Record<string, string> | undefined;
  if (value.headers !== undefined) {
    const raw = record(value.headers);
    if (Object.values(raw).some((header) => typeof header !== "string")) {
      throw new ExternalModuleRpcError("invalid_rpc");
    }
    headers = raw as Record<string, string>;
  }
  if ((value.method ?? "GET") === "GET" && value.bodyBase64 !== undefined) {
    throw new ExternalModuleRpcError("invalid_rpc");
  }
  return {
    url: value.url,
    ...(value.method === undefined ? {} : { method: value.method }),
    ...(headers === undefined ? {} : { headers }),
    ...(value.bodyBase64 === undefined ? {} : { bodyBase64: value.bodyBase64 as string })
  };
}

function aiRequest(value: Record<string, unknown>): ExternalModuleAiRequest {
  const allowed = new Set(["schema", "prompt", "maxOutputTokens", "tierHint"]);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    typeof value.prompt !== "string" ||
    value.prompt.length === 0 ||
    (value.maxOutputTokens !== undefined &&
      (!Number.isInteger(value.maxOutputTokens) ||
        (value.maxOutputTokens as number) <= 0 ||
        (value.maxOutputTokens as number) > AI_MAX_OUTPUT_TOKENS_CAP)) ||
    (value.tierHint !== undefined && !AI_TIERS.has(value.tierHint as string))
  ) {
    throw new ExternalModuleRpcError("invalid_rpc");
  }
  const schema = record(value.schema);
  return {
    schema,
    prompt: value.prompt,
    ...(value.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: value.maxOutputTokens as number }),
    ...(value.tierHint === undefined
      ? {}
      : { tierHint: value.tierHint as ExternalModuleAiRequest["tierHint"] })
  };
}

/**
 * Validates an embedDocuments batch before the provider is touched at all, so
 * the cap is a guard rather than a post-hoc check on work already done.
 */
function embedTexts(value: Record<string, unknown>): readonly string[] {
  if (Object.keys(value).some((key) => key !== "texts") || !Array.isArray(value.texts)) {
    throw new ExternalModuleRpcError("invalid_rpc", "embed.embedDocuments needs a texts array");
  }
  if (value.texts.length > EMBED_BATCH_MAX) {
    throw new ExternalModuleRpcError(
      "invalid_rpc",
      `embed.embedDocuments accepts at most ${EMBED_BATCH_MAX} texts per call`
    );
  }
  if (value.texts.some((text) => typeof text !== "string" || text.length === 0)) {
    throw new ExternalModuleRpcError(
      "invalid_rpc",
      "embed.embedDocuments texts must all be non-empty strings"
    );
  }
  return value.texts as readonly string[];
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExternalModuleRpcError("invalid_rpc");
  }
  return value as Record<string, unknown>;
}

function stringParam(value: Record<string, unknown>, key: string): string {
  const found = value[key];
  if (typeof found !== "string" || found.length === 0) {
    // #1306: name the offending param. `detail` is host-log-only and never crosses the worker
    // boundary (see ExternalModuleRpcError), so this costs the module nothing — it still sees
    // only `invalid_rpc`. Without it, ten call sites share one indistinguishable failure and a
    // module author debugging from host logs cannot tell which argument was rejected, or that
    // "" is rejected at all rather than merely a wrong type.
    throw new ExternalModuleRpcError(
      "invalid_rpc",
      `${key} must be a non-empty string (received ${typeof found === "string" ? "an empty string" : typeof found})`
    );
  }
  return found;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function attachmentIdParam(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const params = value as Record<string, unknown>;
  if (Object.keys(params).length !== 1 || typeof params.attachmentId !== "string") {
    return undefined;
  }
  return UUID_RE.test(params.attachmentId) ? params.attachmentId : undefined;
}

function scopeParam(value: Record<string, unknown>): "instance" | "user" {
  const scope = value.scope;
  if (scope !== "instance" && scope !== "user") {
    throw new ExternalModuleRpcError("invalid_rpc");
  }
  return scope;
}

const NOTIFY_ALLOWED_KEYS = new Set(["key", "title", "body", "href"]);
const NOTIFY_KEY_MAX = 200;
const NOTIFY_TITLE_MAX = 200;
const NOTIFY_BODY_MAX = 2000;

/**
 * Validate and reconstruct a clean notify.post payload — same "allow-list,
 * rebuild the object" pattern as fetchRequest/aiRequest below, so a caller can
 * never smuggle an extra field through to the repository. Caps are REJECTED,
 * never coerced/truncated: a module that overflows a cap has a bug worth
 * surfacing, not content worth silently mangling.
 */
function notifyRequest(value: Record<string, unknown>): {
  readonly key: string;
  readonly title: string;
  readonly body: string;
  readonly href?: string;
} {
  for (const k of Object.keys(value)) {
    if (!NOTIFY_ALLOWED_KEYS.has(k)) throw new ExternalModuleRpcError("invalid_rpc");
  }
  const key = stringParam(value, "key");
  const title = stringParam(value, "title");
  const body = stringParam(value, "body");
  if (key.length > NOTIFY_KEY_MAX) {
    throw new ExternalModuleRpcError(
      "invalid_rpc",
      `notify.post key must be at most ${NOTIFY_KEY_MAX} characters`
    );
  }
  if (title.length > NOTIFY_TITLE_MAX) {
    throw new ExternalModuleRpcError(
      "invalid_rpc",
      `notify.post title must be at most ${NOTIFY_TITLE_MAX} characters`
    );
  }
  if (body.length > NOTIFY_BODY_MAX) {
    throw new ExternalModuleRpcError(
      "invalid_rpc",
      `notify.post body must be at most ${NOTIFY_BODY_MAX} characters`
    );
  }
  return { key, title, body, href: notifyHref(value.href) };
}

/**
 * Same-origin path only — never an absolute URL, protocol-relative URL, or a
 * scheme. Checked here AND again in NotificationsRepository (defense in depth
 * against open redirect): a caller that only guards one of the two layers is
 * one refactor away from losing the guarantee entirely.
 */
function notifyHref(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  // #743 security finding 4: the same rule the repository and push payload use.
  if (!isSameOriginAppPath(value)) {
    throw new ExternalModuleRpcError("invalid_rpc", "notify.post href must be a same-origin path");
  }
  return value;
}
