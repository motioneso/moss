import { NotesPathError } from "./path-guard.js";

/**
 * #1680. The notes-sync failure message is persisted to the `notes-last-sync` preference and
 * returned verbatim in the settings API payload (packages/settings/src/notes-source-routes.ts,
 * the `lastError` field). That makes it a sink: anything reaching it is user-visible.
 *
 * The previous guard redacted by error TYPE — one `instanceof NotesPathError` branch, everything
 * else passed through `err.message` unchanged. Two ways that fails, both live in the tree today:
 *
 *  - A new error type, or an old one down a new code path, is unredacted by default. The path
 *    resolver added in #1671 rethrows raw errno errors from `lstat` (path-guard.ts,
 *    `canonicalizeAsFarAsExists`), and Node builds those messages as
 *    `EACCES: permission denied, lstat '<path>'` — the caller's own requested path, echoed back.
 *  - It was applied at the wrong places. The worker's own catch (jobs.ts, `registerNotesWorkers`)
 *    wrote `error.message` straight into `lastError` without calling the guard at all, so every
 *    failure raised outside the per-file loop bypassed redaction entirely.
 *
 * So redact by SINK instead. This function is the only thing permitted to produce a string for
 * that field, and it never passes an arbitrary `message` through. A message is emitted only when
 * something in this file constructed it, or when the caller explicitly marked it safe by throwing
 * `NotesSyncFailure`. Anything else is described by its error CODE or class name — neither of
 * which can carry a path, because neither is built from the input.
 *
 * The deliberate consequence: a future error type nobody has thought about degrades to a generic
 * sentence rather than leaking. Defaulting to silence is the property a type-keyed allowlist could
 * not offer.
 *
 * Scope: this guards the API/preference sink only. The original error is still rethrown to
 * pg-boss, so full messages remain in the server-side worker log where an operator needs them.
 */

/**
 * A failure whose message was composed here, from counts and already-sink-safe fragments, and is
 * therefore safe to show the user. This is the one way a caller can hand a real sentence to the
 * sink — an explicit opt-in per throw site, not a blanket trust of a type.
 */
export class NotesSyncFailure extends Error {
  constructor(readonly safeMessage: string) {
    super(safeMessage);
    this.name = "NotesSyncFailure";
  }
}

/** Human sentences for the errno codes the notes sync realistically hits. */
const ERRNO_SENTENCE: Readonly<Record<string, string>> = {
  EACCES: "permission denied reading a file in the linked notes source",
  EPERM: "permission denied reading a file in the linked notes source",
  ENOENT: "a file in the linked notes source no longer exists",
  ENOTDIR: "a folder in the linked notes source is not a folder",
  EISDIR: "expected a file in the linked notes source but found a folder",
  ELOOP: "a symlink loop in the linked notes source could not be resolved",
  EMFILE: "too many open files while reading the linked notes source",
  ENFILE: "too many open files while reading the linked notes source",
  ENAMETOOLONG: "a path in the linked notes source is too long",
  EIO: "a read error occurred in the linked notes source"
};

/**
 * Errno codes are produced by libuv from a fixed table, never from the input path, so echoing an
 * unrecognised one is safe and keeps a diagnostic handle. Bounded anyway: a `code` property is
 * just a property, and nothing stops a thrown object from carrying an attacker-influenced string
 * there.
 */
const ERRNO_CODE = /^E[A-Z]{1,15}$/;

/** Class names are authored in source, never built from input — but bound them the same way. */
const SAFE_CLASS_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

const GENERIC = "notes sync failed";

export function sinkSafeErrorMessage(err: unknown): string {
  // Explicitly marked safe at the throw site.
  if (err instanceof NotesSyncFailure) return err.safeMessage;

  // Keyed off the guard's own code, not its message — the message embeds both the requested path
  // and the configured notes root (see assertWithinRoot).
  if (err instanceof NotesPathError) return "path is not within the linked notes source";

  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string" && ERRNO_CODE.test(code)) {
    const sentence = ERRNO_SENTENCE[code];
    return sentence ? `${GENERIC}: ${sentence}` : `${GENERIC} (${code})`;
  }

  // Nothing recognised. Name the kind of failure and nothing about its content.
  const name = err instanceof Error ? err.name : undefined;
  return name && SAFE_CLASS_NAME.test(name) ? `${GENERIC} (${name})` : GENERIC;
}
