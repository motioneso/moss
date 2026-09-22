import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Regression guard for #2327 — the development instance's login password must never live in
 * the repository again, in plain text or as a fresh hardcoded credential.
 *
 * The old password is intentionally NOT written as one contiguous string literal in this file —
 * it is assembled from parts at runtime, so a plain grep of this file's own diff does not carry
 * the token either. `oldOwnerPassword` below is the only place it is reconstructed.
 *
 * Two independent checks:
 *  1. The old password string, anywhere in the tree except this file. Runs over docs and code
 *     alike — a doc could just as easily reintroduce it in prose. Matched case-insensitively,
 *     plus its base64 and form-urlencoded forms (both computed at runtime, never stored), plus a
 *     copy split across a line break. A PASS HERE IS NOT AN ALL CLEAR: the password is still
 *     in public git history and on main until it is rotated, and rotation is the only real fix.
 *  2. A hardcoded sign-in credential for the development owner account (`ben@ben.com`) in
 *     non-doc files only: a literal `password: "..."` (straight, single or backtick quotes)
 *     inside the SAME object literal as the literal owner email (bounded by that object's own
 *     `{ ... }`, so it can't cross into an unrelated object elsewhere in the file), OR a
 *     `password = "..."` / `password: "..."` literal anywhere in the same non-test file as the
 *     owner email (the split-constants shape). `password: <identifier>` (reading from the
 *     environment, as the live test files now do) is not flagged. Test fixtures under `tests/`
 *     keep only the same-object check, since they legitimately hold other-account fixtures.
 *     Docs are not scanned for this check — a doc describing the pattern in prose is not a
 *     live credential.
 *
 * What is skipped, and why: dependency installs (`node_modules`), build output (`dist`,
 * `.turbo`, `coverage`), generated test output (`playwright-report`, `test-results`), git
 * metadata (`.git`), and `.claude` — the main checkout keeps every agent worktree under
 * `.claude/worktrees`, and worktrees branched from before the scrub still hold the old value,
 * so scanning them goes red over other lanes' files. Docs are never skipped: a pasted password
 * in a handoff note is the most likely way this comes back.
 *
 * On a violation this prints the file path and line number ONLY — never the matched text, so
 * a newly typed password can never leak into a public build log through this check.
 */

const rootDirectory = process.cwd();
const docExtensions = new Set([".md", ".txt", ".yml", ".yaml", ".json"]);
const codeExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
  ".py",
  ".sh",
  ".sql",
  ".html",
  ".htm",
  ".example"
]);
// The empty extension covers extensionless files (Dockerfile, .npmrc, suffix-less scripts),
// which are read as code, with a binary guard in the walk loop below.
const checkedExtensions = new Set([...docExtensions, ...codeExtensions, ""]);
const ignoredDirectories = new Set([
  "node_modules",
  "dist",
  ".turbo",
  "coverage",
  "playwright-report",
  "test-results",
  ".git",
  ".claude"
]);
const selfPath = relative(rootDirectory, new URL(import.meta.url).pathname);

const oldOwnerPassword = ["jarvis", "test", "123", "!"].join("");
const ownerEmail = "ben@ben.com";
// Every form below is derived at runtime so this file never carries a readable copy.
const lowerOldPassword = oldOwnerPassword.toLowerCase();
const base64OldPassword = Buffer.from(oldOwnerPassword, "utf8").toString("base64");
// The old password ends in "!", which `encodeURIComponent` leaves unescaped (it is a URI
// "unreserved mark"). The URI-encoded form was therefore byte-identical to the plain form and the
// "web-encoded" branch below could never run (issue #2335). A browser form submission encodes "!"
// as "%21", so derive the form-urlencoded variant instead — the genuinely different web form the
// branch claims to cover.
const urlEncodedOldPassword = new URLSearchParams([["p", oldOwnerPassword]]).toString().slice(2);
const strippedOldPassword = oldOwnerPassword.replace(/\s+/g, "").toLowerCase();

/** Derived search forms, exported so the unit test can prove they differ from the plain one. */
export const OLD_PASSWORD_FORMS = {
  base64: base64OldPassword,
  urlEncoded: urlEncodedOldPassword
} as const;

export interface FileScanResult {
  /** 1-based line numbers where the old development password appears, in any known form. */
  readonly oldPasswordLines: readonly number[];
  /** 1-based line of a hardcoded owner credential, or null when none was found. */
  readonly hardcodedCredentialLine: number | null;
}

// Matches a `{ ... }` object literal (no nested braces) that contains both the literal owner
// email and a literal `password: "..."` value (straight, single or backtick quotes), in
// either order. `${...}` interpolation is not a literal, so `$` is excluded from values.
const ownerCredentialObjectPattern = new RegExp(
  "\\{[^{}]*(?:" +
    "[\"'`]ben@ben\\.com[\"'`][^{}]*password\\s*:\\s*[\"'`][^\"'`$\\r\\n]+[\"'`]" +
    "|" +
    "password\\s*:\\s*[\"'`][^\"'`$\\r\\n]+[\"'`][^{}]*[\"'`]ben@ben\\.com[\"'`]" +
    ")[^{}]*\\}",
  "si"
);
// The split-constants shape: a quoted password literal assigned anywhere in the file.
const passwordLiteralPattern = /password\s*[:=]\s*["'`][^"'`\r\n$]+["'`]/i;

/**
 * Scans one file's contents for both guards. Pure and exported so the unit test can drive it with
 * fixtures instead of the live tree. `relativePath` only decides which guard applies: docs skip
 * the hardcoded-credential check, and `tests/` skips the split-constants shape.
 */
export function scanFileContents(relativePath: string, contents: string): FileScanResult {
  const oldPasswordLines: number[] = [];
  const seenLines = new Set<number>();
  const reportOldPassword = (line: number): void => {
    if (seenLines.has(line)) {
      return;
    }
    seenLines.add(line);
    oldPasswordLines.push(line);
  };

  const lines = contents.split(/\r\n|\r|\n/);
  lines.forEach((text, index) => {
    const lowerText = text.toLowerCase();
    if (lowerText.includes(lowerOldPassword)) {
      reportOldPassword(index + 1);
      return;
    }
    if (
      base64OldPassword !== oldOwnerPassword &&
      lowerText.includes(base64OldPassword.toLowerCase())
    ) {
      reportOldPassword(index + 1);
      return;
    }
    if (
      urlEncodedOldPassword !== oldOwnerPassword &&
      urlEncodedOldPassword !== base64OldPassword &&
      lowerText.includes(urlEncodedOldPassword.toLowerCase())
    ) {
      reportOldPassword(index + 1);
    }
  });

  // A copy split across a line break: compare with all whitespace removed, then map the
  // hit back to its line number.
  const stripped = lines.map((line) => line.replace(/\s+/g, "").toLowerCase()).join("");
  const strippedHit = stripped.indexOf(strippedOldPassword);
  if (strippedHit >= 0) {
    reportOldPassword(locateStrippedLine(lines, strippedHit));
  }

  let hardcodedCredentialLine: number | null = null;
  if (!docExtensions.has(extname(relativePath))) {
    const objectMatch = ownerCredentialObjectPattern.exec(contents);
    if (objectMatch) {
      hardcodedCredentialLine = contents.slice(0, objectMatch.index).split(/\r\n|\r|\n/).length;
    } else if (
      !relativePath.startsWith("tests/") &&
      contents.includes(ownerEmail) &&
      passwordLiteralPattern.test(contents)
    ) {
      const match = passwordLiteralPattern.exec(contents);
      hardcodedCredentialLine = match
        ? contents.slice(0, match.index).split(/\r\n|\r|\n/).length
        : 1;
    }
  }

  return { oldPasswordLines, hardcodedCredentialLine };
}

interface Violation {
  readonly path: string;
  readonly line: number;
}

async function main(): Promise<void> {
  const oldPasswordViolations: Violation[] = [];
  const hardcodedCredentialViolations: Violation[] = [];

  for await (const filePath of walk(rootDirectory)) {
    const relativePath = relative(rootDirectory, filePath);
    if (relativePath === selfPath) {
      continue;
    }
    const ext = extname(filePath);
    if (!checkedExtensions.has(ext)) {
      continue;
    }

    let contents: string;
    try {
      contents = await readFile(filePath, "utf8");
    } catch {
      continue;
    }
    if (contents.includes("\0")) {
      continue;
    }

    const result = scanFileContents(relativePath, contents);
    for (const line of result.oldPasswordLines) {
      oldPasswordViolations.push({ path: relativePath, line });
    }
    if (result.hardcodedCredentialLine !== null) {
      hardcodedCredentialViolations.push({
        path: relativePath,
        line: result.hardcodedCredentialLine
      });
    }
  }

  if (oldPasswordViolations.length > 0) {
    console.error("Old development login password found in working files:");
    for (const violation of oldPasswordViolations) {
      console.error(`- ${violation.path}:${violation.line}`);
    }
    process.exitCode = 1;
  } else {
    console.log(
      "Working files clean: old development login password not found in scanned files. " +
        "This is not an all clear: the password is still in public git history and on main " +
        "until it is rotated, and rotation is the only real fix."
    );
  }

  if (hardcodedCredentialViolations.length > 0) {
    console.error(
      `\nA literal password next to the development owner email (${ownerEmail}) — read the ` +
        "sign-in password from the environment instead (see tests/live/*.ts for the pattern):"
    );
    for (const violation of hardcodedCredentialViolations) {
      console.error(`- ${violation.path}:${violation.line}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`No hardcoded password next to the ${ownerEmail} sign-in email in scanned files.`);
  }
}

function locateStrippedLine(lines: string[], strippedIndex: number): number {
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    seen += (lines[i] ?? "").replace(/\s+/g, "").length;
    if (seen > strippedIndex) {
      return i + 1;
    }
  }
  return lines.length;
}

async function* walk(directory: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name)) {
        continue;
      }
      yield* walk(join(directory, entry.name));
      continue;
    }
    if (entry.isFile()) {
      yield join(directory, entry.name);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
