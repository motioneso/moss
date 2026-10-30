// #1167 (#914 D5) — the statement allowlist in front of module-authored SQL.
// This is a SECURITY boundary, not a SQL parser: anything it cannot prove to
// be a single SELECT/INSERT/UPDATE/DELETE is rejected (fail closed). Known
// false positives (unquoted identifiers named like DML keywords, `LIKE'x'`
// without a space, `set_config` inside a string literal) are accepted costs —
// module authors quote identifiers or add a space.

export type ModuleStatementKind = "select" | "insert" | "update" | "delete";

export type ModuleQueryErrorCode =
  | "forbidden_statement"
  | "forbidden_mutation"
  | "row_cap_exceeded"
  | "result_byte_cap_exceeded"
  | "db_query_failed";

export class ModuleQueryError extends Error {
  constructor(
    readonly code: ModuleQueryErrorCode,
    detail: string,
    readonly sqlstate?: string
  ) {
    super(`${code}: ${detail}`);
    this.name = "ModuleQueryError";
  }
}

const STATEMENT_KINDS: Readonly<Record<string, ModuleStatementKind>> = {
  SELECT: "select",
  INSERT: "insert",
  UPDATE: "update",
  DELETE: "delete"
};

function forbidden(detail: string): ModuleQueryError {
  return new ModuleQueryError("forbidden_statement", detail);
}

/** Skip a `'…'` or `"…"` region; `''`/`""` doubling is the only escape. */
function skipQuoted(text: string, start: number): number {
  const quote = text[start]!;
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === quote) {
      if (text[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  throw forbidden("unterminated quoted literal");
}

/** PostgreSQL block comments nest; scan iteratively without treating inner words as SQL. */
function skipBlockComment(text: string, start: number): number {
  let depth = 1;
  for (let i = start + 2; i < text.length - 1; i++) {
    if (text[i] === "/" && text[i + 1] === "*") {
      depth++;
      i++;
    } else if (text[i] === "*" && text[i + 1] === "/") {
      depth--;
      i++;
      if (depth === 0) return i + 1;
    }
  }
  throw forbidden("unterminated block comment");
}

/** True when only whitespace and comments remain after `from`. */
function isOnlyTrailingTrivia(text: string, from: number): boolean {
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i]!;
    if (/\s/.test(ch)) continue;
    if (ch === "-" && text[i + 1] === "-") {
      const newline = text.indexOf("\n", i + 2);
      if (newline === -1) return true;
      i = newline;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      try {
        i = skipBlockComment(text, i) - 1;
      } catch {
        return false;
      }
      continue;
    }
    return false;
  }
  return true;
}

export function classifyModuleStatement(queryText: string): ModuleStatementKind {
  return inspectModuleStatement(queryText).kind;
}

/** Reuse the allowlist lexer so comments/quoted text cannot hide a locking read. */
export function inspectModuleStatement(queryText: string): {
  kind: ModuleStatementKind;
  locksRows: boolean;
} {
  // Fail-closed prefilters, checked against the RAW text so no lexer state can
  // hide them:
  // - set_config would spoof the RLS GUCs (app.actor_user_id / role) from
  //   inside an otherwise-allowed SELECT (volatile CTEs are guaranteed-executed).
  // - U&'…' unicode escapes can assemble "set_config" without the substring.
  // - E'…' backslash escapes (E'\'') desync skipQuoted and could hide keywords.
  if (/set_config/i.test(queryText)) throw forbidden("set_config is not allowed");
  if (/u&['"]/i.test(queryText)) throw forbidden("unicode-escaped literals are not allowed");
  // Word-boundary lookbehind: a bare "e'"/"E'" must start a new token to be an
  // E'...' escape-string prefix — without it, an ordinary literal ending in
  // "e" right before its own closing quote (e.g. 'fine') false-positives. A
  // letter/underscore predecessor is safe (the E merges into that identifier,
  // so what follows is a plain string) — but digits are NOT safe to exempt:
  // after a $1-style positional param the lexer starts a fresh token, so
  // "$1e'...'" IS parsed as an escape string by Postgres.
  if (/(?<![A-Za-z_])[eE]'/.test(queryText)) {
    throw forbidden("escape string literals are not allowed");
  }

  const lockWords: string[] = [];
  let locksRows = false;
  let depth = 0;
  let firstWord: string | undefined;
  let topLevelKind: ModuleStatementKind | undefined;
  let mutationKind: ModuleStatementKind | undefined;
  let i = 0;
  while (i < queryText.length) {
    const ch = queryText[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "-" && queryText[i + 1] === "-") {
      const newline = queryText.indexOf("\n", i + 2);
      if (newline === -1) break;
      i = newline + 1;
      continue;
    }
    if (ch === "/" && queryText[i + 1] === "*") {
      i = skipBlockComment(queryText, i);
      continue;
    }
    if (ch === "'" || ch === '"') {
      i = skipQuoted(queryText, i);
      lockWords.length = 0;
      continue;
    }
    if (ch === "$") {
      if (/[0-9]/.test(queryText[i + 1] ?? "")) {
        i += 1;
        while (i < queryText.length && /[0-9]/.test(queryText[i]!)) i += 1;
        continue;
      }
      throw forbidden("dollar-quoted strings are not allowed");
    }
    if (ch === "(") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      i += 1;
      continue;
    }
    if (ch === ";") {
      // node-postgres uses the SIMPLE query protocol for parameterless
      // queries, which executes multiple ';'-separated commands — reject here
      // rather than trusting the server to.
      if (!isOnlyTrailingTrivia(queryText, i + 1)) {
        throw forbidden("multiple SQL statements are not allowed");
      }
      break;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let end = i + 1;
      while (end < queryText.length && /[A-Za-z0-9_]/.test(queryText[end]!)) end += 1;
      const word = queryText.slice(i, end).toUpperCase();
      lockWords.push(word);
      if (lockWords.length > 4) lockWords.shift();
      const suffix = " " + lockWords.join(" ");
      if (
        ["FOR UPDATE", "FOR NO KEY UPDATE", "FOR SHARE", "FOR KEY SHARE"].some((clause) =>
          suffix.endsWith(" " + clause)
        )
      )
        locksRows = true;
      i = end;
      if (firstWord === undefined) {
        firstWord = word;
        if (word !== "WITH") {
          const kind = STATEMENT_KINDS[word];
          if (kind === undefined) throw forbidden(`statement kind ${word} is not allowed`);
          topLevelKind = kind;
          if (kind !== "select") mutationKind = kind;
        }
        continue;
      }
      if (firstWord === "WITH") {
        const kind = STATEMENT_KINDS[word];
        if (kind !== undefined) {
          // Postgres only allows data-modifying statements in WITH at the top
          // level of the query, so ANY mutation keyword under a WITH decides
          // the kind — regardless of paren depth (data-modifying CTEs).
          if (kind !== "select") mutationKind ??= kind;
          else if (depth === 0) topLevelKind ??= "select";
        }
      }
      continue;
    }
    i += 1;
  }
  if (firstWord === undefined) throw forbidden("empty statement");
  if (mutationKind !== undefined) return { kind: mutationKind, locksRows };
  if (topLevelKind === undefined) throw forbidden("no top-level statement found");
  return { kind: topLevelKind, locksRows };
}
