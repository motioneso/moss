interface IpWhoIsResponse {
  success: boolean;
  latitude: number;
  longitude: number;
  city: string;
  country: string;
}

interface GeoLocation {
  lat: number;
  lon: number;
  label: string;
}

function isPrivateOrNonRoutable(cleaned: string): boolean {
  if (cleaned === "::1" || cleaned === "127.0.0.1") return true;
  if (cleaned.startsWith("10.")) return true;
  if (cleaned.startsWith("192.168.")) return true;
  if (cleaned.startsWith("169.254.")) return true; // link-local

  const octets = cleaned.split(".");
  if (octets.length === 4) {
    const octet1 = Number(octets[0]);
    const octet2 = Number(octets[1]);
    if (Number.isInteger(octet1) && Number.isInteger(octet2)) {
      if (octet1 === 172 && octet2 >= 16 && octet2 <= 31) return true; // RFC 1918
      if (octet1 === 100 && octet2 >= 64 && octet2 <= 127) return true; // CGNAT 100.64.0.0/10
    }
  }

  return false;
}

export async function geocodeIp(
  ip: string,
  fetchFn: typeof fetch = fetch
): Promise<GeoLocation | null> {
  // Strip IPv6 brackets and skip loopback/private/non-routable addresses
  const cleaned = ip.replace(/^\[/, "").replace(/\]$/, "");
  if (isPrivateOrNonRoutable(cleaned)) {
    return null;
  }

  try {
    const response = await fetchFn(`https://ipwho.is/${encodeURIComponent(cleaned)}`);
    if (!response.ok) return null;
    const data = (await response.json()) as IpWhoIsResponse;
    if (!data.success) return null;
    const label = [data.city, data.country].filter(Boolean).join(", ") || "Unknown";
    return { lat: data.latitude, lon: data.longitude, label };
  } catch {
    return null;
  }
}
