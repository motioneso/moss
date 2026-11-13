//! Robots rules for the public-web fetch mode. Follows the longest-match rule: the longest
//! matching pattern wins, and an allow beats a disallow of the same length.

struct Rule {
    allow: bool,
    length: usize,
    pattern: Vec<u8>,
    anchored: bool,
}
struct Group {
    agents: Vec<String>,
    rules: Vec<Rule>,
}
pub struct Robots {
    rules: Vec<Rule>,
}

fn compile(value: &str, allow: bool) -> Option<Rule> {
    if value.is_empty() || value.len() > 512 {
        return None;
    }
    let anchored = value.ends_with('$');
    let text = value.strip_suffix('$').unwrap_or(value);
    Some(Rule {
        allow,
        length: value.chars().filter(|c| !matches!(c, '*' | '$')).count(),
        pattern: text.as_bytes().to_vec(),
        anchored,
    })
}

/// Wildcard match with a single backtrack point, so hostile patterns cannot blow up.
fn matches(rule: &Rule, path: &[u8]) -> bool {
    let pattern = &rule.pattern;
    let (mut p, mut s) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    loop {
        if p == pattern.len() {
            if !rule.anchored || s == path.len() {
                return true;
            }
        } else if pattern[p] == b'*' {
            star = Some((p, s));
            p += 1;
            continue;
        } else if s < path.len() && pattern[p] == path[s] {
            p += 1;
            s += 1;
            continue;
        }
        match star {
            Some((star_p, star_s)) if star_s < path.len() => {
                star = Some((star_p, star_s + 1));
                p = star_p + 1;
                s = star_s + 1;
            }
            _ => return false,
        }
    }
}

impl Robots {
    pub fn parse(body: &str, agent: &str) -> Self {
        let mut groups: Vec<Group> = vec![];
        let mut agents: Vec<String> = vec![];
        let mut rules: Vec<Rule> = vec![];
        let flush = |agents: &mut Vec<String>, rules: &mut Vec<Rule>, groups: &mut Vec<Group>| {
            if !agents.is_empty() {
                groups.push(Group {
                    agents: std::mem::take(agents),
                    rules: std::mem::take(rules),
                });
            }
            agents.clear();
            rules.clear();
        };
        for raw in body.lines() {
            let line = raw.split('#').next().unwrap_or("").trim();
            if line.is_empty() {
                if !rules.is_empty() {
                    flush(&mut agents, &mut rules, &mut groups);
                }
                continue;
            }
            let Some((field, value)) = line.split_once(':') else {
                continue;
            };
            let (field, value) = (field.trim().to_ascii_lowercase(), value.trim());
            if field == "user-agent" {
                if !rules.is_empty() {
                    flush(&mut agents, &mut rules, &mut groups);
                }
                agents.push(value.to_ascii_lowercase());
            } else if (field == "allow" || field == "disallow") && !agents.is_empty() {
                rules.extend(compile(value, field == "allow"));
            }
        }
        flush(&mut agents, &mut rules, &mut groups);
        let target = agent.to_ascii_lowercase();
        let specific = groups.iter().any(|g| g.agents.contains(&target));
        let wanted = if specific { target.as_str() } else { "*" };
        let rules = groups
            .into_iter()
            .filter(|g| g.agents.iter().any(|a| a == wanted))
            .flat_map(|g| g.rules)
            .collect();
        Self { rules }
    }
    pub fn allows(&self, path: &str) -> bool {
        let best = self
            .rules
            .iter()
            .filter(|rule| matches(rule, path.as_bytes()))
            .max_by_key(|rule| (rule.length, rule.allow));
        best.is_none_or(|rule| rule.allow)
    }
    pub fn allow_all() -> Self {
        Self { rules: vec![] }
    }
    pub fn deny_all() -> Self {
        Self {
            rules: vec![Rule {
                allow: false,
                length: 1,
                pattern: b"/".to_vec(),
                anchored: false,
            }],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn longest_match_wins_and_allow_breaks_ties() {
        let r = Robots::parse(
            "User-agent: *\nDisallow: /private\nAllow: /private/open\nDisallow: /tie\nAllow: /tie\n",
            "moss",
        );
        assert!(r.allows("/news"));
        assert!(!r.allows("/private/x"));
        assert!(r.allows("/private/open/x"));
        assert!(r.allows("/tie"));
    }
    #[test]
    fn wildcards_anchors_and_specific_agent_groups() {
        let r = Robots::parse(
            "User-agent: *\nDisallow: /a*b$\nDisallow: /q?\n\nUser-agent: moss\nDisallow: /only-moss\n",
            "Moss",
        );
        assert!(!r.allows("/only-moss"));
        assert!(
            r.allows("/a-b-c"),
            "the star group is ignored once a specific group exists"
        );
        let r = Robots::parse("User-agent: *\nDisallow: /a*b$\nDisallow: /q?\n", "moss");
        assert!(!r.allows("/axxb"));
        assert!(r.allows("/axxbc"));
        assert!(!r.allows("/q?x=1"));
    }
    #[test]
    fn hostile_patterns_finish_quickly() {
        let body = format!("User-agent: *\nDisallow: {}b\n", "*a".repeat(200));
        let r = Robots::parse(&body, "moss");
        let started = std::time::Instant::now();
        assert!(r.allows(&"a".repeat(5000)));
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
    }
}
