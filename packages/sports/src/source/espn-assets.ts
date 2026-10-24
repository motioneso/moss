export const ESPN_IMAGE_HOSTS: readonly string[] = [
  "a.espncdn.com",
  "s.espncdn.com",
  "s.secure.espncdn.com",
  "espnmedia-cdn.akamaized.net"
];

/** Reuse the reviewed ESPN image origins; no credentials, fragments or arbitrary resources. */
export function resultCrest(
  value: unknown,
  imageHosts: readonly string[] = ESPN_IMAGE_HOSTS
): string | null {
  if (typeof value !== "string" || value.length > 500) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      imageHosts.includes(url.hostname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}
