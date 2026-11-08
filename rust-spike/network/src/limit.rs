use std::{
    collections::HashMap,
    net::IpAddr,
    time::{Duration, Instant},
};

/// Fixed budgets bound both the map and aggregate password-hashing work.
pub struct SignInLimit {
    peers: HashMap<IpAddr, u16>,
    total: u16,
    reset: Instant,
}

impl Default for SignInLimit {
    fn default() -> Self {
        Self {
            peers: HashMap::new(),
            total: 0,
            reset: Instant::now() + Duration::from_secs(60),
        }
    }
}

impl SignInLimit {
    pub fn allow(&mut self, ip: IpAddr, now: Instant) -> bool {
        if now >= self.reset {
            self.peers.clear();
            self.total = 0;
            self.reset = now + Duration::from_secs(60);
        }
        if self.total >= 100 {
            return false;
        }
        let count = self.peers.entry(ip).or_default();
        if *count >= 5 {
            return false;
        }
        *count += 1;
        self.total += 1;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn limits_peers_and_total_and_recovers() {
        let mut limit = SignInLimit::default();
        let ip = "127.0.0.1".parse().unwrap();
        let now = Instant::now();
        for _ in 0..5 {
            assert!(limit.allow(ip, now));
        }
        assert!(!limit.allow(ip, now));
        for n in 1..=95 {
            assert!(limit.allow(IpAddr::V4(std::net::Ipv4Addr::new(192, 0, 2, n)), now));
        }
        assert!(!limit.allow("192.0.2.200".parse().unwrap(), now));
        assert!(limit.allow(ip, now + Duration::from_secs(61)));
    }
}
