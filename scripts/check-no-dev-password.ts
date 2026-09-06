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
 *     alike — a doc could just as easily reintroduce it in prose.
 *  2. A hardcoded sign-in credential for the development owner account (`ben@ben.com`) in source
 *     code only: a literal `password: "..."` string inside the SAME object literal as the
 *     literal owner email (bounded by that object's own `{ ... }`, so it can't cross into an
 *     unrelated object elsewhere in the file). `password: <identifier>` (reading from the
 *     environment, as the live test files now do) is not flagged. This check does not scan docs —
 *     a doc describing the pattern in prose is not a live credential.
 */

const rootDirectory = process.cwd();
const docExtensions = new Set([".md", ".txt", ".yml", ".yaml", ".json"]);
const codeExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const checkedExtensions = new Set([...docExtensions, ...codeExtensions]);
const ignoredDirectories = new Set(["node_modules", "dist", ".turbo", "coverage", ".git"]);
const selfPath = relative(rootDirectory, new URL(import.meta.url).pathname);

const oldOwnerPassword = ["jarvis", "test", "123", "!"].join("");
const ownerEmail = "ben@ben.com";

interface Violation {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

const oldPasswordViolations: Violation[] = [];
const hardcodedCredentialViolations: Violation[] = [];

// Matches a `{ ... }` object literal (no nested braces) that contains both the literal owner
// email and a literal `password: "..."` value, in either order.
const ownerCredentialObjectPattern = new RegExp(
  "\\{[^{}]*(?:" +
    '["\'\']ben@ben\\.com["\'][^{}]*password\\s*:\\s*["\'][^"\'$]+["\']' +
    "|" +
    'password\\s*:\\s*["\'][^"\'$]+["\'][^{}]*["\'\']ben@ben\\.com["\']' +
    ")[^{}]*\\}",
  "s"
);

for await (const filePath of walk(rootDirectory)) {
  const relativePath = relative(rootDirectory, filePath);
  if (relativePath === selfPath) {
    continue;
  }
  const ext = extname(filePath);
  if (!checkedExtensions.has(ext)) {
    continue;
  }

  const contents = await readFile(filePath, "utf8");
  const lines = contents.split(/\r\n|\r|\n/);

  lines.forEach((text, index) => {
    if (text.includes(oldOwnerPassword)) {
      oldPasswordViolations.push({ path: relativePath, line: index + 1, text: text.trim() });
    }
  });

  if (!codeExtensions.has(ext)) {
    continue;
  }
  const match = ownerCredentialObjectPattern.exec(contents);
  if (match) {
    const line = contents.slice(0, match.index).split(/\r\n|\r|\n/).length;
    hardcodedCredentialViolations.push({
      path: relativePath,
      line,
      text: match[0].replace(/\s+/g, " ").trim()
    });
  }
}

if (oldPasswordViolations.length > 0) {
  console.error("The old development login password is still present in the tree:");
  for (const violation of oldPasswordViolations) {
    console.error(`- ${violation.path}:${violation.line}  ${violation.text}`);
  }
  process.exitCode = 1;
} else {
  console.log("No occurrence of the old development login password.");
}

if (hardcodedCredentialViolations.length > 0) {
  console.error(
    "\nA literal password next to the development owner email (ben@ben.com) — read the " +
      "sign-in password from the environment instead (see tests/live/*.ts for the pattern):"
  );
  for (const violation of hardcodedCredentialViolations) {
    console.error(`- ${violation.path}:${violation.line}  ${violation.text}`);
  }
  process.exitCode = 1;
} else {
  console.log(`No hardcoded password next to the ${ownerEmail} sign-in email.`);
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
