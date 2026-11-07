//! Whether the disks holding Moss data are encrypted, reported as verified, off or unknown.
//!
//! The rule (companion doc, "At-rest claims"): Moss claims protection from a stolen disk only
//! when every place its data can land is verified encrypted. That means the data folder, swap
//! and crash dumps, plus backup destinations once backups exist. Unknown is shown plainly and
//! never earns an "encrypted" badge.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Verified,
    Off,
    Unknown,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Verified => "verified",
            Status::Off => "off",
            Status::Unknown => "unknown",
        }
    }
}

/// One place Moss data can land, and what the check found there.
#[derive(Debug, Clone)]
pub struct Check {
    pub item: String,
    pub path: Option<PathBuf>,
    pub status: Status,
    pub method: Option<String>,
    pub evidence: Vec<String>,
}

impl Check {
    fn new(item: &str, path: Option<&Path>, verdict: Verdict) -> Check {
        Check {
            item: item.into(),
            path: path.map(Path::to_path_buf),
            status: verdict.status,
            method: verdict.method,
            evidence: verdict.evidence,
        }
    }
}

/// What the installer shows.
#[derive(Debug, Clone)]
pub struct Report {
    pub status: Status,
    /// True only when every check is verified.
    pub claim_protection: bool,
    pub checks: Vec<Check>,
    pub message: String,
}

impl Report {
    pub fn from_checks(checks: Vec<Check>) -> Report {
        let status = if checks.iter().any(|c| c.status == Status::Off) {
            Status::Off
        } else if !checks.is_empty() && checks.iter().all(|c| c.status == Status::Verified) {
            Status::Verified
        } else {
            Status::Unknown
        };
        let names = |wanted: Status| {
            let items: Vec<&str> =
                checks.iter().filter(|c| c.status == wanted).map(|c| c.item.as_str()).collect();
            items.join(", ")
        };
        let message = match status {
            Status::Verified => "Disk encryption is on everywhere Moss keeps data. If this computer's disk \
                                 is lost or stolen while it is switched off, Moss data cannot be read."
                .to_string(),
            Status::Off => format!(
                "Disk encryption is off for: {}. Anyone who gets this disk can read Moss data. Moss makes \
                 no claim that data on disk is protected.",
                names(Status::Off)
            ),
            Status::Unknown => format!(
                "Moss could not check disk encryption for: {}. Moss makes no claim that data on disk \
                 is protected.",
                names(Status::Unknown)
            ),
        };
        Report { claim_protection: status == Status::Verified, status, checks, message }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "status": self.status.as_str(),
            "claim_protection": self.claim_protection,
            "message": self.message,
            "checks": self.checks.iter().map(|c| json!({
                "item": c.item,
                "path": c.path,
                "status": c.status.as_str(),
                "method": c.method,
                "evidence": c.evidence,
            })).collect::<Vec<_>>(),
        })
    }
}

#[derive(Debug, Clone)]
pub struct Verdict {
    pub status: Status,
    pub method: Option<String>,
    pub evidence: Vec<String>,
}

impl Verdict {
    fn verified(method: &str, evidence: String) -> Verdict {
        Verdict { status: Status::Verified, method: Some(method.into()), evidence: vec![evidence] }
    }
    fn off(evidence: String) -> Verdict {
        Verdict { status: Status::Off, method: None, evidence: vec![evidence] }
    }
    fn unknown(evidence: String) -> Verdict {
        Verdict { status: Status::Unknown, method: None, evidence: vec![evidence] }
    }
}

// --- Linux -----------------------------------------------------------------------------

/// One line of `/proc/self/mountinfo`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mount {
    pub major: u32,
    pub minor: u32,
    pub mount_point: PathBuf,
    pub fs_type: String,
    pub source: String,
}

/// Parses mountinfo. Fields: id, parent, major:minor, root, mount point, options, optional
/// fields up to `-`, then type, source, super options. Spaces arrive as `\040`.
pub fn parse_mountinfo(text: &str) -> Vec<Mount> {
    let mut mounts = Vec::new();
    for line in text.lines() {
        let fields: Vec<&str> = line.split(' ').collect();
        let Some(dash) = fields.iter().position(|f| *f == "-") else { continue };
        if fields.len() < dash + 3 || dash < 6 {
            continue;
        }
        let Some((major, minor)) = fields[2].split_once(':') else { continue };
        let (Ok(major), Ok(minor)) = (major.parse(), minor.parse()) else { continue };
        mounts.push(Mount {
            major,
            minor,
            mount_point: PathBuf::from(unescape(fields[4])),
            fs_type: fields[dash + 1].to_string(),
            source: unescape(fields[dash + 2]),
        });
    }
    mounts
}

/// Undoes the kernel's octal escapes (`\040` for a space).
fn unescape(field: &str) -> String {
    let bytes = field.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'\\' && at + 3 < bytes.len() && bytes[at + 1..at + 4].iter().all(|b| (b'0'..=b'7').contains(b)) {
            let value = (bytes[at + 1] - b'0') * 64 + (bytes[at + 2] - b'0') * 8 + (bytes[at + 3] - b'0');
            out.push(value);
            at += 4;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The mount that holds `path`: the longest mount point above it, the latest one on a tie.
pub fn mount_for<'a>(mounts: &'a [Mount], path: &Path) -> Option<&'a Mount> {
    let mut best: Option<&Mount> = None;
    for mount in mounts {
        if path.starts_with(&mount.mount_point)
            && best.is_none_or(|b| mount.mount_point.components().count() >= b.mount_point.components().count())
        {
            best = Some(mount);
        }
    }
    best
}

/// dm-crypt flavours, by the prefix of the device-mapper UUID.
const CRYPT_PREFIXES: [(&str, &str); 5] = [
    ("CRYPT-LUKS2", "LUKS2 (dm-crypt)"),
    ("CRYPT-LUKS1", "LUKS1 (dm-crypt)"),
    ("CRYPT-PLAIN", "plain dm-crypt"),
    ("CRYPT-BITLK", "BitLocker (dm-crypt)"),
    ("CRYPT-TCRYPT", "VeraCrypt (dm-crypt)"),
];

/// Walks the block device stack in sysfs. A device is encrypted when it is a dm-crypt
/// mapping, or when every device under it is (LVM or RAID on top of LUKS).
pub fn block_device(sys: &Path, major: u32, minor: u32, depth: u32) -> Verdict {
    let node = sys.join(format!("dev/block/{major}:{minor}"));
    let Ok(dir) = node.canonicalize() else {
        return Verdict::unknown(format!("block device {major}:{minor} is not in sysfs"));
    };
    let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if depth > 8 {
        return Verdict::unknown(format!("{name}: device stack too deep"));
    }
    let uuid = std::fs::read_to_string(dir.join("dm/uuid")).unwrap_or_default();
    let uuid = uuid.trim();
    if let Some((_, method)) = CRYPT_PREFIXES.iter().find(|(prefix, _)| uuid.starts_with(prefix)) {
        let mapped = std::fs::read_to_string(dir.join("dm/name")).unwrap_or_default();
        return Verdict::verified(method, format!("{name} ({}) is {method}", mapped.trim()));
    }
    if dir.join("loop/backing_file").exists() {
        return Verdict::unknown(format!("{name} is a loop device backed by a file"));
    }
    let slaves: Vec<String> = std::fs::read_dir(dir.join("slaves"))
        .map(|entries| entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
        .unwrap_or_default();
    if slaves.is_empty() {
        let kind = if dir.join("partition").exists() { "partition" } else { "disk" };
        return Verdict::off(format!(
            "{name} is a plain {kind} with no encryption layer (drive-level hardware encryption is not checked)"
        ));
    }
    let layer = if uuid.starts_with("LVM-") {
        "LVM volume"
    } else if name.starts_with("md") {
        "RAID array"
    } else {
        "mapped device"
    };
    let mut below = Vec::new();
    for slave in &slaves {
        let dev = std::fs::read_to_string(sys.join(format!("class/block/{slave}/dev"))).unwrap_or_default();
        let parsed = dev.trim().split_once(':').and_then(|(a, b)| Some((a.parse().ok()?, b.parse().ok()?)));
        below.push(match parsed {
            Some((major, minor)) => block_device(sys, major, minor, depth + 1),
            None => Verdict::unknown(format!("{slave}: no device number")),
        });
    }
    let mut evidence = vec![format!("{name} is a {layer} on {}", slaves.join(", "))];
    evidence.extend(below.iter().flat_map(|v| v.evidence.clone()));
    let status = if below.iter().all(|v| v.status == Status::Verified) {
        Status::Verified
    } else if below.iter().any(|v| v.status == Status::Off) {
        Status::Off
    } else {
        Status::Unknown
    };
    Verdict { status, method: below.iter().find_map(|v| v.method.clone()), evidence }
}

/// The verdict for the filesystem that holds `path`.
pub fn filesystem(sys: &Path, mount: &Mount, device: Option<(u32, u32)>) -> Verdict {
    let at = format!("{} ({})", mount.mount_point.display(), mount.fs_type);
    match mount.fs_type.as_str() {
        "ecryptfs" => Verdict::verified("eCryptfs", format!("{at} is an eCryptfs folder")),
        "fuse.gocryptfs" | "fuse.cryfs" => {
            Verdict::verified(&mount.fs_type[5..], format!("{at} is an encrypted FUSE folder"))
        }
        "nfs" | "nfs4" | "cifs" | "smb3" | "9p" | "virtiofs" | "fuse.sshfs" | "ceph" | "glusterfs" => {
            Verdict::unknown(format!("{at} is a network or shared folder; its disk cannot be checked from here"))
        }
        "tmpfs" | "ramfs" => Verdict::unknown(format!("{at} lives in memory and may be swapped out")),
        "overlay" => Verdict::unknown(format!("{at} is an overlay; the disks under it are not checked")),
        "zfs" => Verdict::unknown(format!("{at}: ZFS native encryption is not checked in this spike")),
        fs if fs.starts_with("fuse") => Verdict::unknown(format!("{at} is a FUSE folder of unknown kind")),
        _ => match device {
            Some((major, minor)) => {
                let mut verdict = block_device(sys, major, minor, 0);
                verdict.evidence.insert(0, format!("{at} is on block device {major}:{minor}"));
                verdict
            }
            None => Verdict::unknown(format!("{at}: no block device found")),
        },
    }
}

/// Linux device numbers, as glibc packs them.
pub fn split_dev(dev: u64) -> (u32, u32) {
    let major = ((dev >> 8) & 0xfff) | ((dev >> 32) & !0xfff);
    let minor = (dev & 0xff) | ((dev >> 12) & !0xff);
    (major as u32, minor as u32)
}

/// One `/proc/swaps` entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Swap {
    pub path: PathBuf,
    pub kind: String,
}

pub fn parse_swaps(text: &str) -> Vec<Swap> {
    text.lines()
        .skip(1)
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            Some(Swap { path: PathBuf::from(unescape(fields.next()?)), kind: fields.next()?.to_string() })
        })
        .collect()
}

/// The soft core-dump limit from `/proc/<pid>/limits`, if the process has one.
pub fn core_limit(limits: &str) -> Option<String> {
    let line = limits.lines().find(|line| line.starts_with("Max core file size"))?;
    line["Max core file size".len()..].split_whitespace().next().map(str::to_string)
}

#[cfg(target_os = "linux")]
pub mod linux {
    use super::*;
    use std::os::unix::fs::MetadataExt;

    /// Checks each labelled folder, swap, and crash dumps for the running database process.
    pub fn report(paths: &[(String, PathBuf)], database_pid: Option<i32>) -> Report {
        let sys = Path::new("/sys");
        let mounts = parse_mountinfo(&std::fs::read_to_string("/proc/self/mountinfo").unwrap_or_default());
        let mut checks = Vec::new();
        for (item, path) in paths {
            checks.push(Check::new(item, Some(path), path_verdict(sys, &mounts, path)));
        }
        checks.push(Check::new("Swap", None, swap_verdict(sys, &mounts)));
        checks.push(Check::new("Crash dumps", None, crash_dump_verdict(database_pid)));
        Report::from_checks(checks)
    }

    pub fn path_verdict(sys: &Path, mounts: &[Mount], path: &Path) -> Verdict {
        // A folder not made yet is judged by the nearest folder above it that exists.
        let mut existing = path.to_path_buf();
        while !existing.exists() {
            if !existing.pop() {
                return Verdict::unknown(format!("{} does not exist", path.display()));
            }
        }
        let Ok(real) = existing.canonicalize() else {
            return Verdict::unknown(format!("{} cannot be resolved", path.display()));
        };
        let Some(mount) = mount_for(mounts, &real) else {
            return Verdict::unknown(format!("no mount holds {}", real.display()));
        };
        if let Some(verdict) = fscrypt(&real) {
            return verdict;
        }
        filesystem(sys, mount, device_of(mount, &real))
    }

    /// The block device under a mount. Btrfs reports an anonymous device number, so its
    /// source device node is used instead.
    fn device_of(mount: &Mount, path: &Path) -> Option<(u32, u32)> {
        if mount.major != 0 {
            return Some((mount.major, mount.minor));
        }
        if mount.source.starts_with("/dev/") {
            let dev = std::fs::metadata(&mount.source).ok()?.rdev();
            return Some(split_dev(dev));
        }
        let _ = path;
        None
    }

    /// ext4 and f2fs per-folder encryption, via `FS_IOC_GET_ENCRYPTION_POLICY_EX`.
    fn fscrypt(path: &Path) -> Option<Verdict> {
        use std::os::fd::AsRawFd;
        const FS_IOC_GET_ENCRYPTION_POLICY_EX: libc::c_ulong = 0xC009_6616;
        let dir = std::fs::File::open(path).ok()?;
        // policy_size (u64) then room for the largest policy (24 bytes).
        let mut arg = [0u8; 32];
        arg[..8].copy_from_slice(&24u64.to_ne_bytes());
        let result = unsafe { libc::ioctl(dir.as_raw_fd(), FS_IOC_GET_ENCRYPTION_POLICY_EX, arg.as_mut_ptr()) };
        (result == 0).then(|| {
            Verdict::verified("fscrypt", format!("{} has an fscrypt policy (version {})", path.display(), arg[8]))
        })
    }

    fn swap_verdict(sys: &Path, mounts: &[Mount]) -> Verdict {
        let swaps = parse_swaps(&std::fs::read_to_string("/proc/swaps").unwrap_or_default());
        if swaps.is_empty() {
            return Verdict::verified("no swap", "no swap space is in use".into());
        }
        let mut verdicts = Vec::new();
        for swap in &swaps {
            let name = swap.path.display().to_string();
            verdicts.push(if name.starts_with("/dev/zram") {
                Verdict::verified("zram", format!("{name} is compressed memory, never written to disk"))
            } else if swap.kind == "partition" {
                match std::fs::metadata(&swap.path) {
                    Ok(meta) => {
                        let (major, minor) = split_dev(meta.rdev());
                        let mut verdict = block_device(sys, major, minor, 0);
                        verdict.evidence.insert(0, format!("swap partition {name}"));
                        verdict
                    }
                    Err(_) => Verdict::unknown(format!("swap partition {name} cannot be read")),
                }
            } else {
                let mut verdict = path_verdict(sys, mounts, &swap.path);
                verdict.evidence.insert(0, format!("swap file {name}"));
                verdict
            });
        }
        let status = if verdicts.iter().all(|v| v.status == Status::Verified) {
            Status::Verified
        } else if verdicts.iter().any(|v| v.status == Status::Off) {
            Status::Off
        } else {
            Status::Unknown
        };
        Verdict {
            status,
            method: verdicts.iter().find_map(|v| v.method.clone()),
            evidence: verdicts.into_iter().flat_map(|v| v.evidence).collect(),
        }
    }

    /// The supervisor starts Postgres with a zero core-dump limit. This reads the limit back
    /// from the running process, and notes where the system would send dumps from others.
    fn crash_dump_verdict(database_pid: Option<i32>) -> Verdict {
        let pattern = std::fs::read_to_string("/proc/sys/kernel/core_pattern").unwrap_or_default();
        let destination = format!("system crash dumps go to: {}", pattern.trim());
        let Some(pid) = database_pid else {
            return Verdict {
                status: Status::Unknown,
                method: None,
                evidence: vec!["the database is not running, so its crash-dump limit was not read".into(), destination],
            };
        };
        let limits = std::fs::read_to_string(format!("/proc/{pid}/limits")).unwrap_or_default();
        match core_limit(&limits).as_deref() {
            Some("0") => Verdict {
                status: Status::Verified,
                method: Some("turned off for the database".into()),
                evidence: vec![format!("database process {pid} has a crash-dump size limit of 0"), destination],
            },
            Some(other) => Verdict {
                status: Status::Off,
                method: None,
                evidence: vec![format!("database process {pid} may write crash dumps (limit {other})"), destination],
            },
            None => Verdict::unknown(format!("limits of process {pid} could not be read")),
        }
    }
}

// --- macOS, parsed from command output so the parsers run anywhere -------------------------

/// `fdesetup status`: "FileVault is On." or "FileVault is Off."
pub fn parse_fdesetup(text: &str) -> Verdict {
    let line = text.lines().next().unwrap_or_default().trim().to_string();
    if line.starts_with("FileVault is On") {
        Verdict::verified("FileVault", line)
    } else if line.starts_with("FileVault is Off") {
        Verdict::off(line)
    } else {
        Verdict::unknown(format!("fdesetup said: {line}"))
    }
}

/// `diskutil info -plist <folder>`: the `FileVault` key of the volume holding the folder.
pub fn parse_diskutil_plist(text: &str) -> Verdict {
    let value = |key: &str| {
        let at = text.find(&format!("<key>{key}</key>"))?;
        let rest = text[at..].split_once("</key>")?.1.trim_start();
        if rest.starts_with("<true/>") {
            Some(true)
        } else if rest.starts_with("<false/>") {
            Some(false)
        } else {
            None
        }
    };
    let volume = text
        .find("<key>VolumeName</key>")
        .and_then(|at| text[at..].split_once("<string>"))
        .and_then(|(_, rest)| rest.split_once("</string>"))
        .map(|(name, _)| name.to_string())
        .unwrap_or_else(|| "the volume".into());
    match value("FileVault") {
        Some(true) => Verdict::verified("FileVault", format!("{volume} has FileVault on")),
        Some(false) => Verdict::off(format!("{volume} has FileVault off")),
        None => Verdict::unknown(format!("{volume}: diskutil gave no FileVault value")),
    }
}

/// `sysctl vm.swapusage`: macOS marks encrypted swap with "(encrypted)".
pub fn parse_swapusage(text: &str) -> Verdict {
    let line = text.trim().to_string();
    if line.contains("(encrypted)") {
        Verdict::verified("encrypted swap", line)
    } else {
        Verdict::unknown(format!("swap not marked encrypted: {line}"))
    }
}

/// macOS: FileVault per folder from `diskutil`, swap from `sysctl`. Not compiled or run in
/// this spike because the Mac has no Rust toolchain. The parsers above are tested on Linux
/// against output captured on the test Mac.
#[cfg(target_os = "macos")]
pub mod macos {
    use super::*;
    use std::process::Command;

    pub fn report(paths: &[(String, PathBuf)]) -> Report {
        let mut checks = Vec::new();
        for (item, path) in paths {
            let folder = path.ancestors().find(|p| p.exists()).unwrap_or(Path::new("/"));
            let verdict = match Command::new("/usr/sbin/diskutil").arg("info").arg("-plist").arg(folder).output() {
                Ok(out) if out.status.success() => parse_diskutil_plist(&String::from_utf8_lossy(&out.stdout)),
                _ => Verdict::unknown(format!("diskutil could not describe {}", folder.display())),
            };
            checks.push(Check::new(item, Some(path), verdict));
        }
        let swap = match Command::new("/usr/sbin/sysctl").arg("vm.swapusage").output() {
            Ok(out) if out.status.success() => parse_swapusage(&String::from_utf8_lossy(&out.stdout)),
            _ => Verdict::unknown("sysctl vm.swapusage failed".into()),
        };
        checks.push(Check::new("Swap", None, swap));
        // macOS cannot read another process's limits back. The supervisor sets the limit in
        // the child before Postgres runs, and the start fails if it cannot.
        checks.push(Check::new(
            "Crash dumps",
            None,
            Verdict::verified(
                "turned off for the database",
                "the supervisor starts the database with a crash-dump size limit of 0".into(),
            ),
        ));
        Report::from_checks(checks)
    }
}
