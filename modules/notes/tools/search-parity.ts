/** Native input/projection corpus. Retrieval is explicitly a boundary stand-in. */
import { writeFileSync } from "node:fs";
import type { DataContextDb } from "@moss/db";
import { legacySearch } from "./search-legacy.js";

const parameters: Record<string, unknown>[] = [
  {},
  ...[null, false, 12, [], {}, "", "\uFEFF\t\r\n", "\u0085", " \uFEFFcafé 🌱\r\n"].map((query) => ({
    query
  }))
];
for (const limit of [
  null,
  false,
  true,
  -1,
  0,
  1.9,
  20,
  200,
  "",
  " 3.9 ",
  "NaN",
  "Infinity",
  "0x10",
  "0Xf",
  "0b11",
  "0o10",
  "+0x10",
  [],
  [4],
  [[5]],
  [null],
  [1, 2],
  {},
  "1e3",
  "1e500",
  "\uFEFF2\uFEFF"
])
  parameters.push({ query: "  Notes 🌱\r\n", limit });
const rows = [];
for (const input of parameters) {
  const calls: unknown[] = [];
  const execute = legacySearch(
    {
      retrieve: async (_db, query, limit, kind) => {
        calls.push({ query, limit, kind });
        return [
          {
            id: "hidden",
            sourcePath: "/notes/private.md",
            lineStart: 1,
            lineEnd: 2,
            text: "Private café 🌱",
            similarity: 0.9,
            updatedAt: "hidden"
          }
        ];
      }
    },
    false
  );
  const expected = await execute({} as DataContextDb, input);
  rows.push({ request: { tool: "notes.search", parameters: input }, expected, calls });
}
writeFileSync(
  new URL("../src/tests/search-vectors.jsonl", import.meta.url),
  rows.map((r) => JSON.stringify(r)).join("\n") + "\n"
);
console.log(
  `PASS ${rows.length} actual legacy Notes search input/projection vectors (retrieval stand-in)`
);
