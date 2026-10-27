import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type { RecordingType, RecordingTypeConfiguration } from "@moss/shared";
import { sql } from "kysely";

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
export class RecordingIdentityError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode = 400
  ) {
    super(code);
  }
}
export function requireRecordingType(configuration: RecordingTypeConfiguration, id: string) {
  const type = configuration.types.find((type) => type.id === id && !type.retired);
  if (!type) throw new RecordingIdentityError("recording_type_unavailable");
  return type;
}
export class RecordingTypesRepository {
  async get(db: DataContextDb): Promise<RecordingTypeConfiguration> {
    assertDataContextDb(db);
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
