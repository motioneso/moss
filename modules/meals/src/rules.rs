//! Pure planning rules: dates, the plan skeleton, calorie portions and the no-repeat key.
//! The model never decides any of this.

pub const MAX_PLAN_DAYS: i64 = 28;

/// One member as the skeleton and targets need them.
#[derive(Clone, Debug)]
pub struct Member {
    pub id: String,
    pub meal_pattern: Vec<String>,
    pub calorie_target: Option<i64>,
}

/// A slot rule: the weekdays (1 = Monday to 7 = Sunday) on which each eater has their own meal.
#[derive(Clone, Debug)]
pub struct SlotRule {
    pub slot_name: String,
    pub solo_weekdays: Vec<i64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SkeletonMeal {
    pub slot_name: String,
    pub slot_position: usize,
    pub shared: bool,
    pub eater_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SkeletonDay {
    pub date: String,
    pub meals: Vec<SkeletonMeal>,
}

/// Days since 1970-01-01 for a real calendar date, or None.
pub fn parse_date(date: &str) -> Option<i64> {
    let b = date.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let num = |s: &str| {
        s.bytes()
            .all(|c| c.is_ascii_digit())
            .then(|| s.parse::<i64>().ok())
            .flatten()
    };
    let (y, m, d) = (num(&date[0..4])?, num(&date[5..7])?, num(&date[8..10])?);
    if !(1..=12).contains(&m) || d < 1 {
        return None;
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let days_in = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if d > days_in[(m - 1) as usize] {
        return None;
    }
    Some(days_from_civil(y, m, d))
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

pub fn add_days(date: &str, days: i64) -> Option<String> {
    let (y, m, d) = civil_from_days(parse_date(date)? + days);
    Some(format!("{y:04}-{m:02}-{d:02}"))
}

/// ISO weekday, 1 = Monday to 7 = Sunday.
pub fn iso_weekday(date: &str) -> Option<i64> {
    // 1970-01-01 was a Thursday (4).
    Some((parse_date(date)? + 3).rem_euclid(7) + 1)
}

pub fn plan_skeleton(
    members: &[Member],
    rules: &[SlotRule],
    start: &str,
    days: i64,
    meal_types: Option<&[String]>,
) -> Result<Vec<SkeletonDay>, &'static str> {
    if !(1..=MAX_PLAN_DAYS).contains(&days) {
        return Err("days must be 1 to 28");
    }
    parse_date(start).ok_or("date must be YYYY-MM-DD")?;
    let mut slots: Vec<String> = Vec::new();
    for member in members {
        for slot in &member.meal_pattern {
            if !slots.contains(slot) {
                slots.push(slot.clone());
            }
        }
    }
    if let Some(wanted) = meal_types {
        let wanted: Vec<String> = wanted.iter().map(|n| n.trim().to_lowercase()).collect();
        slots.retain(|s| wanted.contains(&s.to_lowercase()));
    }
    let mut out = Vec::new();
    for offset in 0..days {
        let date = add_days(start, offset).ok_or("date does not exist")?;
        let weekday = iso_weekday(&date).ok_or("date does not exist")?;
        let mut meals = Vec::new();
        for (position, slot) in slots.iter().enumerate() {
            let eaters: Vec<String> = members
                .iter()
                .filter(|m| m.meal_pattern.contains(slot))
                .map(|m| m.id.clone())
                .collect();
            let solo = rules
                .iter()
                .find(|r| &r.slot_name == slot)
                .is_some_and(|r| r.solo_weekdays.contains(&weekday));
            if solo {
                for id in eaters {
                    meals.push(SkeletonMeal {
                        slot_name: slot.clone(),
                        slot_position: position,
                        shared: false,
                        eater_ids: vec![id],
                    });
                }
            } else {
                meals.push(SkeletonMeal {
                    slot_name: slot.clone(),
                    slot_position: position,
                    shared: true,
                    eater_ids: eaters,
                });
            }
        }
        out.push(SkeletonDay { date, meals });
    }
    Ok(out)
}

/// An even split of the daily target over the member's meal pattern.
pub fn meal_share_kcal(member: &Member, slot: &str) -> Option<i64> {
    let target = member.calorie_target?;
    if !member.meal_pattern.iter().any(|s| s == slot) {
        return None;
    }
    Some((target as f64 / member.meal_pattern.len() as f64).round() as i64)
}

/// Servings nearest the eater's share, in halves from 0.5 to 2. Unknown values give 1.
pub fn portion_for(share: Option<i64>, kcal_per_serving: Option<f64>) -> f64 {
    match (share, kcal_per_serving) {
        (Some(share), Some(kcal)) if kcal > 0.0 => {
            ((share as f64 / kcal * 2.0).round() / 2.0).clamp(0.5, 2.0)
        }
        _ => 1.0,
    }
}

/// Band for a day's calories against the target: "on" within 15 percent.
pub fn calorie_band(target: i64, estimated: i64) -> (&'static str, i64) {
    let diff = estimated - target;
    let band = if (diff as f64).abs() <= target as f64 * 0.15 {
        "on"
    } else if diff > 0 {
        "over"
    } else {
        "under"
    };
    (band, diff)
}

pub fn fold(c: char) -> Option<char> {
    Some(match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' => 'a',
        'ç' | 'ć' | 'č' => 'c',
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ė' => 'e',
        'ì' | 'í' | 'î' | 'ï' | 'ī' => 'i',
        'ñ' | 'ń' => 'n',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ō' => 'o',
        'ù' | 'ú' | 'û' | 'ü' | 'ū' => 'u',
        'ý' | 'ÿ' => 'y',
        'š' | 'ś' => 's',
        'ž' | 'ź' | 'ż' => 'z',
        '\u{300}'..='\u{36f}' => return None,
        c => c,
    })
}

/// The comparable form of a recipe title: accents folded, lower case, words only.
pub fn title_key(title: &str) -> String {
    let mut key = String::new();
    let mut gap = false;
    for c in title.to_lowercase().chars().filter_map(fold) {
        if c.is_alphanumeric() {
            if gap && !key.is_empty() {
                key.push(' ');
            }
            gap = false;
            key.push(c);
        } else {
            gap = true;
        }
    }
    let key: String = key.chars().take(120).collect::<String>().trim().to_owned();
    if key.is_empty() {
        let raw: String = title.trim().to_lowercase().chars().take(120).collect();
        if raw.is_empty() {
            "untitled".into()
        } else {
            raw
        }
    } else {
        key
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member(id: &str, pattern: &[&str]) -> Member {
        Member {
            id: id.into(),
            meal_pattern: pattern.iter().map(|s| s.to_string()).collect(),
            calorie_target: Some(2000),
        }
    }

    #[test]
    fn dates_round_trip_and_weekdays_are_iso() {
        assert_eq!(parse_date("2024-02-30"), None);
        assert_eq!(parse_date("2024-02-29"), Some(19_782));
        assert_eq!(add_days("2024-02-28", 2).unwrap(), "2024-03-01");
        assert_eq!(iso_weekday("2026-11-16"), Some(1));
        assert_eq!(iso_weekday("2026-11-22"), Some(7));
    }

    #[test]
    fn skeleton_shares_meals_and_splits_solo_days() {
        let members = [member("a", &["lunch", "dinner"]), member("b", &["dinner"])];
        let rules = [SlotRule {
            slot_name: "dinner".into(),
            solo_weekdays: vec![2],
        }];
        let days = plan_skeleton(&members, &rules, "2026-11-16", 2, None).unwrap();
        assert_eq!(days[0].meals.len(), 2);
        assert!(days[0].meals[1].shared);
        assert_eq!(days[0].meals[1].eater_ids, vec!["a", "b"]);
        // Tuesday dinner is solo, so each eater gets their own.
        assert_eq!(days[1].meals.len(), 3);
        assert!(!days[1].meals[1].shared && days[1].meals[1].eater_ids == vec!["a"]);
        assert!(plan_skeleton(&members, &rules, "2026-11-16", 29, None).is_err());
        let only = ["Dinner".to_string()];
        let filtered = plan_skeleton(&members, &rules, "2026-11-16", 1, Some(&only)).unwrap();
        assert_eq!(filtered[0].meals.len(), 1);
    }

    #[test]
    fn portions_round_to_halves_and_clamp() {
        let m = member("a", &["lunch", "dinner"]);
        assert_eq!(meal_share_kcal(&m, "lunch"), Some(1000));
        assert_eq!(meal_share_kcal(&m, "snack"), None);
        assert_eq!(portion_for(Some(1000), Some(600.0)), 1.5);
        assert_eq!(portion_for(Some(1000), Some(100.0)), 2.0);
        assert_eq!(portion_for(Some(100), Some(1000.0)), 0.5);
        assert_eq!(portion_for(None, Some(600.0)), 1.0);
        assert_eq!(calorie_band(2000, 2200), ("on", 200));
        assert_eq!(calorie_band(2000, 2400), ("over", 400));
        assert_eq!(calorie_band(2000, 1500), ("under", -500));
    }

    #[test]
    fn title_keys_ignore_case_accents_and_punctuation() {
        assert_eq!(title_key("  Crème Brûlée!! "), "creme brulee");
        assert_eq!(title_key("!!!"), "!!!");
        assert_eq!(title_key(""), "untitled");
    }
}
