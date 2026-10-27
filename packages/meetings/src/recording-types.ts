import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type {
  RecordingType,
  RecordingTypeConfiguration,
  PutRecordingTypeConfigurationInput
} from "@moss/shared";
import { sql } from "kysely";
import { RecordingIdentityError } from "./recording-identity-error.js";
import {
  validateRecordingTypeConfiguration,
  prepareRecordingTypeConfiguration
} from "./recording-type-config.js";

export const DEFAULT_RECORDING_TYPES: readonly RecordingType[] = [
  {
    id: "work-meeting",
    name: "Work meeting",
    description: "Work discussions, decisions and action items.",
    templateId: "general",
    retired: false
  },
  {
    id: "appointment",
    name: "Appointment",
    description: "A scheduled appointment or consultation.",
    templateId: "general",
    retired: false
  },
  {
    id: "brain-dump",
    name: "Brain dump",
    description: "Thinking aloud, loose thoughts and grouped ideas.",
    templateId: "general",
    retired: false
  },
  {
    id: "conversation",
    name: "Conversation",
    description: "An informal conversation with other people.",
    templateId: "general",
    retired: false
  },
  {
    id: "idea",
    name: "Idea",
    description: "A focused idea or proposal to develop.",
    templateId: "general",
    retired: false
  },
  {
    id: "other",
    name: "Other",
    description: "A recording that does not fit another active type.",
    templateId: "general",
    retired: false
  }
];
export { RecordingIdentityError } from "./recording-identity-error.js";
export function requireRecordingType(configuration: RecordingTypeConfiguration, id: string) {
  const type = configuration.types.find((type) => type.id === id && !type.retired);
  if (!type) throw new RecordingIdentityError("recording_type_unavailable");
  return type;
}
export class RecordingTypesRepository {
  async get(db: DataContextDb): Promise<RecordingTypeConfiguration> {
    assertDataContextDb(db);
    await sql`SELECT pg_advisory_xact_lock_shared(hashtextextended('meetings:recording-types:' || app.current_actor_user_id(),0))`.execute(
      db.db
    );
    return this.read(db);
  }
  async put(
    db: DataContextDb,
    raw: PutRecordingTypeConfigurationInput
  ): Promise<RecordingTypeConfiguration> {
    assertDataContextDb(db);
    const input = validateRecordingTypeConfiguration(raw);
    // Lock before reading, including when the owner has no row yet. Never upgrade a shared lock.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended('meetings:recording-types:' || app.current_actor_user_id(),0))`.execute(
      db.db
    );
    const current = await this.read(db);
    const next = prepareRecordingTypeConfiguration(current, input);
    if (JSON.stringify(current.types) === JSON.stringify(next.types)) return current;
    await sql`INSERT INTO app.meeting_recording_types (revision,types_json)
      VALUES (${next.revision},${JSON.stringify(next.types)})
      ON CONFLICT (owner_user_id) DO UPDATE SET revision=EXCLUDED.revision,types_json=EXCLUDED.types_json`.execute(
      db.db
    );
    return next;
  }
  private async read(db: DataContextDb): Promise<RecordingTypeConfiguration> {
    const row = (
      await sql<{
        revision: number;
        types_json: string;
      }>`SELECT revision,types_json FROM app.meeting_recording_types WHERE owner_user_id=app.current_actor_user_id()`.execute(
        db.db
      )
    ).rows[0];
    return row
      ? { revision: row.revision, types: JSON.parse(row.types_json) as RecordingType[] }
      : { revision: 0, types: DEFAULT_RECORDING_TYPES };
  }
}
