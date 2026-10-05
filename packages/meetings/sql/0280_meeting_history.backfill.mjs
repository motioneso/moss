/** Frozen 0280 migration. Keep self-contained: these exact bytes are hash-checked with SQL. */
export async function backfill(client) {
  const searchText = (value) =>
    value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (part) =>
      part.length === 2 ? part : " "
    );
  const sourceMetadata = (sources) => {
    const pairs = new Map();
    for (const { kind, label } of sources)
      pairs.set(JSON.stringify([kind, label]), { kind, label });
    return [JSON.stringify([...pairs.values()].slice(0, 4)), Math.max(0, pairs.size - 4)];
  };
  try {
    let before = null;
    for (;;) {
      const records = await client.query(
        "SELECT id, owner_user_id FROM app.meeting_records WHERE ($1::uuid IS NULL OR id < $1::uuid) ORDER BY id DESC LIMIT 30",
        [before]
      );
      if (!records.rows.length) break;
      for (const meeting of records.rows) {
        const segments = new Map();
        let version = 0;
        let transcriptBytes = 0;
        for (;;) {
          const batches = await client.query(
            "SELECT version, input_json FROM app.meeting_transcript_batches WHERE meeting_id = $1 AND version > $2 ORDER BY version LIMIT 8",
            [meeting.id, version]
          );
          if (!batches.rows.length) break;
          for (const row of batches.rows) {
            transcriptBytes += Buffer.byteLength(row.input_json);
            if (transcriptBytes > 32 * 1024 * 1024) throw new Error("limit");
            const input = JSON.parse(row.input_json);
            for (const { segment } of input.events) {
              const previous = segments.get(segment.segmentId);
              if (!previous || previous.revision < segment.revision)
                segments.set(segment.segmentId, segment);
            }
            if (segments.size > 20000) throw new Error("limit");
            const [sources, omitted] = sourceMetadata(input.sources);
            await client.query(
              "UPDATE app.meeting_transcript_batches SET history_sources_json=$3, history_omitted_sources=$4 WHERE meeting_id=$1 AND version=$2",
              [meeting.id, row.version, sources, omitted]
            );
            version = row.version;
          }
        }
        // Bound both parameter count and text bytes independently of a meeting's history size.
        for (const segment of segments.values()) {
          await client.query(
            "INSERT INTO app.meeting_history_segments (meeting_id,owner_user_id,segment_key,revision,start_ms,end_ms,finality,search_terms) VALUES ($1,$2,$3,$4,$5,$6,$7,tsvector_to_array(to_tsvector('simple'::regconfig,$8)))",
            [
              meeting.id,
              meeting.owner_user_id,
              JSON.stringify(segment.segmentId),
              segment.revision,
              segment.startMs,
              segment.endMs,
              segment.finality,
              searchText(segment.text)
            ]
          );
        }
        let requestKey = null;
        for (;;) {
          const requests = await client.query(
            "SELECT request_key,input_json,result_json FROM app.meeting_output_requests WHERE meeting_id=$1 AND ($2::uuid IS NULL OR request_key > $2::uuid) ORDER BY request_key LIMIT 8",
            [meeting.id, requestKey]
          );
          if (!requests.rows.length) break;
          for (const row of requests.rows) {
            const input = JSON.parse(row.input_json);
            const result = row.result_json === null ? null : JSON.parse(row.result_json);
            await client.query(
              "UPDATE app.meeting_output_requests SET history_kind=$3, history_result_status=$4, history_result_code=$5 WHERE meeting_id=$1 AND request_key=$2",
              [
                meeting.id,
                row.request_key,
                typeof input.kind === "string" ? input.kind : null,
                typeof result?.status === "string" ? result.status : null,
                typeof result?.code === "string" ? result.code : null
              ]
            );
            requestKey = row.request_key;
          }
        }
        let artifactVersion = 0;
        for (;;) {
          const artifacts = await client.query(
            "SELECT version,artifact_json FROM app.meeting_output_artifacts WHERE meeting_id=$1 AND version > $2 ORDER BY version LIMIT 8",
            [meeting.id, artifactVersion]
          );
          if (!artifacts.rows.length) break;
          for (const row of artifacts.rows) {
            const artifact = JSON.parse(row.artifact_json);
            await client.query(
              "UPDATE app.meeting_output_artifacts SET history_origin=$3, history_notes_revision=$4, history_transcript_revision=$5, history_stale=$6 WHERE meeting_id=$1 AND version=$2",
              [
                meeting.id,
                row.version,
                artifact.origin,
                artifact.inputs.notesRevision,
                artifact.inputs.transcript?.transcriptRevision ?? 0,
                artifact.stale
              ]
            );
            artifactVersion = row.version;
          }
        }
        let exportVersion = 0;
        for (;;) {
          const receipts = await client.query(
            "SELECT artifact_version,receipt_json FROM app.meeting_export_receipts WHERE meeting_id=$1 AND artifact_version > $2 ORDER BY artifact_version LIMIT 8",
            [meeting.id, exportVersion]
          );
          if (!receipts.rows.length) break;
          for (const row of receipts.rows) {
            const receipt = JSON.parse(row.receipt_json);
            await client.query(
              "UPDATE app.meeting_export_receipts SET history_write_status=$3, history_index_status=$4, history_updated_at=$5 WHERE meeting_id=$1 AND artifact_version=$2",
              [
                meeting.id,
                row.artifact_version,
                receipt.writeStatus,
                receipt.indexStatus,
                receipt.updatedAt
              ]
            );
            exportVersion = row.artifact_version;
          }
        }
      }
      before = records.rows.at(-1).id;
    }
    for (const table of [
      "meeting_records",
      "meeting_transcript_batches",
      "meeting_history_segments",
      "meeting_output_requests",
      "meeting_output_artifacts",
      "meeting_export_receipts"
    ]) {
      await client.query(`ALTER TABLE app.${table} FORCE ROW LEVEL SECURITY`);
    }
  } catch {
    // Do not forward driver errors containing parameters, JSON content, or connection details.
    throw new Error("Meeting history migration backfill failed");
  }
}
