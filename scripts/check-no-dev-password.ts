import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

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
 *     plus its base64 and URL-encoded forms (both computed at runtime, never stored), plus a
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
const urlEncodedOldPassword = encodeURIComponent(oldOwnerPassword);
const strippedOldPassword = oldOwnerPassword.replace(/\s+/g, "").toLowerCase();

interface Violation {
  readonly path: string;
  readonly line: number;
}

const oldPasswordViolations: Violation[] = [];
const seenOldPasswordKeys = new Set<string>();
const hardcodedCredentialViolations: Violation[] = [];

function reportOldPassword(relativePath: string, line: number): void {
  const key = `${relativePath}:${line}`;
  if (seenOldPasswordKeys.has(key)) {
    return;
  }
  seenOldPasswordKeys.add(key);
  oldPasswordViolations.push({ path: relativePath, line });
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
  const lines = contents.split(/\r\n|\r|\n/);

  lines.forEach((text, index) => {
    const lowerText = text.toLowerCase();
    if (lowerText.includes(lowerOldPassword)) {
      reportOldPassword(relativePath, index + 1);
      return;
    }
    if (
      base64OldPassword !== oldOwnerPassword &&
      lowerText.includes(base64OldPassword.toLowerCase())
    ) {
      reportOldPassword(relativePath, index + 1);
      return;
    }
    if (
      urlEncodedOldPassword !== oldOwnerPassword &&
      urlEncodedOldPassword !== base64OldPassword &&
      lowerText.includes(urlEncodedOldPassword.toLowerCase())
    ) {
      reportOldPassword(relativePath, index + 1);
    }
  });

  // A copy split across a line break: compare with all whitespace removed, then map the
  // hit back to its line number.
  const stripped = lines.map((line) => line.replace(/\s+/g, "").toLowerCase()).join("");
  const strippedHit = stripped.indexOf(strippedOldPassword);
  if (strippedHit >= 0) {
    reportOldPassword(relativePath, locateStrippedLine(lines, strippedHit));
  }

  if (docExtensions.has(ext)) {
    continue;
  }
  const objectMatch = ownerCredentialObjectPattern.exec(contents);
  if (objectMatch) {
    const line = contents.slice(0, objectMatch.index).split(/\r\n|\r|\n/).length;
    hardcodedCredentialViolations.push({ path: relativePath, line });
    continue;
  }
  if (
    !relativePath.startsWith("tests/") &&
    contents.includes(ownerEmail) &&
    passwordLiteralPattern.test(contents)
  ) {
    const match = passwordLiteralPattern.exec(contents);
    const line = match ? contents.slice(0, match.index).split(/\r\n|\r|\n/).length : 1;
    hardcodedCredentialViolations.push({ path: relativePath, line });
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
