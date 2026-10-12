# Moss extensions: shared interfaces across the phase 1 plans

Spec: `docs/superpowers/specs/2026-10-11-moss-extensions-design.md`

Phase 1 is split into four plans. This file fixes the names and types they share, so each plan can
be written and built without reading the others. A plan may add private helpers, but must not
rename or reshape anything here. A change to this file needs all four plans updated in the same
pull request.

## Plans and order

| Plan                                                     | Builds                                                                                                                   | Depends on |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------- |
| `2026-10-11-moss-extensions-phase0-decision-model-on.md` | Phase 0                                                                                                                  | Nothing    |
| `2026-10-11-moss-extensions-1a-engine.md`                | Sealed engine and guest runner (spec 1.3-1.6, 2.8 report)                                                                | Nothing    |
| `2026-10-11-moss-extensions-1c-file-splits.md`           | Behaviour-neutral splits (spec 2.5)                                                                                      | Nothing    |
| `2026-10-11-moss-extensions-1b-points-storage-tools.md`  | Point registry, storage, point runner, tools, screens (spec 1.1, 1.2, 1.7, 1.8, 1.10, 2.1-2.3, 2.6, 2.7, 2.9-2.12, 3, 4) | 1a         |
| `2026-10-11-moss-extensions-1d-trial-points.md`          | The trial points, news fencing, live proof (spec 1.9, 5, Live proof)                                                     | 1b, 1c     |

## Package

- `packages/extensions`, package name `@moss/extensions`, a module with its own `manifest.ts` and
  `sql/`, following the layout of `packages/news`.
- Schemas use `@sinclair/typebox`, as the rest of the repo does.

## Guest runner (plan 1a, types in `packages/extensions/src/engine/types.ts`, re-exported from `run-guest.ts`)

```ts
export type FailureCode =
  | "threw"
  | "guest_time"
  | "elapsed_time"
  | "memory"
  | "bytes"
  | "api_calls"
  | "api_refused"
  | "output_schema"
  | "output_rule"
  | "incompatible"
  | "builtin_failed";

// Host-built only. Never carries guest-supplied text (spec 2.8).
export interface FailureReport {
  code: FailureCode;
  line: number | null;
  column: number | null;
  errorType: string | null; // constructor name, letters and digits only, max 40 chars
  schemaPath: string | null; // for output_schema / output_rule
}

export interface GuestLimits {
  guestTimeMs: number;
  elapsedMs: number;
  memoryBytes: number; // 16 MB engine heap setting; the real bound is the capped WebAssembly memory, about 34 MB (plan 1a)
  stackBytes: number; // 32 KB; 64 KB and up crashed the host in the plan 1a prototype
  maxApiCalls: number; // 5
  maxConcurrentApiCalls: number; // 2
  bytes: {
    code: number; // 64 KB
    input: number; // 256 KB
    apiRequest: number; // 4 KB
    apiReply: number; // 256 KB
    builtInAnswer: number; // 256 KB
    errorMessage: number; // 4 KB
    output: number; // 256 KB
    total: number; // 1 MB
  };
}

// The host-owned built-in. Started at most once by the runner or the fallback.
export interface BuiltInHandle<O> {
  // Starts the built-in on first call, returns the same promise every time.
  get(): Promise<O>;
  started(): boolean;
}

export type MossGet = (
  request: { path: string; query: Record<string, string> },
  signal: AbortSignal
) => Promise<{ ok: true; json: string } | { ok: false; code: "api_refused" }>;

export interface RunGuestInput<O> {
  code: string;
  exportName: string;
  inputJson: string;
  startedAt: Date; // frozen Date inside the engine
  builtIn: BuiltInHandle<O>;
  mossGet: MossGet | null; // null when the point has no API access
  limits: GuestLimits;
}

export type RunGuestResult =
  | { ok: true; outputJson: string }
  | { ok: false; failure: FailureReport; rawMessage: string | null }; // rawMessage capped 500 chars, owner pane only

export function runGuest<O>(input: RunGuestInput<O>): Promise<RunGuestResult>;

export function createBuiltInHandle<O>(
  run: (signal: AbortSignal) => Promise<O>,
  deadlineMs: number,
  callerSignal?: AbortSignal
): BuiltInHandle<O>;
```

`runGuest` accepts only a handle made by `createBuiltInHandle`. Callers never build a
`BuiltInHandle` by hand, so the start-once and deadline rules always hold.

## Point declaration (plan 1b, file `packages/extensions/src/points/define-point.ts`)

```ts
export type OutputRule<I, O> = (
  input: I,
  output: O
) => { ok: true } | { ok: false; schemaPath: string };

export interface ExtensionPointDef<I, O> {
  id: string; // e.g. "news.rankStories"
  ownerModule: string; // module id that declares it
  exportName: string; // the built-in's function name
  inputSchema: TSchema;
  outputSchema: TSchema;
  shapeVersion: number;
  fingerprint: string; // filled by the build step, see plan 1b
  limits: Pick<GuestLimits, "guestTimeMs" | "elapsedMs">;
  builtInDeadlineMs: number;
  sampleInput: I;
  outputRule: OutputRule<I, O>;
  apiAccess: "none" | "news_read";
}

export function defineExtensionPoint<I, O>(
  def: Omit<ExtensionPointDef<I, O>, "fingerprint">
): ExtensionPoint<I, O>;

export interface ExtensionPoint<I, O> {
  readonly def: ExtensionPointDef<I, O>;
}

// packages/extensions/src/points/registry.ts. The declaring plan (1d) supplies the
// built-in's answer for the point's sample input.
export interface RegisteredPointEntry {
  readonly point: ExtensionPoint<any, any>;
  readonly sampleBuiltInAnswer: unknown;
}
export function registerExtensionPoints(entries: readonly RegisteredPointEntry[]): void;
```

## Point runner (plan 1b, public API of `@moss/extensions`)

```ts
export interface PointCallContext {
  scopedDb: DataContextDb;
  actorUserId: string;
  requestId: string;
  signal?: AbortSignal;
  inBackgroundJob: boolean;
}

export interface PointCallResult<O> {
  value: O;
  usedRevision: number | null; // null when the built-in answered with no active version
}

export function callPoint<I, O>(
  point: ExtensionPoint<I, O>,
  ctx: PointCallContext,
  input: I,
  builtIn: (input: I, signal: AbortSignal) => Promise<O>
): Promise<PointCallResult<O>>;

// Revisions for News fencing (spec 1.9).
export function readPointRevisions(
  scopedDb: DataContextDb,
  pointIds: readonly string[]
): Promise<{ instanceRevision: number; points: Record<string, number> }>;

export const EXTENSION_REVISION_CHANGED_EVENT = "extensions.revision_changed";
// Payload: { actorUserId: string; pointIds: string[] } — ids only.
// Plan 1b PR 3 adds the payload allowlist entry for pointIds.
```

`moss.get` refuses every request in background jobs and in the worker process, because the
bridge reuses the API server's app-action machinery. News compilation runs in the worker, so
`news.chooseSources`, `news.filterStories` and `news.rankStories` never get a working `moss.get`.
Only `news.groupStories` and `news.featuredStory`, called from the API server, can use it.

## Point ids (plan 1d declares them, plan 1b lists the open files they live in)

| Id                             | Owning file after the splits                                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `chat.decisionQuestionWording` | `packages/chat/src/live/classifier-gate.ts` (after the split)                                                           |
| `chat.decisionDescriptions`    | `packages/chat/src/live/classifier-gate-wiring.ts`, `packages/integrations/src/classifier-readable-name.ts`             |
| `chat.decisionReplyWording`    | `packages/chat/src/live/classifier-gate-arguments.ts` (`renderReplyTemplate`)                                           |
| `news.chooseSources`           | the source-choice function split out of `packages/news/src/compilation/candidates.ts`                                   |
| `news.filterStories`           | `packages/news/src/compilation/filters.ts` (`applyDeterministicFilters`)                                                |
| `news.rankStories`             | `packages/news/src/compilation/rank.ts` (after the split) and `packages/news/src/ranking.ts` (`rankStories`), one point |
| `news.groupStories`            | the grouping function split out of `packages/news/src/news-service.ts`                                                  |
| `news.featuredStory`           | the server-side featured choice split out of `packages/news/src/ranking.ts`                                             |

The descriptions point spans two packages. Plan 1d declares it in `@moss/chat` and passes the
integrations names in as input, so no point crosses a module boundary.

Plan 1c fixes the exact file each split produces. Plans 1b and 1d take the file names from plan 1c.
