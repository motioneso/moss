use moss_calendar_ui::model::{self, Event};
use serde_json::{json, Value};
use std::io::{self, BufRead};
fn main() {
    for line in io::stdin().lock().lines() {
        let v: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let output = match v["operation"].as_str().unwrap() {
            "grid" => {
                use leptos::prelude::*;
                use moss_calendar_ui::views::TimeGrid;
                let events: Vec<Event> = serde_json::from_value(v["events"].clone()).unwrap();
                let date = v["cursor"].as_str().unwrap().parse().unwrap();
                let days = if v["week"] == true {
                    model::week(date, false)
                } else {
                    vec![date]
                };
                let groups =
                    model::group(&events, model::zone(v["zone"].as_str().unwrap()).unwrap());
                json!(view!{<TimeGrid days=days today=date now_min=Signal::derive(||600) events=groups twelve=v["twelve"]==true on_event=Callback::new(|_|{}) scroll_position=RwSignal::new(None)/ >}.to_html())
            }
            "month" => {
                use leptos::prelude::*;
                use moss_calendar_ui::views::Month;
                let events: Vec<Event> = serde_json::from_value(v["events"].clone()).unwrap();
                let date = v["cursor"].as_str().unwrap().parse().unwrap();
                let zone = model::zone(v["zone"].as_str().unwrap()).unwrap();
                let today = model::today(v["today"].as_str().unwrap(), zone).unwrap();
                let groups = model::group(&events, zone);
                json!(view!{<Month cursor=date today=today events=groups twelve=v["twelve"]==true on_day=Callback::new(|_|{}) on_event=Callback::new(|_|{})/>}.to_html())
            }
            "calendar" => {
                let date = v["cursor"].as_str().unwrap().parse().unwrap();
                json!({"week":model::week(date,v["work"].as_bool().unwrap_or(false)),"month":model::month(date),"next":model::navigate(date,v["view"].as_str().unwrap(),1),"previous":model::navigate(date,v["view"].as_str().unwrap(),-1)})
            }
            "time" => json!(model::time(
                v["minute"].as_u64().unwrap() as u32,
                model::twelve(v["format"].as_str())
            )),
            "duration" => json!(model::duration(v["minutes"].as_i64().unwrap())),
            "dateRange" => {
                let event: Event = serde_json::from_value(v["event"].clone()).unwrap();
                json!(model::date_range(
                    &event,
                    model::zone(v["zone"].as_str().unwrap()).unwrap()
                ))
            }
            "rangeLabel" => json!(model::range_label(
                v["cursor"].as_str().unwrap().parse().unwrap(),
                v["view"].as_str().unwrap(),
                v["work"].as_bool().unwrap_or(false),
            )),
            "events" => {
                let events: Vec<Event> = serde_json::from_value(v["events"].clone()).unwrap();
                let groups =
                    model::group(&events, model::zone(v["zone"].as_str().unwrap()).unwrap());
                let rows:Vec<Value> = groups.into_iter().map(|(day,events)| json!({"day":day,"segments":events.iter().map(|e|json!({"id":e.event.id,"startMin":e.start_min,"endMin":e.end_min,"allDay":e.event.all_day})).collect::<Vec<_>>(),"packed":model::pack(&events).iter().map(|e|json!({"id":e.event.id,"startMin":e.start_min,"endMin":e.end_min,"column":e.column,"columns":e.columns})).collect::<Vec<_>>()})).collect();
                json!(rows)
            }
            _ => panic!("unknown operation"),
        };
        println!("{output}");
    }
}
