import { describe, expect, it } from "vitest";
import { meetingRecordTarget } from "../../packages/meetings/src/chat-targets.js";
import { workshopProjectTarget } from "../../packages/workshop/src/chat-targets.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

const id = "00000000-0000-4000-8000-000000000001";
const targets = [
  { name: "meeting", target: meetingRecordTarget, param: "id", table: '"app"."meeting_records"' },
  {
    name: "project",
    target: workshopProjectTarget,
    param: "projectId",
    table: '"app"."workshop_projects"'
  }
];

describe("record deletion target labels", () => {
  it.each(targets)("reads only the actor's $name title", async ({ target, param, table }) => {
    const { scoped, queries } = makeRecordingDb({ rows: [{ title: "Exact target" }] });
    expect(await target(scoped, { [param]: id })).toBe("Exact target");
    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toContain(`select "title" from ${table}`);
    expect(queries[0]?.sql).toContain('"owner_user_id" = app.current_actor_user_id()');
    expect(queries[0]?.parameters).toEqual([id]);
    expect(queries[0]?.sql).not.toMatch(/personal_notes|initial_request|\*/);
  });
  it.each(targets)("rejects an unscoped $name handle", async ({ target, param }) => {
    const { scoped, queries } = makeRecordingDb();
    await expect(target({ db: scoped.db }, { [param]: id })).rejects.toThrow(/withDataContext/);
    expect(queries).toEqual([]);
  });
  it.each(targets)("does not query invalid $name IDs", async ({ target, param }) => {
    const { scoped, queries } = makeRecordingDb();
    expect(await target(scoped, {})).toBeNull();
    expect(await target(scoped, { [param]: "invalid" })).toBeNull();
    expect(queries).toEqual([]);
  });
  it.each(targets)("returns no label for an invisible $name", async ({ target, param }) => {
    const { scoped } = makeRecordingDb();
    expect(await target(scoped, { [param]: id })).toBeNull();
  });
});
