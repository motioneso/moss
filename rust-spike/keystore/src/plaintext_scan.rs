//! Bounded-memory byte search, including matches across read boundaries.
use std::{
    fs::File,
    io::{self, Read},
    path::Path,
};

pub(crate) fn contains(path: &Path, secrets: &[Vec<u8>]) -> io::Result<bool> {
    // Sockets and pipes do not contain persistent file bytes. Never open a
    // pipe here: it can block the scan. Follow links so linked copies count.
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    if !metadata.is_file() {
        return Ok(false);
    }
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
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
