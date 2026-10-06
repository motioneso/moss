/** Canonical metadata only: harmless JSON key ordering must not change readiness or retry identity. */
export function captureMetadataJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(
      Object.entries(item).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    );
  });
}
