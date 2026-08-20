// #1680. The notes-sync failure string is persisted and returned by GET /settings/notes/last-sync,
// so it is a sink: whatever reaches it is shown to the user. The previous guard redacted by error
// TYPE — one branch for NotesPathError, everything else passed its message through — which left
// raw errno messages from the #1671 path resolver (`EACCES: permission denied, lstat '<path>'`)
// carrying the caller's own requested path out to that field. These tests pin the replacement
// rule: the sink emits only strings this module built, or ones a throw site explicitly marked
// safe. Nothing else is trusted, including error types nobody has thought of yet.
import { describe, expect, it } from "vitest";

import { NotesSyncFailure, sinkSafeErrorMessage } from "../../packages/notes/src/error-sink.js";
import { NotesPathError } from "../../packages/notes/src/path-guard.js";

/** The shape Node gives an fs failure: a real Error, a `code`, and the path inside the message. */
function errnoError(code: string, path: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`${code}: permission denied, lstat '${path}'`);
  error.code = code;
  error.path = path;
  return error;
}

const SECRET_PATH = "/home/someone/.ssh/id_ed25519";

describe("sinkSafeErrorMessage", () => {
  it("does not echo the path out of an errno error", () => {
    // The exact defect #1680 was filed for. `lstat` in canonicalizeAsFarAsExists rethrows any
    // non-ENOENT errno, and the path in that message is the one the caller asked for.
    const message = sinkSafeErrorMessage(errnoError("EACCES", SECRET_PATH));
    expect(message).not.toContain(SECRET_PATH);
    expect(message).not.toContain(".ssh");
    expect(message).toContain("permission denied");
  });

  it("keeps an unrecognised errno code as a diagnostic handle", () => {
    // Codes come from libuv's fixed table, never from the input, so echoing one is safe — and it
    // is the only thing left to debug with once the message is gone.
    const message = sinkSafeErrorMessage(errnoError("EXDEV", SECRET_PATH));
    expect(message).toBe("notes sync failed (EXDEV)");
    expect(message).not.toContain(SECRET_PATH);
  });

  it("redacts an error type it has never seen", () => {
    // The property the type-keyed guard could not offer. A brand-new error class, or an old one
    // reached down a new code path, must be silent by default rather than unredacted by default.
    class SomeFutureError extends Error {
      constructor() {
        super(`failed reading ${SECRET_PATH}`);
        this.name = "SomeFutureError";
      }
    }
    const message = sinkSafeErrorMessage(new SomeFutureError());
    expect(message).not.toContain(SECRET_PATH);
    expect(message).toBe("notes sync failed (SomeFutureError)");
  });

  it("still redacts the path guard's own message", () => {
    // NotesPathError.message embeds both the requested path and the configured notes root. This
    // was the one case the old guard did cover; it must not regress while fixing the rest.
    const message = sinkSafeErrorMessage(
      new NotesPathError(
        `Path "${SECRET_PATH}" is not within allowed root "/home/someone/notes"`,
        "PATH_NOT_IN_ROOT"
      )
    );
    expect(message).toBe("path is not within the linked notes source");
    expect(message).not.toContain(SECRET_PATH);
    expect(message).not.toContain("/home/someone/notes");
  });

  it("passes through a sentence the throw site marked safe", () => {
    // NotesSyncFailure is the single opt-in: the sync composes this from counts and fragments
    // that already came out of this function, so it carries real detail without a raw message.
    expect(sinkSafeErrorMessage(new NotesSyncFailure("notes sync: all 3 file(s) failed"))).toBe(
      "notes sync: all 3 file(s) failed"
    );
  });

  it("refuses a thrown object that fakes a code, and anything not an error at all", () => {
    // `code` is just a property. A thrown plain object carrying an attacker-shaped `code` must
    // not become a free-text channel, and neither must a thrown string.
    expect(sinkSafeErrorMessage({ code: `E${SECRET_PATH}` })).toBe("notes sync failed");
    expect(sinkSafeErrorMessage(SECRET_PATH)).toBe("notes sync failed");
    expect(sinkSafeErrorMessage(null)).toBe("notes sync failed");
    expect(sinkSafeErrorMessage(undefined)).toBe("notes sync failed");
  });

  it("does not let a hostile error name become free text", () => {
    // A subclass can set `name` to anything. Bounded to an identifier-shaped string so the
    // fallback branch cannot be turned into the leak it exists to prevent.
    const error = new Error("boom");
    error.name = `Error at ${SECRET_PATH}`;
    expect(sinkSafeErrorMessage(error)).toBe("notes sync failed");
  });
});
