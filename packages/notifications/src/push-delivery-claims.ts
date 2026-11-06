import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { assertDataContextDb, type DataContextDb } from "@moss/db";

/** Metadata-only, recipient-owned leases. A crashed attempt can be reclaimed after a minute. */
export class PushDeliveryClaimsRepository {
  async claim(db: DataContextDb, deliveryKey: string): Promise<string | undefined> {
    assertDataContextDb(db);
    const token = randomUUID();
    const result = await sql<{ token: string }>`
      INSERT INTO app.push_delivery_claims (owner_user_id, delivery_key, token, expires_at)
      VALUES (app.current_actor_user_id(), ${deliveryKey}, ${token}::uuid, clock_timestamp() + interval '1 minute')
      ON CONFLICT (owner_user_id, delivery_key) DO UPDATE
        SET token = EXCLUDED.token, expires_at = EXCLUDED.expires_at
        WHERE app.push_delivery_claims.expires_at <= clock_timestamp()
      RETURNING token
    `.execute(db.db);
    return result.rows[0]?.token;
  }

  async release(db: DataContextDb, deliveryKey: string, token: string): Promise<boolean> {
    assertDataContextDb(db);
    const result = await sql`
      DELETE FROM app.push_delivery_claims
      WHERE owner_user_id = app.current_actor_user_id()
        AND delivery_key = ${deliveryKey} AND token = ${token}::uuid
      RETURNING token
    `.execute(db.db);
    return result.rows.length === 1;
  }
}
