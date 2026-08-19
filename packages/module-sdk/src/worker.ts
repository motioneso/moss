import { createInterface } from "node:readline";

import {
  MODULE_WORKER_CONTRACT_VERSION,
  type WorkerRpcId,
  type WorkerRpcRequest,
  type WorkerRpcResponse
} from "./worker-protocol.js";
import { EMBED_BATCH_MAX } from "./index.js";
import type { ModuleFetchRequest, ModuleFetchResponse } from "./index.js";

export { MODULE_WORKER_CONTRACT_VERSION } from "./worker-protocol.js";
export { EMBED_BATCH_MAX } from "./index.js";

/**
 * Semantic-search capability backed by the instance's configured embedder
 * (#1281). Provider- and model-agnostic by construction: the module asks for
 * vectors, the host decides what produces them.
 */
export interface ModuleEmbedPort {
  /** Embed postings/documents for indexing. One vector per input, same order. */
  embedDocuments(texts: readonly string[]): Promise<number[][]>;
  /** Embed a search query (criteria text). Different task prefix from documents. */
  embedQuery(text: string): Promise<number[]>;
  /**
   * Dimensionality of the configured embedder, so callers validate their
   * pgvector column instead of hardcoding 768.
   */
  dimensions(): Promise<number>;
}

/**
 * In-app notification port (Task 2b, #1283). A generic seam: finance posts a sync
 * failure, news posts a breaking story, job-search posts new matches — the host
 * renders exactly the caller-declared fields, never model prose. `key` is renamed
 * to `eventKey` at the host boundary (worker-rpc-host.ts) so the module-facing
 * name matches the assistant tool vocabulary while the repository's column stays
 * `event_key`. Re-posting the same `key` updates the existing notification in
 * place and returns it to unread — there is no separate "update" method.
 */
export interface ModuleNotifyPort {
  post(input: {
    readonly key: string;
    readonly title: string;
    readonly body: string;
    readonly href?: string;
  }): Promise<void>;
}

export interface ModuleWorkerContext {
  readonly input: Record<string, unknown>;
  /**
   * Absolute epoch-ms deadline for this invocation (#1286 Task 2e). A handler doing
   * its own long-running work (a multi-page crawl, a batch loop) can check
   * `Date.now() < ctx.deadlineAt` between steps to wind down gracefully instead of
   * being killed mid-step.
   *
   * There is deliberately NO `ctx.signal` here. Cancelling host-held work (a pinned
   * fetch, an ai.generateStructured call) is entirely the host's job — it holds a
   * per-invocation AbortController that is aborted at the hard ceiling and passed
   * into those RPCs on the host side only. Exposing that controller's signal to the
   * module would let it observe host-internal cancellation timing it has no business
   * seeing, for a capability (checking a deadline) `deadlineAt` already provides.
   */
  readonly deadlineAt: number;
  /**
   * The current user's answers to the on/off switches this module declared in its manifest
   * (#1725), already resolved: every declared key is present, and a key the user has never
   * touched carries the manifest default. Read-only by design — a module can render
   * behaviour from a switch but can never flip one, because the switch is the user's
   * statement of intent, not the module's state. Writing is the settings page's job alone.
   *
   * Empty for a module that declares no preferences.
   */
  readonly preferences: Readonly<Record<string, boolean>>;
  readonly auth: {
    getCredential(authId: string): Promise<string>;
    setCredential(authId: string, value: string): Promise<void>;
  };
  readonly fetch: (request: ModuleFetchRequest) => Promise<ModuleFetchResponse>;
  readonly kv: {
    get(
      scope: "instance" | "user",
      namespace: string,
      key: string
    ): Promise<Record<string, unknown> | null>;
    set(
      scope: "instance" | "user",
      namespace: string,
      key: string,
      value: Record<string, unknown>
    ): Promise<void>;
    delete(scope: "instance" | "user", namespace: string, key: string): Promise<boolean>;
    list(scope: "instance" | "user", namespace: string): Promise<readonly string[]>;
  };
  // Structured generation via the host: the host fixes the service to this
  // module's id and returns only the object or a typed, provider-agnostic
  // error — never provider, model, or usage details.
  readonly ai: {
    generateStructured(input: {
      schema: Record<string, unknown>;
      prompt: string;
      maxOutputTokens?: number;
      tierHint?: "reasoning" | "interactive" | "economy";
    }): Promise<
      | { ok: true; object: unknown }
      | {
          ok: false;
          error:
            | "needs_config"
            | "validation_failed"
            | "provider_error"
            | "usage_limited"
            | "aborted";
        }
    >;
  };
  /**
   * Bounded SQL against the module's OWN declared tables (manifest
   * database.ownedTables). The host enforces the statement allowlist
   * (SELECT/INSERT/UPDATE/DELETE only), read-only tool risk, a 5s
   * statement_timeout, and 5000-row / 5 MiB result caps; failures surface
   * as generic rpc errors. Params are $1-style positional placeholders.
   */
  readonly db: {
    query<T = Record<string, unknown>>(
      text: string,
      params?: readonly unknown[]
    ): Promise<{ rows: T[] }>;
  };
  /**
   * Vectors from the instance embedder. Documents and queries are separate
   * calls on purpose — the embedder applies a different task prefix to each,
   * and collapsing them degrades retrieval invisibly.
   */
  readonly embed: ModuleEmbedPort;
  /** Actor-scoped, extracted text only; missing, foreign, or image attachments return null. */
  readonly attachments: {
    readText(attachmentId: string): Promise<{
      readonly fileName: string;
      readonly mimeType: string;
      readonly text: string;
    } | null>;
  };
  /** In-app notification post — see ModuleNotifyPort. */
  readonly notify: ModuleNotifyPort;
}

type Handler = (ctx: ModuleWorkerContext) => Promise<unknown>;

export function defineModuleWorker(input: {
  readonly handlers: Readonly<Record<string, Handler>>;
}): void {
  let nextId = 0;
  const pending = new Map<
    WorkerRpcId,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  const send = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const callParent = (method: string, params: unknown): Promise<unknown> => {
    const id = `worker:${++nextId}`;
    send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  const kv = {
    get: (scope: "instance" | "user", namespace: string, key: string) =>
      callParent("kv.get", { scope, namespace, key }) as Promise<Record<string, unknown> | null>,
    set: (
      scope: "instance" | "user",
      namespace: string,
      key: string,
      value: Record<string, unknown>
    ) => callParent("kv.set", { scope, namespace, key, value }) as Promise<void>,
    delete: (scope: "instance" | "user", namespace: string, key: string) =>
      callParent("kv.delete", { scope, namespace, key }) as Promise<boolean>,
    list: (scope: "instance" | "user", namespace: string) =>
      callParent("kv.list", { scope, namespace }) as Promise<readonly string[]>
  };
  const ai: ModuleWorkerContext["ai"] = {
    generateStructured: (aiInput) =>
      callParent("ai.generateStructured", aiInput) as ReturnType<
        ModuleWorkerContext["ai"]["generateStructured"]
      >
  };
  const db: ModuleWorkerContext["db"] = {
    query: (text, params) =>
      callParent("db.query", params === undefined ? { text } : { text, params }) as Promise<{
        rows: Record<string, unknown>[];
      }>
  } as ModuleWorkerContext["db"];
  const embed: ModuleEmbedPort = {
    // An empty batch is answered locally: there is nothing to embed, and a
    // round trip would still cost the host a config read.
    embedDocuments: async (texts) => {
      if (texts.length === 0) return [];
      // Same cap the host enforces, checked here too so a module author sees
      // why rather than a generic rpc failure travelling back over stdio.
      if (texts.length > EMBED_BATCH_MAX) {
        throw new Error(`embedDocuments accepts at most ${EMBED_BATCH_MAX} texts per call`);
      }
      return ((await callParent("embed.embedDocuments", { texts })) as { vectors: number[][] })
        .vectors;
    },
    embedQuery: async (text) =>
      ((await callParent("embed.embedQuery", { text })) as { vector: number[] }).vector,
    dimensions: async () =>
      ((await callParent("embed.dimensions", {})) as { dimensions: number }).dimensions
  };
  const attachments: ModuleWorkerContext["attachments"] = {
    readText: (attachmentId) =>
      callParent("attachments.readText", { attachmentId }) as ReturnType<
        ModuleWorkerContext["attachments"]["readText"]
      >
  };
  const notify: ModuleNotifyPort = {
    post: (postInput) => callParent("notify.post", postInput) as Promise<void>
  };

  createInterface({ input: process.stdin }).on("line", (line) => {
    void (async () => {
      let message: WorkerRpcRequest | WorkerRpcResponse;
      try {
        message = JSON.parse(line) as WorkerRpcRequest | WorkerRpcResponse;
      } catch {
        return;
      }
      if (!("method" in message)) {
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
        return;
      }
      if (message.method !== "module.invoke") return;
      const params = message.params as {
        handler?: unknown;
        input?: unknown;
        deadlineAt?: unknown;
        preferences?: unknown;
      };
      // Version-skew default (#1286 Task 2e): only a host older than this SDK change
      // would ever omit deadlineAt. 30_000 mirrors the runtime's pre-Task-2e default
      // stall timeout so an old host's behavior doesn't visibly change for a module
      // built against the new SDK.
      const deadlineAt =
        typeof params.deadlineAt === "number" ? params.deadlineAt : Date.now() + 30_000;
      const handler =
        typeof params.handler === "string" ? input.handlers[params.handler] : undefined;
      if (!handler) {
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "handler_not_found" }
        });
        return;
      }
      try {
        const result = await handler({
          input:
            params.input && typeof params.input === "object" && !Array.isArray(params.input)
              ? (params.input as Record<string, unknown>)
              : {},
          deadlineAt,
          // #1725: booleans only, and only what the host sent. A host older than this SDK
          // change omits the field entirely; {} is the honest answer there, and a module
          // that reads a key it declared still gets undefined rather than a wrong value.
          preferences: Object.fromEntries(
            Object.entries(
              params.preferences && typeof params.preferences === "object"
                ? (params.preferences as Record<string, unknown>)
                : {}
            ).filter(([, value]) => typeof value === "boolean")
          ) as Readonly<Record<string, boolean>>,
          auth: {
            getCredential: (authId) =>
              callParent("auth.getCredential", { authId }) as Promise<string>,
            setCredential: (authId, value) =>
              callParent("auth.setCredential", { authId, value }) as Promise<void>
          },
          fetch: (request) => callParent("fetch.request", request) as Promise<ModuleFetchResponse>,
          kv,
          ai,
          db,
          embed,
          attachments,
          notify
        });
        send({ jsonrpc: "2.0", id: message.id, result });
      } catch (error) {
        // #1306: the wire protocol deliberately carries no error detail to the host — a module's
        // internal failure must not become a channel for leaking whatever the exception happened to
        // close over. But discarding it entirely made a failed handler undiagnosable: the host
        // records `handler_failed` with a stack that only ever points at its own stdout reader, and
        // the real cause is gone. stderr is the right home for it — it is NOT the JSON-RPC channel
        // (stdout is), and the runtime already captures it, redacts every known secret from it, and
        // logs it host-side as "external module worker output".
        console.error(
          `module handler "${params.handler as string}" failed:`,
          error instanceof Error ? (error.stack ?? error.message) : String(error)
        );
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: "handler_failed" }
        });
      }
    })();
  });
  send({
    jsonrpc: "2.0",
    method: "worker.ready",
    params: { version: MODULE_WORKER_CONTRACT_VERSION }
  });
}
