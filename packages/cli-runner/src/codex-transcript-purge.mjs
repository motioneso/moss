// Runs AS the person's own slot account, through setpriv, mirroring
// agent-home-prepare.mjs. Codex keeps one sessions root per account, shared
// by every chat and dated by wall-clock time, and the runner never learns
// Codex's own conversation id — so a purge cannot narrow the search by date
// or id. Every Codex transcript file's first line records the working
// folder it ran in, so that is the only safe key to purge by: walk every
// dated folder under the root and delete only the files whose first line
// names this session's own working folder.
//
// Invoked with exactly one argv element: a JSON string shaped like
// { root: string, cwd: string }. Never invoked through a shell, so no
// interpolation risk.
import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

function readFirstLine(path) {
  const content = readFileSync(path, "utf8");
  const newline = content.indexOf("\n");
  return newline < 0 ? content : content.slice(0, newline);
}

function firstLineMatchesCwd(line, cwd) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return false;
  }
  return (
    record !== null &&
    typeof record === "object" &&
    record.type === "session_meta" &&
    record.payload !== null &&
    typeof record.payload === "object" &&
    record.payload.cwd === cwd
  );
}

function walk(dir, cwd) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // A missing or unreadable folder has nothing left to purge from this level.
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path, cwd);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    let line;
    try {
      line = readFirstLine(path);
    } catch {
      continue;
    }
    if (!firstLineMatchesCwd(line, cwd)) continue;
    try {
      unlinkSync(path);
    } catch {
      // A file already gone by the time this runs is not a failure to report.
    }
  }
}

function main() {
  const raw = process.argv[2];
  if (!raw) throw new Error("missing purge request argument");
  const request = JSON.parse(raw);
  walk(request.root, request.cwd);
}

main();
