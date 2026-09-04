import type { GeocodeCandidate } from "./open-meteo-geocode.js";
import { WeatherLocationSearchUnavailableError } from "./open-meteo-geocode.js";

// Open-Meteo's geocoder is search-only, so turning browser coordinates into a
// place name goes through Nominatim's reverse endpoint instead. Their usage
// policy asks for an identifying User-Agent and at most one request a second;
// this is only ever called from a user clicking "Use my location".
// https://nominatim.org/release-docs/latest/api/Reverse/

interface NominatimAddress {
  city?: string;
  town?: string;
  village?: string;
  municipality?: string;
  county?: string;
  state?: string;
  country?: string;
}

interface NominatimReverseResponse {
  address?: NominatimAddress;
  error?: string;
}

function buildLabel(address: NominatimAddress | undefined, lat: number, lon: number): string {
  const place =
    address?.city ?? address?.town ?? address?.village ?? address?.municipality ?? address?.county;
  const parts = [place, address?.state, address?.country].filter(
    (part): part is string => typeof part === "string" && part.trim().length > 0
  );
  return parts.length > 0 ? parts.join(", ") : `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
}

export async function reverseGeocodeLocation(
  lat: number,
  lon: number,
  fetchFn: typeof fetch = fetch
): Promise<GeocodeCandidate> {
  const url =
    `https://nominatim.openstreetmap.org/reverse` +
    `?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}` +
    `&zoom=10&accept-language=en`;

  const response = await fetchFn(url, {
    headers: { "user-agent": "Moss self-hosted assistant (weather location lookup)" }
  });
  if (!response.ok) {
    throw new WeatherLocationSearchUnavailableError(
      `Nominatim reverse geocoding returned ${response.status}`
    );
  }

  let data: NominatimReverseResponse | null;
  try {
    data = (await response.json()) as NominatimReverseResponse;
  } catch {
    throw new WeatherLocationSearchUnavailableError(
      "Nominatim reverse geocoding returned a non-JSON body"
    );
  }

  // Keep the browser's own coordinates: the forecast is for where the user is,
  // not for the centre of the town the label names.
  return { lat, lon, label: buildLabel(data?.address, lat, lon) };
}
