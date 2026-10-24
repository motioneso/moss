import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { createDatabase, DataContextRunner } from "@moss/db";
import { PreferencesRepository } from "@moss/structured-state";
import {
  MeetingPreferencesRepository,
  MEETING_TRANSCRIPT_LANGUAGE_KEY
} from "../../packages/meetings/src/preferences.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";
const app = createDatabase({ connectionString: connectionStrings.app, maxConnections: 6 });
const context = new DataContextRunner(app);
const owner = { actorUserId: ids.userA },
  other = { actorUserId: ids.userB };
const preferences = new MeetingPreferencesRepository();
beforeAll(async () => {
  await resetFoundationDatabase();
  // Isolated gate-only negative controls must make the corresponding regression red.
  const control = process.env.VOCCI_VOCABULARY_NEGATIVE_CONTROL;
  if (control === "lock") vi.spyOn(PreferencesRepository.prototype, "lock").mockResolvedValue();
  if (control === "rls") {
    const bootstrap = createDatabase({ connectionString: connectionStrings.bootstrap });
    try {
      await sql`ALTER TABLE app.preferences DISABLE ROW LEVEL SECURITY`.execute(bootstrap);
    } finally {
      await bootstrap.destroy();
    }
  }
});
afterAll(async () => {
  vi.restoreAllMocks();
  await app.destroy();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe("owner-scoped atomic Meeting vocabulary", () => {
  it("defaults empty, isolates owners, normalizes, and rejects invalid partial transitions", async () => {
    expect(
      await context.withDataContext(other, (db) => preferences.getTranscriptionOptions(db))
    ).toEqual({});
    await context.withDataContext(owner, (db) =>
      preferences.update(db, {
        transcriptLanguage: "en",
        transcriptVocabulary: [" Moss ", "Vocci", "Moss"]
      })
    );
    expect(
      await context.withDataContext(owner, (db) => preferences.getTranscriptionOptions(db))
    ).toEqual({ language: "en", prompt: "Moss, Vocci" });
    expect(
      await context.withDataContext(other, (db) => preferences.getTranscriptionOptions(db))
    ).toEqual({});
    await expect(
      context.withDataContext(owner, (db) => preferences.update(db, { transcriptLanguage: null }))
    ).rejects.toMatchObject({ code: "meeting_vocabulary_invalid" });
    await expect(
      context.withDataContext(other, (db) =>
        preferences.update(db, { transcriptVocabulary: ["Other"] })
      )
    ).rejects.toMatchObject({ code: "meeting_vocabulary_invalid" });
    await context.withDataContext(owner, (db) =>
      preferences.update(db, { transcriptVocabulary: [], transcriptLanguage: null })
    );
    expect(
      await context.withDataContext(owner, (db) => preferences.getTranscriptionOptions(db))
    ).toEqual({});
  });
  it("serializes concurrent clear-language and save-vocabulary before validation", async () => {
    await context.withDataContext(owner, (db) =>
      preferences.update(db, { transcriptLanguage: "en", transcriptVocabulary: [] })
    );
    const admitted = deferred(),
      release = deferred(),
      attempted = deferred();
    class PausedStore extends PreferencesRepository {
      override async upsert(...args: Parameters<PreferencesRepository["upsert"]>) {
        if (args[1] === MEETING_TRANSCRIPT_LANGUAGE_KEY) {
          admitted.resolve();
          await release.promise;
        }
        return super.upsert(...args);
      }
    }
    class ObservedStore extends PreferencesRepository {
      override async lock(...args: Parameters<PreferencesRepository["lock"]>) {
        attempted.resolve();
        return super.lock(...args);
      }
    }
    const clearing = context.withDataContext(owner, (db) =>
      new MeetingPreferencesRepository(new PausedStore()).update(db, { transcriptLanguage: null })
    );
    await admitted.promise;
    const saving = context.withDataContext(owner, (db) =>
      new MeetingPreferencesRepository(new ObservedStore()).update(db, {
        transcriptVocabulary: ["Moss"]
      })
    );
    // Attach rejection ownership before releasing the lock.
    const saved = saving.then(
      () => true,
      () => false
    );
    await attempted.promise;
    await Promise.race([saved, new Promise((resolve) => setTimeout(resolve, 200))]);
    release.resolve();
    await clearing;
    expect(await saved).toBe(false);
    expect(
      await context.withDataContext(owner, (db) => preferences.getTranscriptionOptions(db))
    ).toEqual({});
  });
  it("reads a coherent language/vocabulary pair across an atomic transition", async () => {
    await context.withDataContext(owner, (db) =>
      preferences.update(db, { transcriptLanguage: "en", transcriptVocabulary: ["English"] })
    );
    const stored = new PreferencesRepository();
    let transitioned = false;
    const transition = async () => {
      if (transitioned) return;
      transitioned = true;
      await context.withDataContext(owner, (db) =>
        preferences.update(db, { transcriptLanguage: "ja", transcriptVocabulary: ["日本語"] })
      );
    };
    class TransitionStore extends PreferencesRepository {
      override async get(...args: Parameters<PreferencesRepository["get"]>) {
        const result = await stored.get(...args);
        if (args[1] === MEETING_TRANSCRIPT_LANGUAGE_KEY) await transition();
        return result;
      }
      override async getMany(...args: Parameters<PreferencesRepository["getMany"]>) {
        const result = await stored.getMany(...args);
        await transition();
        return result;
      }
    }
    const result = await context.withDataContext(owner, (db) =>
      new MeetingPreferencesRepository(new TransitionStore()).getTranscriptionOptions(db)
    );
    expect(result).toEqual({ language: "en", prompt: "English" });
    expect(
      await context.withDataContext(owner, (db) => preferences.getTranscriptionOptions(db))
    ).toEqual({ language: "ja", prompt: "日本語" });
  });
});
