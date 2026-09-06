import type { ReactNode } from "react";

/**
 * Browser-safe SDK for a module's frontend ("web") contribution — the plugin seam a module uses
 * to dock routes, Today widgets, command-palette entries, and onboarding copy into apps/web
 * without apps/web hand-wiring per-module imports (docs/superpowers/specs/2026-07-04-module-web-registry.md).
 *
 * This package is bundled into the browser build. It must never import `node:*` modules or
 * anything that transitively reaches fastify/kysely/node — the same constraint `@moss/shared`
 * already carries (see CLAUDE.md "Secrets never escape" / module isolation).
 *
 * A module exposes its contribution as the default export of `src/web/index.ts(x)`, declared in
 * `package.json` under the `"./web"` subpath export. The build-time scanner
 * (`@moss/settings-ui`'s `virtual:moss-module-web`) discovers every package declaring that
 * subpath and lazily loads its contribution.
 *
 * Also re-exports the full @moss/ui component surface and the JSX runtime shim (#1388
 * Foundation) so an external module can author screens with the authored `jds-*` component set
 * without its own React dependency: `scripts/build-external-module.ts`'s web build aliases the
 * bare "react"/"react-dom" specifiers to `./runtime`/`./react-dom-runtime` and injects
 * `./runtime`'s `h`/`Fragment` as the JSX pragma target.
 */
export * from "@moss/ui";
export * from "./page-trail.js";
export * from "./runtime.js";
export interface ModuleWebContribution {
  /** Must match the module's backend manifest `id` — asserted at scan/test time. */
  readonly moduleId: string;
  readonly routes?: readonly ModuleWebRoute[];
  readonly todayWidgets?: readonly ModuleTodayWidget[];
  readonly commandPaletteEntries?: readonly ModulePaletteEntry[];
  readonly onboarding?: ModuleOnboardingContribution;
}

export interface ModuleWebRoute {
  /** Must equal one of the module's backend manifest `navigation[].path` entries. */
  readonly path: string;
  readonly title: string;
  readonly icon?: string;
  readonly order?: number;
  readonly element: ReactNode;
}

export interface ModuleTodayWidget {
  readonly slot: string;
  readonly element: ReactNode;
}

export interface ModulePaletteEntry {
  readonly id: string;
  readonly label: string;
  readonly run: () => void;
}

export interface ModuleOnboardingContribution {
  readonly tourSection?: {
    readonly id: string;
    readonly title: string;
    readonly body: string;
  };
  readonly welcomeLine?: string;
}

/**
 * Shared `fetch` wrapper for module web clients — mirrors `apps/web/src/api/client.ts`'s
 * `requestJson` exactly (same header/credentials/error-body handling) so every module's HTTP
 * calls behave identically to the platform shell's own client, without each module re-implementing
 * it (the duplicated `requestJson` previously local to `packages/sports/src/settings/index.tsx`
 * is the motivating case).
 *
 * Query-key convention: a module's React Query keys should be a `[moduleId, ...]` tuple/array
 * (e.g. `["sports", "overview"]`), matching the pre-existing convention in
 * `apps/web/src/api/query-keys.ts` — this keeps cache keys stable across the migration and lets
 * multiple surfaces (a module's own page and a Today widget) share one cached query.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message);
  }
}

export interface ApiRequestOptions extends Omit<RequestInit, "body" | "headers"> {
  readonly body?: unknown;
  readonly headers?: HeadersInit;
}

export async function requestJson<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  const hasBody = options.body !== undefined;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  headers.set("accept", "application/json");
  if (timeZone && !headers.has("X-Timezone")) headers.set("X-Timezone", timeZone);
  if (hasBody) headers.set("content-type", "application/json");

  const response = await fetch(path, {
    ...options,
    body: hasBody ? JSON.stringify(options.body) : undefined,
    credentials: "include",
    headers
  });

  if (!response.ok) {
    const { message, code } = await readErrorBody(response);
    throw new ApiError(response.status, message, code);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

async function readErrorBody(response: Response): Promise<{ message: string; code?: string }> {
  const text = await response.text();

  if (!text) {
    return { message: response.statusText };
  }

  try {
    const parsed = JSON.parse(text) as {
      readonly error?: unknown;
      readonly message?: unknown;
      readonly code?: unknown;
    };
    const raw = parsed.error ?? parsed.message;
    const message = typeof raw === "string" ? raw : response.statusText;
    const code = typeof parsed.code === "string" ? parsed.code : undefined;
    return { message, code };
  } catch {
    return { message: text };
  }
}

/**
 * A v4 UUID that also works on a plain-HTTP install.
 *
 * `crypto.randomUUID` is restricted to secure contexts, so on a LAN install served over http it is
 * simply undefined and calling it throws — which crashed Workshop's project screens outright on a
 * real http install (2026-09-05 live check). `crypto.getRandomValues` carries no such restriction.
 * These ids are sent to the API, which rejects anything that is not a UUID, so every fallback path
 * has to produce a correctly shaped v4 value rather than merely a unique string.
 */
export function randomUuid(): string {
  const webCrypto = globalThis.crypto as Crypto | undefined;
  if (typeof webCrypto?.randomUUID === "function") return webCrypto.randomUUID();

  const bytes = new Uint8Array(16);
  if (typeof webCrypto?.getRandomValues === "function") webCrypto.getRandomValues(bytes);
  else
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = (Math.random() * 256) | 0;
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
