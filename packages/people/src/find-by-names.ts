import { sql } from "kysely";
import { assertDataContextDb } from "@moss/db";

const MAX_NAMES = 30;
const MAX_NOTE_LENGTH = 200;

export interface PersonByNameMatch {
  readonly name: string;
  readonly role: string | null;
  readonly note: string | null;
  /** The requested name that matched, as the caller wrote it. */
  readonly matchedName: string;
}

function oneLine(text: string | null): string | null {
  if (text === null) return null;
  const line =
    text
      .split(/\r?\n/)
      .find((l) => l.trim() !== "")
      ?.trim() ?? "";
  if (line === "") return null;
  return line.length > MAX_NOTE_LENGTH ? `${line.slice(0, MAX_NOTE_LENGTH - 1)}…` : line;
}

/**
 * Owner's active people whose display name or saved alias equals one of the names,
 * ignoring case. Exact match only. At most 30 names are looked up.
 */
export async function findPeopleByNames(
  scopedDb: unknown,
  ownerUserId: string,
  names: readonly string[]
): Promise<readonly PersonByNameMatch[]> {
  assertDataContextDb(scopedDb);
  const requested = new Map<string, string>();
  for (const raw of names.slice(0, MAX_NAMES)) {
    const trimmed = raw.trim();
    if (trimmed !== "" && !requested.has(trimmed.toLowerCase())) {
      requested.set(trimmed.toLowerCase(), trimmed);
    }
  }
  if (requested.size === 0) return [];
  const lowered = [...requested.keys()];

  const byName = await scopedDb.db
    .selectFrom("app.person_context_people as p")
    .select([
      "p.id",
      "p.display_name",
      "p.relationship_summary",
      "p.context_summary",
      "p.created_at"
    ])
    .where("p.owner_user_id", "=", ownerUserId)
    .where("p.status", "=", "active")
    .where(sql<boolean>`lower(p.display_name) = any(${lowered}::text[])`)
    .execute();

  const byAlias = await scopedDb.db
    .selectFrom("app.person_context_identities as i")
    .innerJoin("app.person_context_people as p", "p.id", "i.person_id")
    .select([
      "p.id",
      "p.display_name",
      "p.relationship_summary",
      "p.context_summary",
      "p.created_at",
      "i.display_value as alias"
    ])
    .where("i.owner_user_id", "=", ownerUserId)
    .where("p.owner_user_id", "=", ownerUserId)
    .where("p.status", "=", "active")
    .where("i.identity_kind", "in", ["alias", "display_name"])
    .where("i.status", "=", "active")
    .where(sql<boolean>`lower(i.display_value) = any(${lowered}::text[])`)
    .execute();

  const seen = new Set<string>();
  const out: PersonByNameMatch[] = [];
  const candidates = [
    ...byName.map((r) => ({ row: r, matched: r.display_name })),
    ...byAlias.map((r) => ({ row: r, matched: r.alias }))
  ].sort((a, b) => new Date(a.row.created_at).getTime() - new Date(b.row.created_at).getTime());
  for (const { row, matched } of candidates) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push({
      name: row.display_name,
      role: oneLine(row.relationship_summary),
      note: oneLine(row.context_summary),
      matchedName: requested.get(matched.trim().toLowerCase()) ?? matched
    });
  }
  return out;
}
