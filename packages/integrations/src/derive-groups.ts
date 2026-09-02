const MAX_GROUP_SIZE = 12;
const MIN_GROUP_SIZE = 3;
export const OTHER_GROUP = "Other";
const OTHER = OTHER_GROUP;

function splitSegments(name: string): string[] {
  const withBoundaries = name.replace(/[_\-.]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return withBoundaries.split(" ").filter((s) => s.length > 0);
}

function dropSharedLeadingSegments(segmented: string[][]): string[][] {
  let result = segmented;
  while (true) {
    const nonEmpty = result.filter((s) => s.length > 0);
    if (nonEmpty.length === 0) break;
    const counts = new Map<string, number>();
    for (const segs of nonEmpty) {
      const lead = segs[0]!;
      counts.set(lead, (counts.get(lead) ?? 0) + 1);
    }
    let sharedLead: string | undefined;
    for (const [lead, count] of counts) {
      if (count > nonEmpty.length / 2) {
        sharedLead = lead;
        break;
      }
    }
    if (sharedLead === undefined) break;
    const lead = sharedLead;
    result = result.map((segs) => (segs.length > 0 && segs[0] === lead ? segs.slice(1) : segs));
  }
  return result;
}

function groupBySegment(segmented: string[][]): string[] {
  const reduced = dropSharedLeadingSegments(segmented);
  return reduced.map((segs) => (segs.length > 0 ? segs[0]! : OTHER));
}

function splitOversizedGroup(
  indices: number[],
  segmented: string[][],
  depth: number
): Map<number, string> {
  const sub = indices.map((i) => segmented[i]!.slice(depth));
  const subGroups = groupBySegment(sub);
  const result = new Map<number, string>();
  const counts = new Map<string, number>();
  for (const g of subGroups) counts.set(g, (counts.get(g) ?? 0) + 1);

  const groupToIndices = new Map<string, number[]>();
  subGroups.forEach((g, j) => {
    const idx = indices[j]!;
    if (!groupToIndices.has(g)) groupToIndices.set(g, []);
    groupToIndices.get(g)!.push(idx);
  });

  for (const [g, idxs] of groupToIndices) {
    if (idxs.length > MAX_GROUP_SIZE) {
      const deeper = splitOversizedGroup(idxs, segmented, depth + 1);
      for (const [i, name] of deeper) result.set(i, name);
    } else {
      for (const i of idxs) result.set(i, g);
    }
  }
  return result;
}

export function deriveGroups(names: readonly string[]): string[] {
  const segmented = names.map(splitSegments);
  let groups = groupBySegment(segmented);

  const groupToIndices = new Map<string, number[]>();
  groups.forEach((g, i) => {
    if (!groupToIndices.has(g)) groupToIndices.set(g, []);
    groupToIndices.get(g)!.push(i);
  });

  for (const [g, idxs] of groupToIndices) {
    if (g === OTHER) continue;
    if (idxs.length > MAX_GROUP_SIZE) {
      const deeper = splitOversizedGroup(idxs, segmented, 1);
      for (const [i, name] of deeper) groups[i] = name;
    }
  }

  const finalCounts = new Map<string, number>();
  for (const g of groups) finalCounts.set(g, (finalCounts.get(g) ?? 0) + 1);
  groups = groups.map((g) =>
    g !== OTHER && (finalCounts.get(g) ?? 0) < MIN_GROUP_SIZE ? OTHER : g
  );

  return groups;
}
