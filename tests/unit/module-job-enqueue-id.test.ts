import { describe, expect, it } from "vitest";

import { deriveModuleJobId, MODULE_JOB_ID_NAMESPACE } from "@moss/jobs";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

// Expected values come from Python's uuid.uuid5, an independent implementation.
describe("module job id (UUID v5)", () => {
  it("pins the platform namespace", () => {
    expect(MODULE_JOB_ID_NAMESPACE).toBe("71dd6e02-9cde-4943-ac23-3a72e0464852");
  });

  it.each([
    ["meals", "meals.generate", A, "plan:abc:day:3", "2d3f5177-4002-53fa-b4db-e68e57a28365"],
    ["meals", "meals.generate", B, "plan:abc:day:3", "0e5c2310-a156-5828-95b7-0e9580807f0a"],
    ["meals", "meals.generate", A, "plan:abc:day:4", "7a90c0ac-c0ee-547a-91e7-a7b0985ef25a"],
    ["acme", "acme.main", A, "k1", "3d42456f-cf42-540f-adbe-b7c034a72b48"],
    ["meals", "meals.other", A, "plan:abc:day:3", "19ed78a7-76d5-52d1-b397-5d7ab247e2d2"]
  ])("derives fixed vector %s %s %s %s", (moduleId, queue, actor, key, expected) => {
    expect(deriveModuleJobId(moduleId, queue, actor, key)).toBe(expected);
  });
});
