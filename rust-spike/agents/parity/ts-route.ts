// Runs the TypeScript approval policy over the shared cases. Usage: tsx ts-route.ts cases.json
import { readFileSync } from "node:fs";
import { familyAllowsAutoRun, resolvePolicy } from "../../../packages/ai/src/gateway/policy.ts";

const cases = JSON.parse(readFileSync(process.argv[2], "utf8"));
const out = [];
for (const c of cases) {
  const f = c.tool.family;
  const tool: any = {
    risk: c.tool.risk,
    isExternal: c.tool.is_external,
    executionPolicy: c.tool.execution_auto ? "auto" : "confirm",
    confirmUnderYolo: c.tool.confirm_under_yolo,
    actionFamilyId: f === null ? undefined : "fam",
  };
  const lookup = {
    getFamilyTier: async () => (f && f !== "unreadable" ? f.stored_tier : null),
    getFamilyManifest: async () =>
      f && f !== "unreadable" ? { defaultTier: f.default_tier, allowedTiers: f.allowed_tiers } : null,
  } as any;
  const k = c.call;
  const policy = await resolvePolicy(tool, "mod", k.confirm_override, lookup, k.sorted_safe,
    k.per_call_resolved, k.tainted, k.confirm_when_tainted);
  const auto = await familyAllowsAutoRun(tool, "mod", lookup, k.per_call_resolved);
  out.push([policy, auto]);
}
console.log(JSON.stringify(out));
