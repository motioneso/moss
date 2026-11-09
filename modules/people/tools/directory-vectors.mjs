// Capture the existing folder sort, including canonically equivalent spellings.
import { format } from "prettier";

const pairs = [
  ["é", "e\u0301"],
  ["École", "E\u0301cole"],
  ["Ångström", "A\u030angstro\u0308m"],
  ["Ångström", "Ångström"],
  ["mañana", "man\u0303ana"],
  ["ǘ", "u\u0308\u0301"],
  ["ạ́", "a\u0301\u0323"],
  ["가", "\u1100\u1161"],
  ["각", "\u1100\u1161\u11a8"],
  ["Άλφα", "Α\u0301λφα"],
  ["e\u0301", "É"],
  ["Å", "A\u030a"],
  ["e\u0301clair", "fable"],
  ["École", "e\u0301cole"],
  ["cafe\u0301", "café"],
  ["Zebra", "apple"],
  ["Άλφα", "Αλφα"],
  ["Α\u0301λφα", "Αλφα"],
  ["Ήτα", "Αλφα"],
  ["Η\u0301τα", "Αλφα"],
  ["\u1102\u1161", "가"]
];
const cases = pairs.flatMap(([a, b]) => [
  { a, b, expected: Math.sign(a.localeCompare(b)) },
  { a: b, b: a, expected: Math.sign(b.localeCompare(a)) }
]);
process.stdout.write(await format(JSON.stringify(cases), { parser: "json" }));
