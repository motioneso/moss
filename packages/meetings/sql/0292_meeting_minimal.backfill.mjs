/** Frozen 0292 migration. Self-contained projection of retained rows; hashed with its SQL. */
export async function backfill(client) {
  const overview = (text) => [...text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (part) => part.length === 2 ? part : " ").replace(/\0/g, "").replace(/\s+/gu, " ").trim()].slice(0, 240).join("");
  try {
    // The canonical runner holds these DDL locks until its encompassing transaction commits.
    for (const table of ["meeting_output_artifacts", "meeting_capture_grants"])
      await client.query(`ALTER TABLE app.${table} DISABLE ROW LEVEL SECURITY`);
    let after = null;
    for (;;) {
      const page = await client.query("SELECT id,artifact_json FROM app.meeting_output_artifacts WHERE ($1::uuid IS NULL OR id>$1::uuid) ORDER BY id LIMIT 8", [after]);
      if (!page.rows.length) break;
      for (const row of page.rows) {
        if (Buffer.byteLength(row.artifact_json) > 1048576) throw new Error("Invalid artifact size");
        const content = JSON.parse(row.artifact_json).content;
        if (!content || typeof content.overview !== "string") throw new Error("Invalid overview");
        await client.query("UPDATE app.meeting_output_artifacts SET history_overview=$2 WHERE id=$1::uuid", [row.id, overview(content.overview)]);
      }
      after = page.rows.at(-1).id;
    }
    after = null;
    for (;;) {
      const page = await client.query("SELECT id,state_json FROM app.meeting_capture_grants WHERE ($1::uuid IS NULL OR id>$1::uuid) ORDER BY id LIMIT 8", [after]);
      if (!page.rows.length) break;
      for (const row of page.rows) {
        if (row.state_json !== null && Buffer.byteLength(row.state_json) > 524288) throw new Error("Invalid capture size");
        const duration = row.state_json === null ? null : JSON.parse(row.state_json).recordedDurationMs;
        const retained = Number.isSafeInteger(duration) && duration >= 0 && duration <= 7200000 ? duration : null;
        await client.query("UPDATE app.meeting_capture_grants SET recorded_duration_ms=$2 WHERE id=$1::uuid", [row.id, retained]);
      }
      after = page.rows.at(-1).id;
    }
    for (const table of ["meeting_output_artifacts", "meeting_capture_grants"]) {
      await client.query(`ALTER TABLE app.${table} ENABLE ROW LEVEL SECURITY`);
      await client.query(`ALTER TABLE app.${table} FORCE ROW LEVEL SECURITY`);
    }
  } catch {
    // The runner rolls back SQL and sidecar together. Do not expose row content in diagnostics.
    throw new Error("Meeting minimal projection backfill failed");
  }
}
