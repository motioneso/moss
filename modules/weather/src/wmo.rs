//! WMO weather codes as Open-Meteo reports them.

/// The words and icon name for a code. Unknown codes read as cloud.
pub fn resolve(code: i64) -> (&'static str, &'static str) {
    match code {
        0 => ("Clear sky", "sun"),
        1 => ("Mainly clear", "sun"),
        2 => ("Partly cloudy", "cloud-sun"),
        3 => ("Overcast", "cloud"),
        45 => ("Foggy", "cloud"),
        48 => ("Icy fog", "cloud"),
        51 => ("Light drizzle", "cloud-rain"),
        53 => ("Drizzle", "cloud-rain"),
        55 => ("Heavy drizzle", "cloud-rain"),
        56 => ("Freezing drizzle", "cloud-rain"),
        57 => ("Heavy freezing drizzle", "cloud-rain"),
        61 => ("Light rain", "cloud-rain"),
        63 => ("Rain", "cloud-rain"),
        65 => ("Heavy rain", "cloud-rain"),
        66 => ("Freezing rain", "cloud-rain"),
        67 => ("Heavy freezing rain", "cloud-rain"),
        71 => ("Light snow", "cloud-snow"),
        73 => ("Snow", "cloud-snow"),
        75 => ("Heavy snow", "cloud-snow"),
        77 => ("Snow grains", "cloud-snow"),
        80 => ("Light showers", "cloud-rain"),
        81 => ("Showers", "cloud-rain"),
        82 => ("Heavy showers", "cloud-rain"),
        85 => ("Snow showers", "cloud-snow"),
        86 => ("Heavy snow showers", "cloud-snow"),
        95 => ("Thunderstorm", "cloud-rain"),
        96 => ("Thunderstorm with hail", "cloud-rain"),
        99 => ("Thunderstorm with heavy hail", "cloud-rain"),
        _ => ("Unknown", "cloud"),
    }
}
