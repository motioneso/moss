// tests/uat/fixtures/scripted-provider/script-schema.ts
//
// #1121: the deterministic chat-script contract. A fixture file is data only — no loops,
// conditionals, sleeps, JS, shell, or URLs (spec's locked boundary 1) — so the schema is a closed
// set of turns, each a fixed tool-call sequence plus a fixed reply. `resolveCaptures` is the only
// dynamic behavior allowed: substituting `${name}` tokens with values captured from context
// (`firstAttachmentId`) or from a JSON-pointer (RFC 6901) into a prior call's MCP result.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { UatChatScript } from "../../seed/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "..", "chat-scripts");

const CAPTURE_TOKEN = /^\$\{([A-Za-z0-9_]+)\}$/;

export interface ChatScriptCall {
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
  /**
   * Optional: name -> RFC 6901 JSON pointer into THIS call's MCP `tools/call` result. Available to
   * later turns' `arguments`/`expectIncludes` as `${name}`. `firstAttachmentId` is reserved — it is
   * always seeded by the caller from turn context, never declared here.
   */
  readonly captures?: Readonly<Record<string, string>>;
  /**
   * Optional: when set, this call is expected to fail with exactly this MCP error text (exact
   * string equality, checked by claude-main.ts). #1883: lets a fixture assert a real dependency
   * failure without ever logging the received payload.
   */
  readonly expectedError?: string;
}

export interface ChatScriptTurn {
  readonly expectIncludes: readonly string[];
  readonly calls: readonly ChatScriptCall[];
  readonly reply: string;
}

export interface ChatScriptFixture {
  readonly version: 1;
  readonly turns: readonly ChatScriptTurn[];
}

const KNOWN_FIXTURE_KEYS = new Set(["version", "turns"]);
const KNOWN_TURN_KEYS = new Set(["expectIncludes", "calls", "reply"]);
const KNOWN_CALL_KEYS = new Set(["tool", "arguments", "captures", "expectedError"]);
const RESERVED_CAPTURE_NAMES = new Set(["firstAttachmentId"]);

function fail(id: string, reason: string): never {
  throw new Error(`[chat-script:${id}] invalid fixture: ${reason}`);
}

function assertNoUnknownKeys(
  id: string,
  obj: object,
  known: ReadonlySet<string>,
  where: string
): void {
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) fail(id, `unknown key "${key}" in ${where}`);
  }
}

function collectDeclaredCaptureNames(fixture: ChatScriptFixture): Set<string> {
  const names = new Set<string>(RESERVED_CAPTURE_NAMES);
  for (const turn of fixture.turns) {
    for (const call of turn.calls) {
      for (const name of Object.keys(call.captures ?? {})) names.add(name);
    }
  }
  return names;
}

function assertCaptureTokensDeclared(
  id: string,
  value: unknown,
  declared: ReadonlySet<string>
): void {
  if (typeof value === "string") {
    const match = CAPTURE_TOKEN.exec(value);
    if (match) {
      const name = match[1] as string; // regex has exactly one capturing group, always set on match
      if (!declared.has(name)) fail(id, `reference to undeclared capture "\${${name}}"`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertCaptureTokensDeclared(id, item, declared);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) assertCaptureTokensDeclared(id, item, declared);
  }
}

export function loadChatScriptFixture(id: UatChatScript): ChatScriptFixture {
  const path = join(FIXTURE_DIR, `${id}.json`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    fail(id, `no fixture file at ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(id, `not valid JSON (${(error as Error).message})`);
  }
  if (!parsed || typeof parsed !== "object") fail(id, "top level must be an object");
  assertNoUnknownKeys(id, parsed as object, KNOWN_FIXTURE_KEYS, "fixture");

  const { version, turns } = parsed as { version?: unknown; turns?: unknown };
  if (version !== 1) fail(id, `"version" must be 1, got ${JSON.stringify(version)}`);
  if (!Array.isArray(turns) || turns.length === 0) fail(id, `"turns" must be a non-empty array`);

  for (const [i, turn] of turns.entries()) {
    if (!turn || typeof turn !== "object") fail(id, `turns[${i}] must be an object`);
    assertNoUnknownKeys(id, turn as object, KNOWN_TURN_KEYS, `turns[${i}]`);
    const t = turn as { expectIncludes?: unknown; calls?: unknown; reply?: unknown };
    if (!Array.isArray(t.expectIncludes) || t.expectIncludes.some((s) => typeof s !== "string")) {
      fail(id, `turns[${i}].expectIncludes must be a string array`);
    }
    if (!Array.isArray(t.calls)) fail(id, `turns[${i}].calls must be an array`);
    for (const [j, call] of (t.calls as unknown[]).entries()) {
      if (!call || typeof call !== "object") fail(id, `turns[${i}].calls[${j}] must be an object`);
      assertNoUnknownKeys(id, call as object, KNOWN_CALL_KEYS, `turns[${i}].calls[${j}]`);
      const c = call as {
        tool?: unknown;
        arguments?: unknown;
        captures?: unknown;
        expectedError?: unknown;
      };
      if (typeof c.tool !== "string" || c.tool.length === 0) {
        fail(id, `turns[${i}].calls[${j}].tool must be a non-empty string`);
      }
      if (!c.arguments || typeof c.arguments !== "object" || Array.isArray(c.arguments)) {
        fail(id, `turns[${i}].calls[${j}].arguments must be an object`);
      }
      if (c.captures !== undefined) {
        if (typeof c.captures !== "object" || Array.isArray(c.captures)) {
          fail(id, `turns[${i}].calls[${j}].captures must be an object of name -> JSON pointer`);
        }
        for (const [name, pointer] of Object.entries(c.captures as Record<string, unknown>)) {
          if (RESERVED_CAPTURE_NAMES.has(name)) {
            fail(id, `turns[${i}].calls[${j}].captures declares reserved name "${name}"`);
          }
          if (typeof pointer !== "string" || !pointer.startsWith("/")) {
            fail(id, `turns[${i}].calls[${j}].captures.${name} must be an RFC 6901 JSON pointer`);
          }
        }
      }
      if (c.expectedError !== undefined) {
        if (typeof c.expectedError !== "string" || c.expectedError.length === 0) {
          fail(id, `turns[${i}].calls[${j}].expectedError must be a non-empty string`);
        }
      }
    }
    if (typeof t.reply !== "string") fail(id, `turns[${i}].reply must be a string`);
  }

  const fixture = { version: 1, turns } as ChatScriptFixture;
  const declared = collectDeclaredCaptureNames(fixture);
  assertCaptureTokensDeclared(id, fixture.turns, declared);
  return fixture;
}

function resolveJsonPointer(root: unknown, pointer: string): unknown {
  if (pointer === "") return root;
  const parts = pointer
    .split("/")
    .slice(1)
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current = root;
  for (const part of parts) {
    if (current === null || typeof current !== "object") {
      throw new Error(`JSON pointer "${pointer}" does not resolve: hit non-object at "${part}"`);
    }
    current = Array.isArray(current)
      ? current[Number(part)]
      : (current as Record<string, unknown>)[part];
    if (current === undefined) {
      throw new Error(`JSON pointer "${pointer}" does not resolve: no "${part}"`);
    }
  }
  return current;
}

/**
 * Extracts one named capture from an MCP `tools/call` result using its declared JSON pointer.
 * Called once per declared capture, right after that call's result is known.
 */
export function extractCapture(result: unknown, pointer: string): unknown {
  return resolveJsonPointer(result, pointer);
}

/**
 * Substitutes every `${name}` token in `value` (recursively through arrays/objects) with the
 * matching entry from `captures`. Throws on an unknown capture name — schema validation already
 * guarantees every token in the fixture itself is declared, so this only fires if a caller passes
 * a value containing a token the fixture never declared (a caller bug, not a fixture-authoring bug).
 */
export function resolveCaptures(value: unknown, captures: ReadonlyMap<string, unknown>): unknown {
  if (typeof value === "string") {
    const match = CAPTURE_TOKEN.exec(value);
    if (!match) return value;
    const name = match[1] as string; // regex has exactly one capturing group, always set on match
    if (!captures.has(name)) {
      throw new Error(
        `unknown capture "\${${name}}" — not yet captured at this point in the script`
      );
    }
    return captures.get(name);
  }
  if (Array.isArray(value)) return value.map((item) => resolveCaptures(item, captures));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveCaptures(item, captures)])
    );
  }
  return value;
}
