// Run the real legacy tools against their own synthetic account. The caller
// rolls tool writes back before the compiled guest runs the same requests.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { DataContextRunner } from "@moss/db";
import { PEOPLE_TOOLS } from "../../../packages/people/src/tools.js";

export async function toolsOracle(
  bootstrap: pg.Client,
  runner: DataContextRunner,
  actor: string
): Promise<unknown> {
  const primary = randomUUID();
  const secondary = randomUUID();
  const identity = randomUUID();
  const link = randomUUID();
  const accepted = randomUUID();
  const rejected = randomUUID();
  const explicit = randomUUID();
  await bootstrap.query(
    "INSERT INTO app.users(id,email,name) VALUES($1,$2,'People tools oracle')",
    [actor, `people-tools-${actor}@example.test`]
  );
  await bootstrap.query(
    `INSERT INTO app.person_context_people(id,owner_user_id,display_name,created_at,updated_at)
     VALUES($1,$3,'Tool Alpha','2020-01-01Z','2020-01-01Z'),
           ($2,$3,'Tool Beta','2020-01-02Z','2020-01-02Z')`,
    [primary, secondary, actor]
  );
  await bootstrap.query(
    `INSERT INTO app.person_context_identities(id,owner_user_id,person_id,identity_kind,source_kind,normalized_value,display_value,first_seen_at,last_seen_at,created_at,updated_at)
     VALUES($1,$2,$3,'email_address','email','tools@example.test','Tool address','2020-01-01Z','2020-01-01Z','2020-01-01Z','2020-01-01Z')`,
    [identity, actor, secondary]
  );
  await bootstrap.query(
    `INSERT INTO app.person_context_links(id,owner_user_id,person_id,source_kind,source_ref,source_ref_hash,link_kind,summary,occurred_at,created_at,updated_at)
     VALUES($1,$2,$3,'email','tool-ref','tool-hash','sender','Tool summary','2020-01-01Z','2020-01-01Z','2020-01-01Z')`,
    [link, actor, primary]
  );
  for (const [id, kind] of [
    [accepted, "link_identity"],
    [rejected, "create_person"],
    [explicit, "merge_people"]
  ]) {
    await bootstrap.query(
      `INSERT INTO app.person_context_match_candidates(id,owner_user_id,candidate_kind,candidate_signature,primary_person_id,identity_id,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,'2020-01-01Z','2020-01-01Z')`,
      [id, actor, kind, id, primary, identity]
    );
  }
  const requests = [
    { tool: "people.resolve", parameters: { query: "  TOOLS@example.test  " } },
    { tool: "people.resolve", parameters: { query: "No match" } },
    { tool: "people.getContext", parameters: { personId: primary } },
    { tool: "people.listRecent", parameters: {} },
    { tool: "people.listRecent", parameters: { limit: 1 } },
    { tool: "people.acceptMatch", parameters: { candidateId: explicit } },
    { tool: "people.acceptMatch", parameters: { candidateId: accepted } },
    { tool: "people.rejectMatch", parameters: { candidateId: rejected } },
    {
      tool: "people.merge",
      parameters: { primaryPersonId: primary, secondaryPersonId: secondary }
    },
    {
      tool: "people.splitIdentity",
      parameters: { identityId: identity, targetPersonId: secondary }
    },
    { tool: "people.getContext", parameters: { personId: primary } }
  ];
  const cases: unknown[] = [];
  let result: unknown;
  const rollback = new Error("Roll back the legacy tool oracle");
  try {
    await runner.withDataContext({ actorUserId: actor }, async (scope) => {
      const startedAt = new Date().toISOString();
      for (const request of requests) {
        const execute = PEOPLE_TOOLS.find((tool) => tool.name === request.tool)?.execute;
        if (!execute) throw new Error(`Legacy tool missing: ${request.tool}`);
        try {
          const expected = await execute(scope, request.parameters, {
            actorUserId: actor,
            requestId: "people-tool-oracle",
            chatSessionId: "people-tool-oracle"
          });
          cases.push({ request, expected });
        } catch (error) {
          if (request.tool !== "people.acceptMatch" || request.parameters.candidateId !== explicit)
            throw error;
          cases.push({ request, error: error instanceof Error ? error.message : String(error) });
        }
      }
      result = {
        startedAt,
        actor,
        primary,
        secondary,
        identity,
        accepted,
        rejected,
        explicit,
        knownIds: [actor, primary, secondary, identity, link, accepted, rejected, explicit],
        cases
      };
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  return result;
}
