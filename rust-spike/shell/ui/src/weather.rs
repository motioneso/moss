//! Today's header weather: the current reading and today's range for the saved place.
//! It reads the Weather package and shows a short notice with a settings link when it cannot.

use leptos::prelude::*;
use leptos::task::spawn_local;

use crate::api::{self, WeatherToday};
use crate::frame::Icon;
use crate::icons;

/// Weather settings are a package screen opened in the module frame.
pub const WEATHER_SETTINGS: &str = "/module-frame?module=weather&path=%2Fsettings%2Fweather";

/// Icon path data and the lucide class name for a weather icon word.
pub fn icon_for(name: &str) -> (&'static str, &'static str) {
    match name {
        "sun" => (icons::SUN, "sun"),
        "cloud-sun" => (icons::CLOUD_SUN, "cloud-sun"),
        "cloud-rain" => (icons::CLOUD_RAIN, "cloud-rain"),
        "cloud-snow" => (icons::CLOUD_SNOW, "cloud-snow"),
        "wind" => (icons::WIND, "wind"),
        _ => (icons::CLOUD, "cloud"),
    }
}

pub fn unit_symbol(unit: &str) -> &'static str {
    if unit == "metric" {
        "C"
    } else {
        "F"
    }
}

/// The range line under the condition, or nothing when no forecast day came back.
pub fn outlook_line(wx: &WeatherToday) -> Option<String> {
    wx.forecast
        .first()
        .map(|day| format!("High {}° · Low {}°", day.high, day.low))
}

#[derive(Clone)]
enum Phase {
    Loading,
    Ready(WeatherToday),
    Unavailable,
}

#[component]
pub fn HeroWeather() -> impl IntoView {
    let phase = RwSignal::new(Phase::Loading);
    spawn_local(async move {
        phase.set(match api::weather_today().await {
            Ok(Some(wx)) => Phase::Ready(wx),
            _ => Phase::Unavailable,
        });
    });
    move || match phase.get() {
        Phase::Loading => ().into_any(),
        Phase::Unavailable => view! {
            <div class="today-hero__weather" id="weather">
                <p class="cmd-empty" role="status">
                    "Weather isn't available right now. "
                    <a href=WEATHER_SETTINGS>"Weather settings"</a>
                </p>
            </div>
        }
        .into_any(),
        Phase::Ready(wx) => {
            let (svg, name) = icon_for(&wx.icon);
            let outlook = outlook_line(&wx);
            view! {
                <div class="today-hero__weather" id="weather">
                    <div class="wx-now">
                        <Icon svg=svg name=name size=24 />
                        <strong>{format!("{}°", wx.temp)}<small>{unit_symbol(&wx.unit)}</small></strong>
                    </div>
                    <div class="wx-outlook">
                        <strong>{wx.condition.clone()}</strong>
                        {outlook.map(|line| view! { <span>{line}</span> })}
                    </div>
                </div>
            }.into_any()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::WeatherDay;

    fn reading(forecast: Vec<WeatherDay>) -> WeatherToday {
        WeatherToday {
            temp: 68,
            condition: "Clear".into(),
            icon: "sun".into(),
            unit: "imperial".into(),
            forecast,
        }
    }

    #[test]
    fn the_range_line_uses_the_first_day() {
        let wx = reading(vec![WeatherDay { high: 72, low: 58 }]);
        assert_eq!(outlook_line(&wx).as_deref(), Some("High 72° · Low 58°"));
        assert_eq!(outlook_line(&reading(vec![])), None);
    }

    #[test]
    fn the_unit_symbol_follows_the_unit() {
        assert_eq!(unit_symbol("metric"), "C");
        assert_eq!(unit_symbol("imperial"), "F");
    }

    #[test]
    fn unknown_icons_fall_back_to_a_cloud() {
        assert_eq!(icon_for("sun").1, "sun");
        assert_eq!(icon_for("tornado").1, "cloud");
    }
}
