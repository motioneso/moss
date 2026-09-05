import { sql } from "kysely";
import { assertDataContextDb, type DataContextDb } from "@moss/db";
import { SCRATCHPAD_DEFAULT_SHORTCUT } from "@moss/shared";

export interface ScratchpadState {
  readonly body: string;
  readonly revision: number;
  readonly updatedAt: Date | null;
  readonly syncToNotes: boolean;
  readonly shortcut: string;
}

export type PutScratchpadResult =
  | { readonly ok: true; readonly revision: number; readonly updatedAt: Date }
  | { readonly ok: false; readonly current: ScratchpadState };

export interface AppendScratchpadResult {
  readonly revision: number;
  readonly updatedAt: Date;
  /** The exact text that was appended, including a leading newline when the pad wasn't empty. */
  readonly appended: string;
}

export interface PatchScratchpadSettingsInput {
  readonly syncToNotes?: boolean;
  readonly shortcut?: string;
}

export interface PatchScratchpadSettingsResult {
  readonly syncToNotes: boolean;
  readonly shortcut: string;
}

/**
 * Thrown by `append` when the database's own size check rejects the write - the pad was
 * already close to full, and this append would have pushed it over. Distinct from the request
 * validation errors so callers (the route, the tool) can map it to their own "pad is full"
 * response instead of a generic 500.
 */
export class ScratchpadTooLargeError extends Error {
  constructor() {
    super("Scratchpad is full");
    this.name = "ScratchpadTooLargeError";
  }
}

/**
 * True when a database error is the `scratchpads_body_size` check constraint (Postgres code
 * 23514) rejecting an append that would push the pad past its 64,000-character limit.
 */
function isBodySizeViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  if (candidate.code !== "23514") return false;
  return candidate.constraint === undefined || candidate.constraint === "scratchpads_body_size";
}

/**
 * Owner-only, single-row-per-user scratchpad storage (#2236 slice 1). Every method requires a
 * DataContextDb (RLS-scoped, actor id already injected) - there is no other way to reach these
 * tables, by design.
 */
export class ScratchpadRepository {
  async get(scopedDb: DataContextDb): Promise<ScratchpadState> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db.selectFrom("app.scratchpads").selectAll().executeTakeFirst();
    if (!row) {
      return {
        body: "",
        revision: 0,
        updatedAt: null,
        syncToNotes: false,
        shortcut: SCRATCHPAD_DEFAULT_SHORTCUT
      };
    }
    return {
      body: row.body,
      revision: row.revision,
      updatedAt: row.updated_at,
      syncToNotes: row.sync_to_notes,
      shortcut: row.shortcut
    };
  }

  /**
   * Compare-and-swap write. `revision: 0` means "no row exists yet" and inserts a fresh one;
   * any other value must match the stored row's revision exactly or the write is rejected
   * (returns the current stored state instead of throwing, so the route can build a 409 body).
   */
  async put(
    scopedDb: DataContextDb,
    input: { body: string; revision: number }
  ): Promise<PutScratchpadResult> {
    assertDataContextDb(scopedDb);

    if (input.revision === 0) {
      const inserted = await scopedDb.db
        .insertInto("app.scratchpads")
        .values({
          user_id: sql<string>`app.current_actor_user_id()`,
          body: input.body,
          revision: 1,
          sync_to_notes: false,
          shortcut: SCRATCHPAD_DEFAULT_SHORTCUT,
          updated_at: new Date()
        })
        .onConflict((oc) => oc.column("user_id").doNothing())
        .returning(["revision", "updated_at"])
        .executeTakeFirst();

      if (!inserted) {
        return { ok: false, current: await this.get(scopedDb) };
      }
      return { ok: true, revision: inserted.revision, updatedAt: inserted.updated_at };
    }

    const updated = await scopedDb.db
      .updateTable("app.scratchpads")
      .set({ body: input.body, revision: input.revision + 1, updated_at: new Date() })
      .where("revision", "=", input.revision)
      .returning(["revision", "updated_at"])
      .executeTakeFirst();

    if (!updated) {
      return { ok: false, current: await this.get(scopedDb) };
    }
    return { ok: true, revision: updated.revision, updatedAt: updated.updated_at };
  }

  /**
   * Appends text server-side in a single statement, so two concurrent appends can't clobber
   * each other. No leading newline when the pad was empty; otherwise one newline prefix.
   */
  async append(scopedDb: DataContextDb, text: string): Promise<AppendScratchpadResult> {
    assertDataContextDb(scopedDb);

    let row: { body: string; revision: number; updated_at: Date };
    try {
      row = await scopedDb.db
        .insertInto("app.scratchpads")
        .values({
          user_id: sql<string>`app.current_actor_user_id()`,
          body: text,
          revision: 1,
          sync_to_notes: false,
          shortcut: SCRATCHPAD_DEFAULT_SHORTCUT,
          updated_at: new Date()
        })
        .onConflict((oc) =>
          oc.column("user_id").doUpdateSet({
            body: sql<string>`CASE WHEN app.scratchpads.body = '' THEN excluded.body ELSE app.scratchpads.body || E'\n' || excluded.body END`,
            revision: sql<number>`app.scratchpads.revision + 1`,
            updated_at: new Date()
          })
        )
        .returning(["body", "revision", "updated_at"])
        .executeTakeFirstOrThrow();
    } catch (error) {
      if (isBodySizeViolation(error)) throw new ScratchpadTooLargeError();
      throw error;
    }

    // The pad was empty before this write exactly when the final body equals the appended text.
    const appended = row.body === text ? text : `\n${text}`;
    return { revision: row.revision, updatedAt: row.updated_at, appended };
  }

  async patchSettings(
    scopedDb: DataContextDb,
    patch: PatchScratchpadSettingsInput
  ): Promise<PatchScratchpadSettingsResult> {
    assertDataContextDb(scopedDb);

    const updateValues: { updated_at: Date; sync_to_notes?: boolean; shortcut?: string } = {
      updated_at: new Date()
    };
    if (patch.syncToNotes !== undefined) updateValues.sync_to_notes = patch.syncToNotes;
    if (patch.shortcut !== undefined) updateValues.shortcut = patch.shortcut;

    const row = await scopedDb.db
      .insertInto("app.scratchpads")
      .values({
        user_id: sql<string>`app.current_actor_user_id()`,
        body: "",
        revision: 1,
        sync_to_notes: patch.syncToNotes ?? false,
        shortcut: patch.shortcut ?? SCRATCHPAD_DEFAULT_SHORTCUT,
        updated_at: new Date()
      })
      .onConflict((oc) => oc.column("user_id").doUpdateSet(updateValues))
      .returning(["sync_to_notes", "shortcut"])
      .executeTakeFirstOrThrow();

    return { syncToNotes: row.sync_to_notes, shortcut: row.shortcut };
  }
}
