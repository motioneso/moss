//! Bounded-memory byte search, including matches across read boundaries.
use std::{
    fs::File,
    io::{self, Read},
    path::Path,
};

pub(crate) fn contains(path: &Path, secrets: &[Vec<u8>]) -> io::Result<bool> {
    let mut file = File::open(path)?;
    let overlap = secrets
        .iter()
        .map(Vec::len)
        .max()
        .unwrap_or(0)
        .saturating_sub(1);
    let mut window = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut chunk)?;
        if count == 0 {
            return Ok(false);
        }
        window.extend_from_slice(&chunk[..count]);
        if secrets.iter().any(|secret| {
            !secret.is_empty() && window.windows(secret.len()).any(|bytes| bytes == secret)
        }) {
            return Ok(true);
        }
        if window.len() > overlap {
            window.drain(..window.len() - overlap);
        }
    }
}
