//! Picks the lowest-cost model from the list an agent reports. Moss never names a model itself.

/// Lower is cheaper. Names carry their tier, so the ranking reads the name the agent gave.
fn cost_rank(id: &str) -> u32 {
    let id = id.to_lowercase();
    const TIERS: [(&str, u32); 8] = [
        ("nano", 0),
        ("lite", 1),
        ("haiku", 1),
        ("flash", 1),
        ("mini", 2),
        ("small", 2),
        ("spark", 2),
        ("free", 0),
    ];
    TIERS
        .iter()
        .filter(|(word, _)| id.contains(word))
        .map(|(_, rank)| *rank)
        .min()
        .unwrap_or(10)
}

pub fn pick_cheapest(ids: Vec<String>) -> Option<String> {
    // Stable: among equal ranks the agent's own order (usually its recommended first) wins.
    ids.into_iter().enumerate().min_by_key(|(i, id)| (cost_rank(id), *i)).map(|(_, id)| id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_small_tier() {
        let ids = vec!["big-pro".into(), "big-mini".into(), "other".into()];
        assert_eq!(pick_cheapest(ids).as_deref(), Some("big-mini"));
    }

    #[test]
    fn keeps_agent_order_when_nothing_is_marked() {
        let ids = vec!["first".into(), "second".into()];
        assert_eq!(pick_cheapest(ids).as_deref(), Some("first"));
    }

    #[test]
    fn empty_list_has_no_pick() {
        assert_eq!(pick_cheapest(vec![]), None);
    }
}
