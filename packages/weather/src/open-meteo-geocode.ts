export class WeatherLocationSearchUnavailableError extends Error {}

export interface GeocodeCandidate {
  readonly lat: number;
  readonly lon: number;
  readonly label: string;
}

interface OpenMeteoGeocodeResult {
  latitude: number;
  longitude: number;
  name: string;
  admin1?: string;
  country: string;
}

interface OpenMeteoGeocodeResponse {
  results?: OpenMeteoGeocodeResult[];
}

function buildLabel(result: OpenMeteoGeocodeResult): string {
  const admin = result.admin1 ? `, ${result.admin1}` : "";
  return `${result.name}${admin}, ${result.country}`;
}

export async function searchOpenMeteoLocations(
  query: string,
  fetchFn: typeof fetch = fetch,
  limit = 5
): Promise<GeocodeCandidate[]> {
  const url =
    `https://geocoding-api.open-meteo.com/v1/search` +
    `?name=${encodeURIComponent(query)}&count=10&language=en&format=json`;

  const response = await fetchFn(url);
  if (!response.ok) {
    throw new WeatherLocationSearchUnavailableError(
      `Open-Meteo geocoding returned ${response.status}`
    );
  }

  let data: OpenMeteoGeocodeResponse | null;
  try {
    data = (await response.json()) as OpenMeteoGeocodeResponse;
  } catch {
    throw new WeatherLocationSearchUnavailableError(
      "Open-Meteo geocoding returned a non-JSON body"
    );
  }

  const results = Array.isArray(data?.results) ? data.results : [];
  return results.slice(0, limit).map((result) => ({
    lat: result.latitude,
    lon: result.longitude,
    label: buildLabel(result)
  }));
}
