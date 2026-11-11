/** Runs the old recall service (real scoring code, stand-in repository and embeddings) on
 *  fixed candidate sets and either writes or checks modules/memory/tools/score-cases.json.
 *  The Rust guest replays the same cases in its own tests. No database. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dataContextBrand } from "@moss/db";
import { confidenceTier } from "../../../packages/memory/src/graph-repository-utils.js";
import { GraphMemoryRecallService } from "../../../packages/memory/src/graph-recall-service.js";

const NOW = Date.parse("2026-11-11T12:00:00.000Z");
const file = new URL("./score-cases.json", import.meta.url);

type Fact = Record<string, unknown>;
type Candidate = { fact: Fact; searchText: string | null; similarity: number };
type Case = {
  name: string;
  query: string;
  options: { limit?: number; includeInactive?: boolean; includeLowConfidence?: boolean };
  host: { nowMs: number; candidates: Candidate[]; names: Record<string, string> };
  expected?: unknown;
};

let seed = 7;
const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]!;
const day = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

function fact(index: number): Fact {
  const confidence = pick([0.3, 0.5, 0.6, 0.62, 0.8, 0.9, 0.95]);
  const provenance = pick(["volunteered", "inferred", "confirmed", "imported"]);
  const aged = NOW - Math.floor(next() * 500) * day - Math.floor(next() * day);
  const confirmed = next() < 0.3 ? iso(NOW - Math.floor(next() * 400) * day) : null;
  const objectText =
    next() < 0.85 ? pick(["dark roast coffee", "learn rust", "no meetings friday", "tea"]) : null;
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    ownerUserId: "00000000-0000-4000-8000-0000000000aa",
    subjectEntityId: pick([
      "00000000-0000-4000-8000-0000000000e1",
      "00000000-0000-4000-8000-0000000000e2"
    ]),
    predicate: pick(["prefers", "has_goal", "works_on", "decided"]),
    objectEntityId: objectText ? null : "00000000-0000-4000-8000-0000000000e3",
    objectText,
    recordKind: pick(["fact", "preference", "goal", "inference"]),
    confidence,
    provenance,
    status: pick(["active", "active", "conflicting", "stale"]),
    validFrom: null,
    validTo: next() < 0.1 ? iso(NOW + 30 * day) : null,
    staleAt: null,
    supersededByFactId: null,
    conflictGroupId: null,
    lastConfirmedAt: confirmed,
    importance: pick([0, 0.25, 0.5, 0.75, 1]),
    pinned: next() < 0.25,
    createdAt: iso(aged - 5 * day),
    updatedAt: iso(aged),
    sources: [
      {
        id: `00000000-0000-4000-8000-1${String(index).padStart(11, "0")}`,
        sourceKind: "chat",
        sourceRef: `thread-${index}`,
        sourceLabel: "",
        excerpt: "said so",
        occurredAt: iso(aged)
      }
    ]
  };
}

function build(): Case[] {
  const cases: Case[] = [];
  const queries = ["coffee", "learn rust", "no meetings", "Dark ROAST coffee please", "zzz"];
  const optionSets = [
    {},
    { limit: 3 },
    { includeInactive: true },
    { includeLowConfidence: true, limit: 50 },
    { limit: 1 }
  ];
  let index = 1;
  for (const query of queries) {
    for (const options of optionSets) {
      const candidates: Candidate[] = [];
      for (let i = 0; i < 12; i += 1) {
        const f = fact(index++);
        const text = [i % 3 === 0 ? "Sam" : null, f.predicate, f.objectText]
          .filter(Boolean)
          .join(" ");
        candidates.push({
          fact: f,
          searchText: i % 5 === 0 ? null : text,
          similarity: pick([0, 0, 0.1, 0.33, 0.5, 0.71, 0.9, 1])
        });
      }
      cases.push({
        name: `${query} ${JSON.stringify(options)}`,
        query,
        options,
        host: {
          nowMs: NOW,
          candidates,
          names: {
            "00000000-0000-4000-8000-0000000000e2": "Sam"
          }
        }
      });
    }
  }
  return cases;
}

const revive = (f: Fact): Fact => {
  const out: Fact = { ...f };
  for (const key of [
    "validFrom",
    "validTo",
    "staleAt",
    "lastConfirmedAt",
    "createdAt",
    "updatedAt"
  ]) {
    out[key] = f[key] === null ? null : new Date(f[key] as string);
  }
  out.confidenceTier = confidenceTier(
    f.confidence as number,
    f.provenance as never,
    out.lastConfirmedAt as Date | null
  );
  out.sources = (f.sources as Fact[]).map((s) => ({
    ...s,
    occurredAt: s.occurredAt === null ? null : new Date(s.occurredAt as string)
  }));
  return out;
};

async function run(test: Case) {
  const repository = {
    listFactRecallCandidates: async () =>
      test.host.candidates.map((c) => ({
        fact: revive(c.fact),
        searchText: c.searchText ?? [c.fact.predicate, c.fact.objectText].filter(Boolean).join(" "),
        vectorSimilarity: c.similarity
      })),
    getOtherSubjectNames: async () => new Map(Object.entries(test.host.names)),
    listCoreFacts: async () => test.host.candidates.map((c) => revive(c.fact))
  };
  const provider = {
    dimensions: 768,
    modelName: "stand-in",
    modelVersion: "0",
    embedDocument: async () => [],
    embedQuery: async () => []
  };
  const service = new GraphMemoryRecallService(provider, repository as never);
  const db = { [dataContextBrand]: true } as never;
  const realNow = Date.now;
  Date.now = () => NOW;
  try {
    const recalled = await service.recall(db, "owner", test.query, test.options);
    const core = await service.core(db, "owner");
    return JSON.parse(JSON.stringify({ recall: recalled, core }));
  } finally {
    Date.now = realNow;
  }
}

const write = process.argv.includes("--write");
const cases: Case[] = write ? build() : JSON.parse(readFileSync(file, "utf8"));
for (const test of cases) test.expected = await run(test);
if (write) {
  writeFileSync(file, `[\n${cases.map((c) => JSON.stringify(c)).join(",\n")}\n]\n`);
  console.log(`wrote ${cases.length} cases`);
} else {
  const stored = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(JSON.parse(JSON.stringify(cases)), stored, "score-cases.json is stale");
  console.log(`score cases match the old code: ${cases.length}`);
}
