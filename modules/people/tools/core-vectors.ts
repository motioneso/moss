// Record outputs from the current implementation, without database or filesystem mutations.
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import {
  candidateSignature,
  matchResult,
  normalizeIdentity
} from "../../../packages/people/src/matching.js";
import {
  formatPeopleNote,
  parsePeopleNote,
  replaceMossManagedSection
} from "../../../packages/people/src/notes-format.js";

const cases: Record<string, unknown>[] = [];
const inputs = [
  " Alice ",
  "\ufeffAlice\ufeff",
  "\u0085Alice\u0085",
  " ÄLICE@EXAMPLE.TEST ",
  "ΟΣ",
  "İ",
  "",
  "\n",
  "A\u200bB",
  "\u00a0名字\u3000"
];
for (const kind of ["email_address", "source_identity", "alias", "display_name"] as const) {
  for (const raw of inputs)
    cases.push({ op: "normalize", kind, raw, expected: normalizeIdentity(kind, raw) });
}
for (const kind of ["create_person", "link_identity", "merge_people", "split_identity"] as const) {
  for (const ids of [
    [],
    ["b", "a"],
    ["a|b", "c"],
    ["😀", "\ue000"],
    ["same", "same"],
    ["résumé.md", "名字.md"]
  ]) {
    cases.push({ op: "signature", kind, ids, expected: candidateSignature(kind, ids) });
  }
}
const frontmatter = {
  jarvisPersonId: "00000000-0000-4000-8000-000000000123",
  displayName: "Alice Example",
  aliases: ["Al", "A Example"],
  emails: ["Alice@example.test"],
  phones: ["+1 555 0100"],
  status: "active" as const
};
const notes = [
  "",
  "# Alice",
  "---\r\ndisplayName: Alice\r\nstatus: active\r\n---\r\n",
  "---\ndisplayName: Alice\nstatus: active\n---\nHello\n",
  "---\ndisplayName: Alice\nstatus: merged\n---\nHello",
  "---\ndisplayName: Alice\nstatus: archived\n---suffix",
  "---\ndisplayName: Alice\nstatus: active\naliases: [ignored]\n  - Al\n---\n",
  "---\ndisplayName: Alice\nstatus: active\naliases: []\n  - Al\n---\n",
  "---\ndisplayName: Alice\nstatus: active\naliases:\n -Al\n\n  - Another\n---\n",
  "---\ndisplayName: First\ndisplayName: Last\nstatus: active\nextra: ignored\n---\n",
  "---\ndisplayName: Alice\nstatus: active\naliases:\n  - \n---\n"
];
// JavaScript's dot excludes all four line terminators, while its leading \s accepts
// them. Cover embedded values separately from leading/trailing whitespace and CRLF.
const edgeNotes: string[] = [];
for (const separator of ["\r", "\u2028", "\u2029"]) {
  for (const value of [`Al${separator}ice`, `${separator}Alice`, `Alice${separator}`]) {
    edgeNotes.push(`---\ndisplayName: ${value}\nstatus: active\n---\n`);
    edgeNotes.push(`---\ndisplayName: Alice\nstatus: active\naliases:\n  - ${value}\n---\n`);
  }
}
for (const body of ["# Alice\n\nHuman notes\n", "", "Body\ufeff", "Body\u0085"]) {
  const note = { frontmatter, body };
  const content = formatPeopleNote(note);
  cases.push({ op: "format", note, expected: content });
  notes.push(content);
}
for (const content of notes)
  cases.push({ op: "parse", content, expected: parsePeopleNote(content) });
for (const body of [
  "",
  "Human\n\n",
  "Prefix\n<!-- jarvis:people:start -->\nold\n<!-- jarvis:people:end -->\nSuffix",
  "<!-- jarvis:people:start -->unterminated",
  "<!-- jarvis:people:start -->x<!-- jarvis:people:end --> and <!-- jarvis:people:start -->y<!-- jarvis:people:end -->"
]) {
  const managed = "  Updated\n\ufeff";
  cases.push({ op: "replace", body, managed, expected: replaceMossManagedSection(body, managed) });
}
for (const signals of [[], [0.4], [0.4, 0.8, 0.2], [0.99, 0.8]].map((confidences) =>
  confidences.map((confidence, i) => ({
    identityKind: "email_address" as const,
    normalizedValue: "alice@example.test",
    displayValue: i === 0 ? "Alice" : "Other spelling",
    confidence,
    sourceRef: "source",
    sourceRefHash: "hash",
    sourceKind: "email" as const,
    linkKind: "sender" as const,
    provenance: "source" as const
  }))
)) {
  cases.push({ op: "match", signals, expected: [...matchResult(signals)] });
}
process.stdout.write(
  await format(
    JSON.stringify(
      process.argv.includes("--note-lines")
        ? edgeNotes.map((content) => ({ op: "parse", content, expected: parsePeopleNote(content) }))
        : cases,
      null,
      2
    ),
    {
      ...(await resolveConfig(fileURLToPath(import.meta.url))),
      parser: "json"
    }
  )
);
