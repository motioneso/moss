#!/usr/bin/env node
// PreToolUse(Bash) helper: pre-approve a narrow set of look-only shell commands so a session
// stops interrupting the user to ask about them.
//
// Why this exists: mined from this repo's stored sessions for issue #2021, 274 approval prompts
// were for commands that only read and print — 91 for `cd <somewhere> && <a read>`, 42 ls, 36
// find, 32 head, 30 grep. Each one costs a full turn. A prefix allowlist in settings.json cannot
// tell `find -print` from `find -delete`, or `sed -n` from `sed -i`, and cannot be tested; this
// script can do both.
//
// Contract: stdin is the PreToolUse JSON payload. Printing an "allow" envelope approves the call.
// Printing nothing means "no opinion" — the session asks the user exactly as it does today.
//
// THIS SCRIPT CAN NEVER REFUSE. Every failure path — bad input, an unknown command, an internal
// throw — exits 0 with empty stdout. A refusal from a different hook still wins over an approval
// from this one, so `check-gate-pipe.sh` keeps working; that is why it stays first in the list.
//
// The bar for adding anything here: it must be impossible for the command to write a file, delete
// anything, change repository state, or reach the network, whatever its arguments.

import { homedir } from "node:os";

/** Commands that only read and print, with no argument able to make them write. */
const PLAIN_READERS = new Set([
  "basename",
  "cat",
  "cut",
  "df",
  "dirname",
  "du",
  "echo",
  "file",
  "grep",
  "head",
  "ls",
  "nl",
  "pwd",
  "realpath",
  "rg",
  "sort",
  "stat",
  "tail",
  "tr",
  "uniq",
  "wc"
]);

// `awk` is deliberately absent: its print statement can redirect to a file.

/** find arguments that run or delete something. */
const FIND_WRITE_ARGS = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-fls",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-ok",
  "-okdir"
]);

/** git subcommands that only report. None of these touch the network or move a ref. */
const GIT_READ_SUBCOMMANDS = new Set([
  "blame",
  "cat-file",
  "describe",
  "diff",
  "log",
  "ls-files",
  "ls-tree",
  "rev-parse",
  "shortlog",
  "show",
  "status"
]);

/** git subcommands that report only when asked to list; they can also mutate. */
const GIT_LIST_SUBCOMMANDS = new Set(["branch", "stash", "tag", "worktree"]);
const GIT_LIST_ARGS = new Set(["-l", "--list", "-v", "list"]);

/** Words that can turn any command into any other command. */
const BANNED_WORDS = new Set(["eval", "exec", "source", "sudo", "xargs"]);

const SEPARATORS = new Set(["&&", "||", ";", "|", "\n"]);

const ALLOW = Object.freeze({ decision: "allow", rule: "read-only" });

function none(rule) {
  return { decision: "none", rule };
}

function isBoundary(text, index) {
  if (index >= text.length) {
    return true;
  }
  return " \t\n\r;|&".includes(text[index]);
}

function readDoubleQuoted(text, start) {
  let value = "";
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      if (i + 1 >= text.length) {
        return { ok: false, rule: "unparsable" };
      }
      value += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === '"') {
      return { ok: true, value, next: i + 1 };
    }
    if (ch === "`") {
      return { ok: false, rule: "command-substitution" };
    }
    if (ch === "$") {
      return { ok: false, rule: text[i + 1] === "(" ? "command-substitution" : "expansion" };
    }
    value += ch;
    i += 1;
  }
  return { ok: false, rule: "unparsable" };
}

/**
 * Split a command into words and separators, refusing anything whose meaning we cannot pin down
 * from the text alone. Only `2>&1` and `2>/dev/null` are tolerated as redirection; neither can
 * write to a file.
 */
function tokenize(command) {
  const tokens = [];
  let word = "";
  let hasWord = false;

  const flush = () => {
    if (hasWord) {
      tokens.push({ kind: "word", value: word });
      word = "";
      hasWord = false;
    }
  };

  let i = 0;
  while (i < command.length) {
    const ch = command[i];

    if (ch === " " || ch === "\t") {
      flush();
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      flush();
      tokens.push({ kind: "sep", value: "\n" });
      i += 1;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 >= command.length) {
        return { ok: false, rule: "unparsable" };
      }
      word += command[i + 1];
      hasWord = true;
      i += 2;
      continue;
    }
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) {
        return { ok: false, rule: "unparsable" };
      }
      word += command.slice(i + 1, end);
      hasWord = true;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      const quoted = readDoubleQuoted(command, i);
      if (!quoted.ok) {
        return quoted;
      }
      word += quoted.value;
      hasWord = true;
      i = quoted.next;
      continue;
    }
    if (ch === "`") {
      return { ok: false, rule: "command-substitution" };
    }
    if (ch === "$") {
      return { ok: false, rule: command[i + 1] === "(" ? "command-substitution" : "expansion" };
    }
    if ((ch === "<" || ch === ">") && command[i + 1] === "(") {
      return { ok: false, rule: "process-substitution" };
    }
    if (!hasWord && command.startsWith("2>&1", i) && isBoundary(command, i + 4)) {
      i += 4;
      continue;
    }
    if (!hasWord && command.startsWith("2>/dev/null", i) && isBoundary(command, i + 11)) {
      i += 11;
      continue;
    }
    if (ch === "<" || ch === ">") {
      return { ok: false, rule: "redirection" };
    }
    if (ch === "(" || ch === ")") {
      return { ok: false, rule: "subshell-or-group" };
    }
    if (ch === "{" || ch === "}") {
      // `{}` on its own is find's placeholder and harmless; any other brace is grouping or
      // brace expansion, both of which can produce words we never checked.
      if (!hasWord && command.startsWith("{}", i) && isBoundary(command, i + 2)) {
        word += "{}";
        hasWord = true;
        i += 2;
        continue;
      }
      return { ok: false, rule: "subshell-or-group" };
    }
    if (command.startsWith("&&", i)) {
      flush();
      tokens.push({ kind: "sep", value: "&&" });
      i += 2;
      continue;
    }
    if (ch === "&") {
      return { ok: false, rule: "background" };
    }
    if (command.startsWith("||", i)) {
      flush();
      tokens.push({ kind: "sep", value: "||" });
      i += 2;
      continue;
    }
    if (ch === "|" || ch === ";") {
      flush();
      tokens.push({ kind: "sep", value: ch });
      i += 1;
      continue;
    }

    word += ch;
    hasWord = true;
    i += 1;
  }

  flush();
  return { ok: true, tokens };
}

function splitSteps(tokens) {
  const steps = [[]];
  for (const token of tokens) {
    if (token.kind === "sep" && SEPARATORS.has(token.value)) {
      steps.push([]);
      continue;
    }
    steps[steps.length - 1].push(token.value);
  }
  return steps;
}

function allowedRoots(cwd) {
  const home = homedir();
  const roots = [`${home}/Jarv1s`, `${home}/Jarv1s-wt`, "/tmp"];
  if (typeof cwd === "string" && cwd.startsWith("/")) {
    roots.push(cwd.replace(/\/+$/, ""));
  }
  return roots;
}

function hasParentSegment(value) {
  return value.split("/").includes("..");
}

/**
 * Anything that is not an option flag is treated as a possible filesystem path. Without this,
 * approving `cat` would silently approve `cat ~/.ssh/id_rsa`.
 *
 * @returns null when the argument is fine, otherwise the rule name that stopped it.
 */
function pathProblem(argument, roots) {
  if (argument.startsWith("-")) {
    return null;
  }

  let candidate = argument;
  if (candidate === "~" || candidate.startsWith("~/")) {
    candidate = homedir() + candidate.slice(1);
  } else if (candidate.startsWith("~")) {
    return "path-outside-allowed-roots";
  }

  if (hasParentSegment(candidate)) {
    return candidate.startsWith("/")
      ? "path-outside-allowed-roots"
      : "path-escapes-working-directory";
  }

  if (!candidate.startsWith("/")) {
    return null;
  }

  const normalized = candidate.replace(/\/+$/, "") || "/";
  const inside = roots.some((root) => normalized === root || normalized.startsWith(`${root}/`));
  return inside ? null : "path-outside-allowed-roots";
}

function checkPaths(args, roots) {
  for (const argument of args) {
    const problem = pathProblem(argument, roots);
    if (problem) {
      return none(problem);
    }
  }
  return null;
}

function checkFind(args, roots) {
  for (const argument of args) {
    if (FIND_WRITE_ARGS.has(argument)) {
      return none("find-writes");
    }
  }
  return checkPaths(args, roots);
}

function checkSed(args, roots) {
  const flags = args.filter((argument) => argument.startsWith("-"));
  if (flags.some((flag) => flag === "-i" || flag === "--in-place" || flag.startsWith("-i"))) {
    return none("sed-in-place");
  }
  if (!flags.includes("-n") && !flags.includes("--quiet") && !flags.includes("--silent")) {
    return none("sed-needs-quiet");
  }

  const script = args.find((argument) => !argument.startsWith("-"));
  if (script === undefined) {
    return none("sed-needs-quiet");
  }
  // `w` and `W` write files; `e` runs a shell command.
  if (/[wWe]/.test(script)) {
    return none("sed-script-writes");
  }

  return checkPaths(
    args.filter((argument) => argument !== script),
    roots
  );
}

function checkGit(args) {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined) {
    return none("git-subcommand");
  }
  // A global flag before the subcommand can move git somewhere else entirely (`git -C /etc`).
  if (subcommand.startsWith("-")) {
    return none("git-global-flag");
  }
  if (GIT_READ_SUBCOMMANDS.has(subcommand)) {
    return null;
  }
  if (GIT_LIST_SUBCOMMANDS.has(subcommand) && rest.every((arg) => GIT_LIST_ARGS.has(arg))) {
    return null;
  }
  return none("git-subcommand");
}

function checkStep(step, index, roots) {
  if (step.length === 0) {
    return none("empty-step");
  }
  if (step.some((word) => BANNED_WORDS.has(word))) {
    return none("banned-word");
  }

  const [name, ...args] = step;

  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(name)) {
    return none("assignment-prefix");
  }
  if (name.includes("/")) {
    // An explicit path to a binary sidesteps the whole table.
    return none("not-approved");
  }

  if (name === "cd") {
    if (index !== 0) {
      return none("cd-not-first");
    }
    if (args.length !== 1) {
      return none("not-approved");
    }
    return checkPaths(args, roots);
  }
  if (name === "find") {
    return checkFind(args, roots);
  }
  if (name === "sed") {
    return checkSed(args, roots);
  }
  if (name === "git") {
    return checkGit(args);
  }
  if (PLAIN_READERS.has(name)) {
    return checkPaths(args, roots);
  }

  return none("not-approved");
}

/**
 * Decide whether a shell command is plainly read-only.
 *
 * @param {string} command the exact command the session wants to run
 * @param {string} [cwd] the working directory sent with the request, treated as an allowed root
 * @returns {{ decision: "allow", rule: "read-only" } | { decision: "none", rule: string }}
 */
export function decideReadOnly(command, cwd) {
  if (typeof command !== "string" || command.trim() === "") {
    return none("empty-command");
  }

  const tokenized = tokenize(command);
  if (!tokenized.ok) {
    return none(tokenized.rule);
  }

  const steps = splitSteps(tokenized.tokens);
  const roots = allowedRoots(cwd);

  for (let index = 0; index < steps.length; index += 1) {
    const verdict = checkStep(steps[index], index, roots);
    if (verdict) {
      return verdict;
    }
  }

  return ALLOW;
}

function readStdin() {
  return new Promise((resolve) => {
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      body += chunk;
    });
    process.stdin.on("end", () => resolve(body));
    process.stdin.on("error", () => resolve(""));
  });
}

async function main() {
  const body = await readStdin();
  let event;
  try {
    event = JSON.parse(body);
  } catch {
    return;
  }

  if (!event || typeof event !== "object" || event.tool_name !== "Bash") {
    return;
  }

  const input = event.tool_input;
  const command = input && typeof input === "object" ? input.command : undefined;
  if (typeof command !== "string") {
    return;
  }

  const verdict = decideReadOnly(command, typeof event.cwd === "string" ? event.cwd : undefined);
  if (verdict.decision !== "allow") {
    return;
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason:
          "reads and prints only; nothing it can do writes, deletes, or reaches the network"
      }
    })
  );
}

// Only run as a script, never on import from the tests.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(new URL(`file://${process.argv[1]}`).pathname);

if (invokedDirectly) {
  // A crash here must read as "no opinion", never as a refusal.
  main().catch(() => {});
  process.on("uncaughtException", () => process.exit(0));
  process.on("unhandledRejection", () => process.exit(0));
}
