use std::{
    collections::HashMap,
    net::IpAddr,
    time::{Duration, Instant},
};

/// Fixed budgets bound both the map and aggregate password-hashing work.
pub struct SignInLimit {
    peers: HashMap<IpAddr, u16>,
    total: u16,
    local_total: u16,
    reset: Instant,
}

impl Default for SignInLimit {
    fn default() -> Self {
        Self {
            peers: HashMap::new(),
            total: 0,
            local_total: 0,
            reset: Instant::now() + Duration::from_secs(60),
        }
    }
}

impl SignInLimit {
    pub fn allow(&mut self, ip: IpAddr, now: Instant) -> bool {
        if now >= self.reset {
            self.peers.clear();
            self.total = 0;
            self.local_total = 0;
            self.reset = now + Duration::from_secs(60);
        }
        let local = crate::policy::loopback(ip);
        let budget = if local {
            &mut self.local_total
        } else {
            &mut self.total
        };
        if *budget >= 100 {
            return false;
        }
        let bucket = match ip {
            IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
                Some(v4) => IpAddr::V4(v4),
                None if !local => {
                    IpAddr::V6(std::net::Ipv6Addr::from(u128::from(v6) & (u128::MAX << 64)))
                }
                None => ip,
            },
            _ => ip,
        };
        let count = self.peers.entry(bucket).or_default();
        if *count >= 5 {
            return false;
        }
        *count += 1;
        *budget += 1;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rotating_ipv6_addresses_share_one_prefix_budget() {
        let mut limit = SignInLimit::default();
        let now = Instant::now();
        for n in 1..=5 {
            assert!(limit.allow(format!("2001:db8:1:2::{n}").parse().unwrap(), now));
        }
        assert!(!limit.allow("2001:db8:1:2::100".parse().unwrap(), now));
        assert!(limit.allow("2001:db8:1:3::1".parse().unwrap(), now));
    }

    #[test]
    fn limits_peers_and_total_and_recovers() {
        let mut limit = SignInLimit::default();
        let ip = "127.0.0.1".parse().unwrap();
        let now = Instant::now();
        for _ in 0..5 {
            assert!(limit.allow(ip, now));
        }
        assert!(!limit.allow(ip, now));
        for n in 1..=100 {
            assert!(limit.allow(IpAddr::V4(std::net::Ipv4Addr::new(192, 0, 2, n)), now));
        }
        assert!(!limit.allow("192.0.2.200".parse().unwrap(), now));
        assert!(limit.allow("127.0.0.2".parse().unwrap(), now));
        assert!(limit.allow(ip, now + Duration::from_secs(61)));
    }
}
