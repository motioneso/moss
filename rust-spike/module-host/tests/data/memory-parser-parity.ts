/** Runs the actual legacy parseDocument over fixed and seeded inputs and writes the vectors. */
import { writeFileSync } from "node:fs";
import { parseDocument } from "../../../../packages/memory/src/parser.ts";

const long = (n: number, ch = "word ") => ch.repeat(n);
const fixed: string[] = [
  "",
  "   \n\n  ",
  "plain text",
  "---\ntitle: x\n---\nbody [[Link]] and [[Other|alias]]",
  "---\r\ntitle: x\r\n---\r\n# Head\r\ntext\r\n## Two\r\nmore",
  "---\n---\nempty frontmatter is not frontmatter",
  "---\ntitle: never closed\nbody",
  "---\nkey: v\n---",
  "---\nkey: v\n---\n\n\n  leading blanks\n## H\nx",
  "[[ ]] [[a]] [[a|]] [[|b]] [[[nest]]] [[x|y|z]] [[multi\nline]]",
  "intro\n## A\none\n## B\ntwo\r## C\nthree ## D\nfour ## E\nfive",
  "## Starts here\nx\n\n\n\n## Next\n",
  "para one\n\npara two\n \t \npara three\n\n\n\nfour",
  `## Long\n${long(900)}`,
  `## Many paragraphs\n${Array.from({ length: 60 }, (_, i) => `paragraph ${i} ${long(12)}`).join("\n\n")}`,
  `## Lines\n${Array.from({ length: 300 }, (_, i) => `line ${i} ${long(3)}`).join("\n")}`,
  `${"x".repeat(5000)}`,
  `a\n${"y".repeat(4100)}\nb`,
  `${"\u{1F600}".repeat(1500)}`,
  `${"é".repeat(2100)}\n\n${"\u{1F600}".repeat(3)}`,
  "﻿  padded 　\n## h \n",
  "\n\n\n## after blanks\nbody",
  `## ${"w ".repeat(1500)}\n\n\n\n\n${"z".repeat(30)}`
];
let seed = 0x9e3779b9;
const rand = () => {
  seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x297a2d39) >>> 0;
  return seed / 0x100000000;
};
const tokens = [
  "a",
  "word ",
  "\n",
  "\n\n",
  "\r\n",
  " ",
  "\t",
  "## ",
  "# ",
  "---\n",
  "\n---\n",
  "[[",
  "]]",
  "|",
  "[[Link]]",
  "[[A|B]]",
  "\u{1F600}",
  "é",
  " ",
  " ",
  "x".repeat(700),
  "long ".repeat(250),
  " \n \n"
];
const cases = [...fixed];
for (let i = 0; i < 400; i++) {
  const n = 1 + Math.floor(rand() * 40);
  let s = rand() < 0.25 ? "---\ntitle: t\n---\n" : "";
  for (let k = 0; k < n; k++) s += tokens[Math.floor(rand() * tokens.length)];
  cases.push(s);
}
const rows = cases.map((input) => ({ input, expected: parseDocument(input) }));
writeFileSync(
  new URL("./memory-parser-vectors.jsonl", import.meta.url),
  rows.map((r) => JSON.stringify(r)).join("\n") + "\n"
);
console.log(`PASS ${rows.length} actual legacy parseDocument vectors`);
