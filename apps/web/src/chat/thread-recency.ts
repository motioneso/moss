export function sortThreadsByRecency<T extends { readonly updatedAt: string }>(
  threads: readonly T[]
): readonly T[] {
  return [...threads].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}
