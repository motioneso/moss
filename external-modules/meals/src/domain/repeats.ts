// external-modules/meals/src/domain/repeats.ts
//
// The no-repeat rule. A title key is the comparable form of a recipe title.

const MAX_KEY_LENGTH = 120;

export function titleKey(title: string): string {
  const key = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .slice(0, MAX_KEY_LENGTH)
    .trim();
  return key.length > 0 ? key : title.trim().toLowerCase().slice(0, MAX_KEY_LENGTH) || "untitled";
}

export function isRepeat(key: string, recent: ReadonlySet<string>): boolean {
  return recent.has(key);
}
