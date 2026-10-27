import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  managedNoteSnapshotKey,
  type ManagedNoteSnapshotIdentity
} from "../../packages/notes/src/managed-note-snapshot-key.js";

import { it } from "vitest";

it("invalidates snapshots for content, binding, side and represented source changes", () => {
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  const owner = randomUUID();
  const input: ManagedNoteSnapshotIdentity = {
    destinationId: digest("canonical topic"),
    contentHash: digest("Unchanged body"),
    bindingRevision: 3,
    side: "personal",
    lifecycle: {
      ownerUserId: owner,
      actorGeneration: 1,
      sources: [
        {
          source: { ownerUserId: owner, sourceModuleId: "meetings", sourceId: randomUUID() },
          generation: 4
        },
        {
          source: { ownerUserId: owner, sourceModuleId: "meetings", sourceId: randomUUID() },
          generation: 2
        }
      ]
    }
  };
  const key = managedNoteSnapshotKey(input);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(
    managedNoteSnapshotKey({
      ...input,
      lifecycle: { ...input.lifecycle, sources: [...input.lifecycle.sources].reverse() }
    }),
    key
  );
  assert.equal(
    managedNoteSnapshotKey({
      ...input,
      lifecycle: {
        ...input.lifecycle,
        sources: [...input.lifecycle.sources, input.lifecycle.sources[0]!]
      }
    }),
    key
  );
  assert.equal(
    managedNoteSnapshotKey({
      ...input,
      lifecycle: {
        ...input.lifecycle,
        ownerUserId: owner.toUpperCase(),
        sources: input.lifecycle.sources.map((entry) => ({
          ...entry,
          source: {
            ...entry.source,
            ownerUserId: owner.toUpperCase(),
            sourceId: entry.source.sourceId.toUpperCase()
          }
        }))
      }
    }),
    key
  );
  for (const variant of [
    { ...input, side: "work" as const },
    { ...input, bindingRevision: 4 },
    { ...input, contentHash: digest("New body") },
    { ...input, destinationId: digest("Other topic") },
    { ...input, lifecycle: { ...input.lifecycle, actorGeneration: 2 } },
    { ...input, lifecycle: { ...input.lifecycle, sources: input.lifecycle.sources.slice(1) } },
    {
      ...input,
      lifecycle: {
        ...input.lifecycle,
        sources: input.lifecycle.sources.map((entry) => ({
          ...entry,
          generation: entry.generation + 1
        }))
      }
    }
  ])
    assert.notEqual(managedNoteSnapshotKey(variant), key);
  for (const bindingRevision of [-1, 0.5, NaN, Infinity, 2147483648])
    assert.throws(() => managedNoteSnapshotKey({ ...input, bindingRevision }));
  assert.notEqual(
    managedNoteSnapshotKey({ ...input, lifecycle: { ...input.lifecycle, sources: [] } }),
    key
  );
  assert.throws(() =>
    managedNoteSnapshotKey({
      ...input,
      lifecycle: {
        ...input.lifecycle,
        sources: [...input.lifecycle.sources, { ...input.lifecycle.sources[0]!, generation: 99 }]
      }
    })
  );
  assert.throws(() =>
    managedNoteSnapshotKey({
      ...input,
      lifecycle: {
        ...input.lifecycle,
        sources: input.lifecycle.sources.map((entry) => ({
          ...entry,
          source: { ...entry.source, ownerUserId: randomUUID() }
        }))
      }
    })
  );
  assert.throws(() =>
    managedNoteSnapshotKey({
      ...input,
      lifecycle: {
        ...input.lifecycle,
        sources: Array.from({ length: 2049 }, () => input.lifecycle.sources[0]!)
      }
    })
  );
});
