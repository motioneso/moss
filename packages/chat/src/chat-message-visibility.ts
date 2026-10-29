import { sql } from "kysely";

/** Absorbed synthetic rows remain stored; only their visible replacement participates in history. */
export function visibleChatMessage(table: "app.chat_messages" | "m" = "app.chat_messages") {
  const metadata = sql.ref(`${table}.tool_metadata`);
  return sql<boolean>`NOT COALESCE(
    ${sql.ref(`${table}.body`)} = ''
    AND ${sql.ref(`${table}.role`)} = 'assistant'
    AND ${sql.ref(`${table}.status`)} = 'stored'
    AND ${metadata}->'actionOutcomeOnly' = 'true'::jsonb
    AND ${metadata}->'actionOutcomeHidden' = 'true'::jsonb,
    false
  )`;
}
