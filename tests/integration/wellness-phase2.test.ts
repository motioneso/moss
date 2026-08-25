import Fastify from "fastify";
import { sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DataContextRunner, createDatabase, type AccessContext } from "@moss/db";
import { ChatMemoryFactsRepository } from "@moss/memory";
import { moodIndex, moodBand } from "@moss/shared";
import { WellnessRepository, registerWellnessRoutes } from "@moss/wellness";
import { PreferencesRepository } from "@moss/structured-state";

import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";

const { Client } = pg;

const userId = "00000000-0000-4000-8000-000000000051";
const otherUserId = "00000000-0000-4000-8000-000000000052";

function ctx(actorUserId: string): AccessContext {
  return { actorUserId, requestId: "req:wellness-p2-test" };
}

let dataContext: DataContextRunner;

beforeAll(async () => {
  await resetEmptyFoundationDatabase();
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO app.users (id, email, is_instance_admin)
       VALUES ($1, 'well-p2-a@example.test', false), ($2, 'well-p2-b@example.test', false)`,
      [userId, otherUserId]
    );
  } finally {
    await client.end();
  }
  const appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  dataContext = new DataContextRunner(appDb);
});

afterAll(async () => {
  // DataContextRunner does not own the pool — no close needed here.
});

describe("taxonomy persist/reject + moodIndex/moodBand", () => {
  it("all six emotion cores persist (taxonomy accept)", async () => {
    const repo = new WellnessRepository();
    const CORES = ["happy", "sad", "fear", "anger", "disgust", "surprise"] as const;
    for (const core of CORES) {
      await expect(
        dataContext.withDataContext(ctx(userId), (db) =>
          repo.createCheckin(db, { feelingCore: core })
        )
      ).resolves.toBeDefined();
    }
  });

  it("invalid emotion core is rejected (taxonomy reject)", async () => {
    await expect(
      dataContext.withDataContext(ctx(userId), (scopedDb) =>
        scopedDb.db
          .insertInto("app.wellness_checkins")
          .values({
            owner_user_id: sql<string>`app.current_actor_user_id()` as never,
            feeling_core: "not-a-valid-core" as never
          })
          .execute()
      )
    ).rejects.toThrow();
  });

  it("moodIndex returns correct values", () => {
    expect(moodIndex("happy", 5)).toBe(5.0);
    expect(moodIndex("sad", 5)).toBe(-5.0);
    expect(moodIndex("fear", 4)).toBe(-3.2);
    expect(moodIndex("anger", 3)).toBe(-2.1);
    expect(moodIndex("disgust", 2)).toBe(-1.4);
    expect(moodIndex("surprise", 5)).toBe(1.0);
  });

  it("moodBand maps correctly", () => {
    expect(moodBand(5)).toBe("bright");
    expect(moodBand(1.5)).toBe("lifted");
    expect(moodBand(0)).toBe("even");
    expect(moodBand(-2)).toBe("low");
    expect(moodBand(-4)).toBe("heavy");
  });
});

describe("WellnessRepository — therapy notes", () => {
  const repo = new WellnessRepository();

  it("createTherapyNote + listTherapyNotes owner-scoped CRUD", async () => {
    let noteId = "";
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      const note = await repo.createTherapyNote(scopedDb, {
        body: "Feeling reflective today.",
        linkedEmotion: "sad"
      });
      noteId = note.id;
      expect(note.body).toBe("Feeling reflective today.");
      expect(note.linked_emotion).toBe("sad");
      expect(note.linked_checkin_id).toBeNull();
    });
    // owner can see it
    const ownNotes = await dataContext.withDataContext(ctx(userId), (db) =>
      repo.listTherapyNotes(db)
    );
    expect(ownNotes.some((n) => n.id === noteId)).toBe(true);
    // other user cannot see it (RLS)
    const otherNotes = await dataContext.withDataContext(ctx(otherUserId), (db) =>
      repo.listTherapyNotes(db)
    );
    expect(otherNotes.some((n) => n.id === noteId)).toBe(false);
  });

  it("deleteTherapyNote removes own note; returns false for other user's note (RLS)", async () => {
    let noteId = "";
    await dataContext.withDataContext(ctx(userId), async (db) => {
      const note = await repo.createTherapyNote(db, { body: "To be deleted." });
      noteId = note.id;
    });
    // other user cannot delete userId's note (RLS)
    const otherDel = await dataContext.withDataContext(ctx(otherUserId), (db) =>
      repo.deleteTherapyNote(db, noteId)
    );
    expect(otherDel).toBe(false);
    // owner can delete their own note
    const ownerDel = await dataContext.withDataContext(ctx(userId), (db) =>
      repo.deleteTherapyNote(db, noteId)
    );
    expect(ownerDel).toBe(true);
  });

  it("cross-owner link rejected by trigger (actor B's checkin rejected for actor A's note)", async () => {
    // Create a check-in owned by otherUserId
    let otherCheckinId = "";
    await dataContext.withDataContext(ctx(otherUserId), async (db) => {
      const checkin = await new WellnessRepository().createCheckin(db, { feelingCore: "happy" });
      otherCheckinId = checkin.id;
    });
    // userId tries to link to otherUserId's check-in — trigger should reject
    await expect(
      dataContext.withDataContext(ctx(userId), (db) =>
        repo.createTherapyNote(db, {
          body: "Trying to link to someone else's check-in.",
          linkedCheckinId: otherCheckinId
        })
      )
    ).rejects.toThrow();
  });

  it("POST therapy note with cross-owner linkedCheckinId → 404 (not 500)", async () => {
    let otherCheckinId = "";
    await dataContext.withDataContext(ctx(otherUserId), async (db) => {
      const c = await new WellnessRepository().createCheckin(db, { feelingCore: "happy" });
      otherCheckinId = c.id;
    });
    const app = Fastify();
    registerWellnessRoutes(app, {
      resolveAccessContext: async () => ({ actorUserId: userId, requestId: "req:m4-test" }),
      dataContext
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/wellness/therapy-notes",
        payload: { body: "test note", linkedCheckinId: otherCheckinId }
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("linked_checkin_id set to null when check-in is deleted (ON DELETE SET NULL)", async () => {
    let checkinId = "";
    let noteId = "";
    await dataContext.withDataContext(ctx(userId), async (db) => {
      const checkin = await repo.createCheckin(db, { feelingCore: "fear" });
      checkinId = checkin.id;
      const note = await repo.createTherapyNote(db, {
        body: "Linked note.",
        linkedCheckinId: checkinId
      });
      noteId = note.id;
    });
    // Delete the check-in directly (bypassing RLS as owner)
    await dataContext.withDataContext(ctx(userId), (db) =>
      db.db.deleteFrom("app.wellness_checkins").where("id", "=", checkinId).execute()
    );
    // Note should still exist with linked_checkin_id = null
    const notes = await dataContext.withDataContext(ctx(userId), (db) => repo.listTherapyNotes(db));
    const note = notes.find((n) => n.id === noteId);
    expect(note).toBeDefined();
    expect(note?.linked_checkin_id).toBeNull();
  });
});

describe("WellnessRepository — listLogsRange", () => {
  const repo = new WellnessRepository();

  it("scheduled logs bucketed by scheduled_for (not logged_at); PRN logs included", async () => {
    await dataContext.withDataContext(ctx(userId), async (db) => {
      const med = await repo.createMedication(
        db,
        {
          name: "RangeTest",
          frequencyType: "once_daily",
          scheduleTimes: ["08:00"]
        },
        "UTC"
      );
      // A scheduled log with scheduled_for within 30 days
      await repo.logDose(db, med.id, {
        status: "taken",
        scheduledFor: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
      });
      // A PRN log within 30 days
      const prnMed = await repo.createMedication(
        db,
        {
          name: "RangePRN",
          frequencyType: "as_needed"
        },
        "UTC"
      );
      await repo.logDose(db, prnMed.id, { status: "prn", prnReason: "headache" });

      const logs = await repo.listLogsRange(db, { sinceDays: 30 });
      const hasTaken = logs.some((l) => l.medication_id === med.id && l.status === "taken");
      const hasPrn = logs.some((l) => l.medication_id === prnMed.id && l.status === "prn");
      expect(hasTaken).toBe(true);
      expect(hasPrn).toBe(true);
    });
  });
});

describe("wellness insights — owner-scoped", () => {
  it("GET /api/wellness/insights returns ONLY actor-owned data (not other user's)", async () => {
    const repo = new WellnessRepository();
    // Seed actor with 7 backdated check-ins spanning 8 days so the low-data guard passes.
    await dataContext.withDataContext(ctx(userId), async (db) => {
      for (let i = 7; i >= 1; i--) {
        await db.db
          .insertInto("app.wellness_checkins")
          .values({
            owner_user_id: sql<string>`app.current_actor_user_id()`,
            feeling_core: "happy",
            checked_in_at: new Date(Date.now() - i * 24 * 60 * 60 * 1000)
          })
          .execute();
      }
    });
    // Seed other user with a med + taken dose so their adherence takenCount > 0
    await dataContext.withDataContext(ctx(otherUserId), async (db) => {
      await repo.createCheckin(db, { feelingCore: "happy", intensity: 5 });
      const med = await repo.createMedication(
        db,
        {
          name: "OtherMed",
          frequencyType: "once_daily",
          scheduleTimes: ["08:00"]
        },
        "UTC"
      );
      await repo.logDose(db, med.id, {
        status: "taken",
        scheduledFor: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString()
      });
    });
    const app = Fastify();
    registerWellnessRoutes(app, {
      resolveAccessContext: async () => ({ actorUserId: userId, requestId: "req:insights-scope" }),
      dataContext
    });
    await app.ready();
    try {
      const res = await app.inject({ method: "GET", url: "/api/wellness/insights" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.insights)).toBe(true);
      expect(body.insights.some((i: { key: string }) => i.key === "adherence")).toBe(true);
      // adherence insight lead should NOT reflect other user's data (they have 100%)
      const adh = body.insights.find((i: { key: string }) => i.key === "adherence");
      // other user has 1 taken/1 scheduled = 100%; if RLS leaks, actor would show 100% too
      expect(adh?.lead).toBeDefined();
      expect(adh?.lead).not.toContain("100%");
    } finally {
      await app.close();
    }
  });
});

describe("PATCH /api/wellness/checkins/:id", () => {
  it("updates own checkin and returns 200", async () => {
    const repo = new WellnessRepository();
    let checkinId = "";
    await dataContext.withDataContext(ctx(userId), async (db) => {
      const c = await repo.createCheckin(db, { feelingCore: "sad" });
      checkinId = c.id;
    });
    const app = Fastify();
    registerWellnessRoutes(app, {
      resolveAccessContext: async () => ({ actorUserId: userId, requestId: "req:patch-ck" }),
      dataContext
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/wellness/checkins/${checkinId}`,
        payload: { feelingCore: "happy", feelingSecondary: "Joy" }
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.checkin.feelingCore).toBe("happy");
      expect(body.checkin.feelingSecondary).toBe("Joy");
      expect(body.checkin.feelingTertiary).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("returns 404 for non-existent or other-user checkin", async () => {
    const app = Fastify();
    registerWellnessRoutes(app, {
      resolveAccessContext: async () => ({ actorUserId: userId, requestId: "req:patch-404" }),
      dataContext
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/wellness/checkins/00000000-0000-4000-8000-000000000999",
        payload: { feelingCore: "happy" }
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe("PATCH /api/wellness/checkins/:id — partial-update semantics (R1 regression)", () => {
  it("PATCH without sensations retains original sensations array", async () => {
    const repo = new WellnessRepository();
    let checkinId = "";
    const originalSensations = ["tight chest", "racing heart"];
    await dataContext.withDataContext(ctx(userId), async (db) => {
      const c = await repo.createCheckin(db, {
        feelingCore: "fear",
        sensations: originalSensations
      });
      checkinId = c.id;
    });
    const app = Fastify();
    registerWellnessRoutes(app, {
      resolveAccessContext: async () => ({ actorUserId: userId, requestId: "req:partial-sens" }),
      dataContext
    });
    await app.ready();
    try {
      // PATCH with only feelingCore — sensations omitted
      const res = await app.inject({
        method: "PATCH",
        url: `/api/wellness/checkins/${checkinId}`,
        payload: { feelingCore: "sad" }
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.checkin.feelingCore).toBe("sad");
      // sensations must be PRESERVED (not cleared)
      expect(body.checkin.sensations).toEqual(originalSensations);
    } finally {
      await app.close();
    }
  });

  it("PATCH with sensations:[] clears the array", async () => {
    const repo = new WellnessRepository();
    let checkinId = "";
    await dataContext.withDataContext(ctx(userId), async (db) => {
      const c = await repo.createCheckin(db, {
        feelingCore: "anger",
        sensations: ["clenched jaw"]
      });
      checkinId = c.id;
    });
    const app = Fastify();
    registerWellnessRoutes(app, {
      resolveAccessContext: async () => ({ actorUserId: userId, requestId: "req:clear-sens" }),
      dataContext
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/wellness/checkins/${checkinId}`,
        payload: { feelingCore: "anger", sensations: [] }
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.checkin.sensations).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

describe("PATCH /api/wellness/checkins/:id — partial-update bug class (C1 remediation)", () => {
  it("PATCH omitting feelingSecondary retains existing value", async () => {
    const repo = new WellnessRepository();
    let checkinId = "";
    await dataContext.withDataContext(ctx(userId), async (db) => {
      const c = await repo.createCheckin(db, { feelingCore: "happy", feelingSecondary: "Joy" });
      checkinId = c.id;
    });
    const app = Fastify();
    registerWellnessRoutes(app, {
      resolveAccessContext: async () => ({
        actorUserId: userId,
        requestId: "req:c1-secondary-retain"
      }),
      dataContext
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/wellness/checkins/${checkinId}`,
        payload: { feelingCore: "happy" }
      });
      expect(res.statusCode).toBe(200);
      // feelingSecondary omitted from PATCH — must not be erased
      expect(res.json().checkin.feelingSecondary).toBe("Joy");
    } finally {
      await app.close();
    }
  });

  it("PATCH with feelingSecondary: null explicitly clears it", async () => {
    const repo = new WellnessRepository();
    let checkinId = "";
    await dataContext.withDataContext(ctx(userId), async (db) => {
      const c = await repo.createCheckin(db, { feelingCore: "happy", feelingSecondary: "Joy" });
      checkinId = c.id;
    });
    const app = Fastify();
    registerWellnessRoutes(app, {
      resolveAccessContext: async () => ({
        actorUserId: userId,
        requestId: "req:c1-secondary-clear"
      }),
      dataContext
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/wellness/checkins/${checkinId}`,
        payload: { feelingCore: "happy", feelingSecondary: null }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().checkin.feelingSecondary).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("PATCH omitting intensity retains existing value", async () => {
    const repo = new WellnessRepository();
    let checkinId = "";
    await dataContext.withDataContext(ctx(userId), async (db) => {
      const c = await repo.createCheckin(db, { feelingCore: "sad", intensity: 4 });
      checkinId = c.id;
    });
    const app = Fastify();
    registerWellnessRoutes(app, {
      resolveAccessContext: async () => ({
        actorUserId: userId,
        requestId: "req:c1-intensity-retain"
      }),
      dataContext
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/wellness/checkins/${checkinId}`,
        payload: { feelingCore: "sad" }
      });
      expect(res.statusCode).toBe(200);
      // intensity omitted from PATCH — must not be erased
      expect(res.json().checkin.intensity).toBe(4);
    } finally {
      await app.close();
    }
  });
});

describe("PATCH /api/wellness/checkins/:id — energy triggers recall refresh (R2 regression)", () => {
  it("PATCH with energy field stores [wellness:energy-trend] fact in recall (C2 deepened)", async () => {
    const repo = new WellnessRepository();
    let checkinId = "";
    await dataContext.withDataContext(ctx(userId), async (db) => {
      const c = await repo.createCheckin(db, { feelingCore: "happy", energy: 3 });
      checkinId = c.id;
    });
    const app = Fastify();
    registerWellnessRoutes(app, {
      resolveAccessContext: async () => ({ actorUserId: userId, requestId: "req:energy-recall" }),
      dataContext
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/wellness/checkins/${checkinId}`,
        payload: { feelingCore: "happy", energy: 5 }
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.checkin.energy).toBe(5);

      // Verify the [wellness:energy-trend] fact was actually inserted/updated in the recall store,
      // not just that the HTTP response succeeded (this would catch a deleted refreshEnergyTrendFact).
      const facts = new ChatMemoryFactsRepository();
      const active = await dataContext.withDataContext(ctx(userId), (db) =>
        facts.listActiveFacts(db, userId)
      );
      const trendFact = active.find((f) => f.content.includes("[wellness:energy-trend]"));
      expect(trendFact).toBeDefined();
      expect(trendFact?.category).toBe("profile");
    } finally {
      await app.close();
    }
  });
});

describe("Wellness AI consent gates the energy-trend chat-memory fact (#769)", () => {
  const consentOffUser = "00000000-0000-4000-8000-000000000054";
  const consentRevokeUser = "00000000-0000-4000-8000-000000000055";

  beforeAll(async () => {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO app.users (id, email, is_instance_admin)
         VALUES ($1, 'well-consent-off@example.test', false),
                ($2, 'well-consent-revoke@example.test', false)
         ON CONFLICT (id) DO NOTHING`,
        [consentOffUser, consentRevokeUser]
      );
    } finally {
      await client.end();
    }
  });

  it("POST /checkins does not write the energy-trend fact when consent is explicitly OFF", async () => {
    await dataContext.withDataContext(ctx(consentOffUser), (db) =>
      new PreferencesRepository().upsert(db, "wellness.ai_consent_granted", false)
    );

    const app = Fastify();
    registerWellnessRoutes(app, {
      resolveAccessContext: async () => ({
        actorUserId: consentOffUser,
        requestId: "req:consent-off-create"
      }),
      dataContext,
      resolveActiveModules: async () => [{ id: "wellness" }]
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/wellness/checkins",
        payload: { feelingCore: "sad", intensity: 2, energy: 2 }
      });
      expect(res.statusCode).toBe(201);

      const facts = new ChatMemoryFactsRepository();
      const active = await dataContext.withDataContext(ctx(consentOffUser), (db) =>
        facts.listActiveFacts(db, consentOffUser)
      );
      expect(active.some((f) => f.content.includes("[wellness:energy-trend]"))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("PATCH /checkins/:id does not write the energy-trend fact when consent is explicitly OFF", async () => {
    await dataContext.withDataContext(ctx(consentOffUser), (db) =>
      new PreferencesRepository().upsert(db, "wellness.ai_consent_granted", false)
    );
    const repo = new WellnessRepository();
    let checkinId = "";
    await dataContext.withDataContext(ctx(consentOffUser), async (db) => {
      const c = await repo.createCheckin(db, { feelingCore: "sad", energy: 2 });
      checkinId = c.id;
    });

    const app = Fastify();
    registerWellnessRoutes(app, {
      resolveAccessContext: async () => ({
        actorUserId: consentOffUser,
        requestId: "req:consent-off-patch"
      }),
      dataContext,
      resolveActiveModules: async () => [{ id: "wellness" }]
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/wellness/checkins/${checkinId}`,
        payload: { feelingCore: "sad", energy: 4 }
      });
      expect(res.statusCode).toBe(200);

      const facts = new ChatMemoryFactsRepository();
      const active = await dataContext.withDataContext(ctx(consentOffUser), (db) =>
        facts.listActiveFacts(db, consentOffUser)
      );
      expect(active.some((f) => f.content.includes("[wellness:energy-trend]"))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("PUT /ai-consent with granted:false supersedes an already-written energy-trend fact immediately", async () => {
    // Start with explicit consent ON so the check-in path writes a fact.
    await dataContext.withDataContext(ctx(consentRevokeUser), (db) =>
      new PreferencesRepository().upsert(db, "wellness.ai_consent_granted", true)
    );

    const app = Fastify();
    registerWellnessRoutes(app, {
      resolveAccessContext: async () => ({
        actorUserId: consentRevokeUser,
        requestId: "req:consent-revoke"
      }),
      dataContext,
      resolveActiveModules: async () => [{ id: "wellness" }]
    });
    await app.ready();
    try {
      const create = await app.inject({
        method: "POST",
        url: "/api/wellness/checkins",
        payload: { feelingCore: "happy", intensity: 4, energy: 5 }
      });
      expect(create.statusCode).toBe(201);

      const facts = new ChatMemoryFactsRepository();
      const afterCreate = await dataContext.withDataContext(ctx(consentRevokeUser), (db) =>
        facts.listActiveFacts(db, consentRevokeUser)
      );
      expect(afterCreate.some((f) => f.content.includes("[wellness:energy-trend]"))).toBe(true);

      // Revoke consent via the settings endpoint — must supersede the fact right away, not
      // wait for the next check-in (#769 core requirement).
      const put = await app.inject({
        method: "PUT",
        url: "/api/wellness/ai-consent",
        payload: { granted: false }
      });
      expect(put.statusCode).toBe(200);

      const afterRevoke = await dataContext.withDataContext(ctx(consentRevokeUser), (db) =>
        facts.listActiveFacts(db, consentRevokeUser)
      );
      expect(afterRevoke.some((f) => f.content.includes("[wellness:energy-trend]"))).toBe(false);
    } finally {
      await app.close();
    }
  });
});

describe("GET /api/wellness/medications/logs — adherence summary", () => {
  it("returns per-day summary without dose/prnReason fields", async () => {
    const app = Fastify();
    registerWellnessRoutes(app, {
      resolveAccessContext: async () => ({ actorUserId: userId, requestId: "req:adh-summary" }),
      dataContext
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/wellness/medications/logs?sinceDays=7"
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.days)).toBe(true);
      expect(body.days.length).toBe(7);
      // verify structure — no raw dose/prnReason on any dose item
      for (const day of body.days as Array<{
        date: string;
        scheduledCount: number;
        takenCount: number;
        doses: Array<Record<string, unknown>>;
      }>) {
        expect(typeof day.date).toBe("string");
        expect(typeof day.scheduledCount).toBe("number");
        expect(typeof day.takenCount).toBe("number");
        expect(Array.isArray(day.doses)).toBe(true);
        for (const dos of day.doses) {
          expect(dos).not.toHaveProperty("dose");
          expect(dos).not.toHaveProperty("prnReason");
          expect(typeof dos["medicationId"]).toBe("string");
          expect(typeof dos["name"]).toBe("string");
          expect(typeof dos["prn"]).toBe("boolean");
        }
      }
    } finally {
      await app.close();
    }
  });
});

describe("GET/PUT /api/wellness/ai-consent", () => {
  it("returns inherited effective consent when no explicit preference exists", async () => {
    const app = Fastify();
    registerWellnessRoutes(app, {
      resolveAccessContext: async () => ({ actorUserId: userId, requestId: "req:ai-consent" }),
      dataContext,
      resolveActiveModules: async () => [{ id: "wellness" }]
    });
    await dataContext.withDataContext(ctx(userId), (db) =>
      new PreferencesRepository().delete(db, "wellness.ai_consent_granted")
    );
    await app.ready();
    try {
      const res = await app.inject({ method: "GET", url: "/api/wellness/ai-consent" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ effective: true, explicit: null });
    } finally {
      await app.close();
    }
  });

  it("persists explicit consent and returns the effective state", async () => {
    const app = Fastify();
    registerWellnessRoutes(app, {
      resolveAccessContext: async () => ({ actorUserId: userId, requestId: "req:ai-consent-put" }),
      dataContext,
      resolveActiveModules: async () => [{ id: "wellness" }]
    });
    await app.ready();
    try {
      const put = await app.inject({
        method: "PUT",
        url: "/api/wellness/ai-consent",
        payload: { granted: false }
      });
      expect(put.statusCode).toBe(200);
      expect(put.json()).toEqual({ effective: false, explicit: false });

      const get = await app.inject({ method: "GET", url: "/api/wellness/ai-consent" });
      expect(get.statusCode).toBe(200);
      expect(get.json()).toEqual({ effective: false, explicit: false });
    } finally {
      await app.close();
    }
  });

  it("consent is isolated per user — setting user A does not affect user B", async () => {
    const prefs = new PreferencesRepository();
    await dataContext.withDataContext(ctx(userId), (db) =>
      prefs.delete(db, "wellness.ai_consent_granted")
    );
    await dataContext.withDataContext(ctx(otherUserId), (db) =>
      prefs.delete(db, "wellness.ai_consent_granted")
    );

    const appA = Fastify();
    registerWellnessRoutes(appA, {
      resolveAccessContext: async () => ({ actorUserId: userId, requestId: "req:iso-a" }),
      dataContext,
      resolveActiveModules: async () => [{ id: "wellness" }]
    });
    await appA.ready();
    try {
      const put = await appA.inject({
        method: "PUT",
        url: "/api/wellness/ai-consent",
        payload: { granted: false }
      });
      expect(put.statusCode).toBe(200);
      expect(put.json()).toEqual({ effective: false, explicit: false });
    } finally {
      await appA.close();
    }

    const appB = Fastify();
    registerWellnessRoutes(appB, {
      resolveAccessContext: async () => ({ actorUserId: otherUserId, requestId: "req:iso-b" }),
      dataContext,
      resolveActiveModules: async () => [{ id: "wellness" }]
    });
    await appB.ready();
    try {
      const get = await appB.inject({ method: "GET", url: "/api/wellness/ai-consent" });
      expect(get.statusCode).toBe(200);
      expect(get.json()).toEqual({ effective: true, explicit: null });
    } finally {
      await appB.close();
    }
  });

  it("inherits false when Wellness is not active and no explicit preference exists", async () => {
    const inactiveUser = "00000000-0000-4000-8000-000000000053";
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO app.users (id, email, is_instance_admin)
         VALUES ($1, 'well-p2-inactive@example.test', false) ON CONFLICT (id) DO NOTHING`,
        [inactiveUser]
      );
    } finally {
      await client.end();
    }

    const app = Fastify();
    registerWellnessRoutes(app, {
      resolveAccessContext: async () => ({
        actorUserId: inactiveUser,
        requestId: "req:ai-consent-inactive"
      }),
      dataContext,
      resolveActiveModules: async () => []
    });
    await app.ready();
    try {
      const res = await app.inject({ method: "GET", url: "/api/wellness/ai-consent" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ effective: false, explicit: null });
    } finally {
      await app.close();
    }
  });
});
