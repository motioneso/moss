import { createHash } from "node:crypto";
import { VaultContextRunner, getVaultBaseDir, listVaultFiles, readVaultFile } from "@moss/vault";
import {
  OUTPUT_FIXTURE_MANUAL,
  OUTPUT_FIXTURE_OVERVIEW
} from "./meeting-outputs-fixture-server.js";

// Only isolated seeded-owner copies. Public VaultContext APIs; no raw filesystem access.
const [actorUserId, meetingId] = process.argv.slice(2);
if (
  actorUserId !== "00000000-0000-4000-8000-000000000001" ||
  !meetingId ||
  !/^[0-9a-f-]{36}$/.test(meetingId)
)
  throw new Error("Invalid fixture identity");
const runner = new VaultContextRunner(getVaultBaseDir());
const result = await runner.withVaultContext(
  { actorUserId, requestId: "meeting-output-uat" },
  async (ctx) => {
    const root = `notes/generated/${meetingId}`;
    const files = (await listVaultFiles(ctx, root)).sort();
    return Promise.all(
      files.map(async (file) => {
        const content = await readVaultFile(ctx, `${root}/${file}`);
        return {
          file,
          hash: createHash("sha256").update(content, "utf8").digest("hex"),
          generatedOverview: content.includes(OUTPUT_FIXTURE_OVERVIEW),
          manualOverview: content.includes(OUTPUT_FIXTURE_MANUAL)
        };
      })
    );
  }
);
console.log(JSON.stringify(result));
