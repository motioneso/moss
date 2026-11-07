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

/// The Linux check on whether a crash can copy Moss memory into a dump. It judges processes,
/// not a disk, so the message words it apart from the disk checks.
pub const CRASH_DUMPS: &str = "Crash dumps";

const NO_CLAIM: &str = "Moss makes no claim that data on disk is protected.";

impl Report {
    pub fn from_checks(checks: Vec<Check>) -> Report {
        let status = if checks.iter().any(|c| c.status == Status::Off) {
            Status::Off
        } else if !checks.is_empty() && checks.iter().all(|c| c.status == Status::Verified) {
            Status::Verified
        } else {
            Status::Unknown
        };

        // The disk items with this status, and whether the crash-dump check has it.
        let split = |wanted: Status| {
            let disks: Vec<&str> = checks
                .iter()
                .filter(|c| c.status == wanted && c.item != CRASH_DUMPS)
                .map(|c| c.item.as_str())
                .collect();
            (disks.join(", "), checks.iter().any(|c| c.status == wanted && c.item == CRASH_DUMPS))
        };
        let mut parts = Vec::new();
        match status {
            Status::Verified => parts.push(
                "Disk encryption is on everywhere Moss keeps data. If this computer's disk is lost or \
                 stolen while it is switched off, Moss data cannot be read."
                    .to_string(),
            ),
            Status::Off => {
                let (disks, dumps) = split(Status::Off);
                if !disks.is_empty() {
                    parts.push(format!("Disk encryption is off for: {disks}. Anyone who gets this disk can read Moss data."));
                }
                if dumps {
                    parts.push("A crash can save Moss memory, which holds private data, in a crash dump.".into());
                }
                parts.push(NO_CLAIM.into());
            }
            Status::Unknown => {
                let (disks, dumps) = split(Status::Unknown);
                if !disks.is_empty() {
                    parts.push(format!("Moss could not check disk encryption for: {disks}."));
                }
                if dumps {
                    parts.push("Moss could not check whether a crash can save its memory in a crash dump.".into());
                }
                parts.push(NO_CLAIM.into());
            }
        }
        Report { claim_protection: status == Status::Verified, status, checks, message: parts.join(" ") }
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
        let octal = |b: &u8| (b'0'..=b'7').contains(b);
        if bytes[at] == b'\\'
            && at + 3 < bytes.len()
            && (b'0'..=b'3').contains(&bytes[at + 1])
            && bytes[at + 2..at + 4].iter().all(octal)
        {
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
        "an LVM volume"
    } else if name.starts_with("md") {
        "a RAID array"
    } else {
        "a mapped device"
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
    let mut evidence = vec![format!("{name} is {layer} on {}", slaves.join(", "))];
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

/// The number of block device `node`, read from the node itself or else from sysfs by name.
fn device_number(sys: &Path, node: &Path) -> Option<(u32, u32)> {
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    if let Ok(meta) = std::fs::metadata(node) {
        return meta.file_type().is_block_device().then(|| split_dev(meta.rdev()));
    }
    let name = node.file_name()?.to_str()?;
    let dev = std::fs::read_to_string(sys.join(format!("class/block/{name}/dev"))).ok()?;
    let (major, minor) = dev.trim().split_once(':')?;
    Some((major.parse().ok()?, minor.parse().ok()?))
}

/// zram swap stays in memory unless it was given a backing device. The kernel then writes idle
/// and incompressible pages to that device, so the device is judged like any other.
pub fn zram_verdict(sys: &Path, device: &str) -> Verdict {
    let swap = format!("swap device /dev/{device} is zram (compressed memory)");
    let Ok(backing) = std::fs::read_to_string(sys.join(format!("class/block/{device}/backing_dev"))) else {
        return Verdict {
            status: Status::Unknown,
            method: None,
            evidence: vec![swap, "its backing device setting cannot be read".into()],
        };
    };
    let backing = backing.trim();
    if backing == "none" {
        return Verdict {
            status: Status::Verified,
            method: Some("zram".into()),
            evidence: vec![swap, "it has no backing device, so its pages are never written to disk".into()],
        };
    }
    let mut verdict = match device_number(sys, Path::new(backing)) {
        Some((major, minor)) => block_device(sys, major, minor, 0),
        None => Verdict::unknown(format!("backing device {backing} cannot be found")),
    };
    verdict.evidence.insert(0, format!("{swap} and writes pages out to {backing}"));
    verdict
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

    /// Checks each labelled folder, swap, and crash dumps of the supervisor and the database.
    pub fn report(paths: &[(String, PathBuf)], supervisor: Result<Option<i32>, String>, database_pids: &[i32]) -> Report {
        let sys = Path::new("/sys");
        let mounts = parse_mountinfo(&std::fs::read_to_string("/proc/self/mountinfo").unwrap_or_default());
        let mut checks = Vec::new();
        for (item, path) in paths {
            checks.push(Check::new(item, Some(path), path_verdict(sys, &mounts, path)));
        }
        checks.push(Check::new("Swap", None, swap_verdict(sys, &mounts)));
        checks.push(Check::new(CRASH_DUMPS, None, crash_dump_verdict(supervisor, database_pids)));
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
            let zram = name.strip_prefix("/dev/").filter(|device| device.starts_with("zram") && !device.contains('/'));
            verdicts.push(if let Some(device) = zram {
                zram_verdict(sys, device)
            } else if swap.kind == "partition" {
                match device_number(sys, &swap.path) {
                    Some((major, minor)) => {
                        let mut verdict = block_device(sys, major, minor, 0);
                        verdict.evidence.insert(0, format!("swap partition {name}"));
                        verdict
                    }
                    None => Verdict::unknown(format!("swap partition {name} cannot be read")),
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

    /// Crash dumps of the supervisor, which holds every database password, and of the running
    /// database. The supervisor makes itself non-dumpable at start, and the `moss_nodump` add-on
    /// does the same for every server process, so the kernel makes no dump and calls no crash
    /// handler. A process without that is protected only by a zero core limit, and the kernel
    /// ignores that limit when it pipes a dump to a crash-handler program.
    ///
    /// `supervisor` is the pid holding the install lock, `None` when no supervisor runs.
    fn crash_dump_verdict(supervisor: Result<Option<i32>, String>, database_pids: &[i32]) -> Verdict {
        let pattern = std::fs::read_to_string("/proc/sys/kernel/core_pattern").unwrap_or_default();
        let supervisor = match supervisor {
            Ok(pid) => pid,
            Err(error) => return Verdict::unknown(format!("whether a supervisor is running could not be read: {error}")),
        };
        let procs: Vec<Proc> = supervisor
            .map(|pid| (SUPERVISOR, pid))
            .into_iter()
            .chain(database_pids.iter().map(|&pid| (DATABASE, pid)))
            .map(|(role, pid)| Proc { role, pid, state: dump_state(pid) })
            .collect();
        decide(&procs, pattern.trim())
    }

    const SUPERVISOR: &str = "supervisor";
    const DATABASE: &str = "database";

    /// A process whose memory holds private rows or passwords.
    #[derive(Debug)]
    struct Proc {
        role: &'static str,
        pid: i32,
        state: DumpState,
    }

    /// The crash-dump verdict from each process's dump state and the kernel's `core_pattern`.
    fn decide(procs: &[Proc], pattern: &str) -> Verdict {
        let destination = format!("the system sends crash dumps to: {pattern}");
        let database = procs.iter().filter(|p| p.role == DATABASE).count();
        if database == 0 {
            return Verdict {
                status: Status::Unknown,
                method: None,
                evidence: vec!["the database is not running, so its processes were not checked".into(), destination],
            };
        }
        let supervised = procs.iter().any(|p| p.role == SUPERVISOR);
        let checked = if supervised {
            format!("the supervisor and all {database} database processes")
        } else {
            format!("all {database} database processes")
        };
        let mut evidence = Vec::new();
        if !supervised {
            evidence.push("no supervisor is running for this install".to_string());
        }
        evidence.push(destination);

        if procs.iter().all(|p| p.state == DumpState::NonDumpable) {
            evidence.insert(
                0,
                format!(
                    "{checked} are non-dumpable (the kernel shows their files as owned by root), so no crash dump \
                     of them is made and no crash handler is called"
                ),
            );
            return Verdict { status: Status::Verified, method: Some("cannot be dumped".into()), evidence };
        }
        let limited = procs.iter().find_map(|p| match &p.state {
            DumpState::Limit(limit) => Some((p, limit)),
            _ => None,
        });
        if let Some((p, limit)) = limited {
            return Verdict::off(format!("{} process {} may write crash dumps (limit {limit})", p.role, p.pid));
        }
        if let Some(p) = procs.iter().find(|p| p.state == DumpState::Unreadable) {
            return Verdict::unknown(format!("the crash-dump state of {} process {} could not be read", p.role, p.pid));
        }
        if pattern.starts_with('|') {
            let p = procs.iter().find(|p| p.state == DumpState::ZeroLimit).expect("a process that is not non-dumpable");
            evidence.insert(
                0,
                format!(
                    "{} process {} is dumpable with a crash-dump size limit of 0, but the kernel ignores that limit \
                     when it hands a dump to a crash-handler program, and what the handler keeps depends on its own rules",
                    p.role, p.pid
                ),
            );
            return Verdict { status: Status::Unknown, method: None, evidence };
        }
        evidence.insert(
            0,
            format!("each of {checked} is non-dumpable or has a crash-dump size limit of 0, which stops dumps to a file"),
        );
        Verdict { status: Status::Verified, method: Some("crash-dump limit of 0".into()), evidence }
    }

    #[derive(Debug, PartialEq, Eq)]
    enum DumpState {
        NonDumpable,
        ZeroLimit,
        /// A non-zero crash-dump size limit.
        Limit(String),
        Unreadable,
    }

    /// The kernel shows a non-dumpable process's `/proc` files as owned by root. The only other
    /// cause is a setuid program, which neither Postgres nor `moss-db` is. A process run as root
    /// cannot be judged this way, so it falls back to the core limit.
    fn dump_state(pid: i32) -> DumpState {
        let dir = Path::new("/proc").join(pid.to_string());
        let status = dir.join("status");
        let (Ok(text), Ok(meta)) = (std::fs::read_to_string(&status), std::fs::metadata(&status)) else {
            return DumpState::Unreadable;
        };
        let limits = std::fs::read_to_string(dir.join("limits")).unwrap_or_default();
        classify(&text, meta.uid(), &limits)
    }

    /// A process's dump state from its `status` text, the owner the kernel shows for that
    /// file, and its `limits` text.
    fn classify(status: &str, status_owner: u32, limits: &str) -> DumpState {
        let real_uid = status
            .lines()
            .find_map(|line| line.strip_prefix("Uid:"))
            .and_then(|ids| ids.split_whitespace().next())
            .and_then(|id| id.parse::<u32>().ok());
        if real_uid.is_some_and(|uid| uid != 0) && status_owner == 0 {
            return DumpState::NonDumpable;
        }
        match core_limit(limits) {
            Some(limit) if limit == "0" => DumpState::ZeroLimit,
            Some(limit) => DumpState::Limit(limit),
            None => DumpState::Unreadable,
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        const PIPE: &str = "|/usr/share/apport/apport -p%p -s%s -c%c -d%d -P%P -u%u -g%g -F%F -- %E";
        const STATUS: &str = "Name:\tpostgres\nUmask:\t0077\nUid:\t1000\t1000\t1000\t1000\n";

        fn limits(soft: &str) -> String {
            format!(
                "Limit                     Soft Limit           Hard Limit           Units     \n\
                 Max core file size        {soft:<21}unlimited            bytes     \n"
            )
        }

        #[test]
        fn classify_reads_the_dump_state() {
            assert_eq!(classify(STATUS, 0, &limits("0")), DumpState::NonDumpable);
            assert_eq!(classify(STATUS, 1000, &limits("0")), DumpState::ZeroLimit);
            assert_eq!(classify(STATUS, 1000, &limits("unlimited")), DumpState::Limit("unlimited".into()));
            assert_eq!(classify(STATUS, 1000, ""), DumpState::Unreadable);

            // A database run as root shows root as owner either way, so only its limit counts.
            let root = STATUS.replace("1000", "0");
            assert_eq!(classify(&root, 0, &limits("unlimited")), DumpState::Limit("unlimited".into()));
        }

        fn db(pid: i32, state: DumpState) -> Proc {
            Proc { role: DATABASE, pid, state }
        }

        fn sup(state: DumpState) -> Proc {
            Proc { role: SUPERVISOR, pid: 9, state }
        }

        #[test]
        fn non_dumpable_everywhere_is_verified_even_with_a_crash_handler() {
            let procs = [sup(DumpState::NonDumpable), db(10, DumpState::NonDumpable), db(11, DumpState::NonDumpable)];
            let verdict = decide(&procs, PIPE);
            assert_eq!(verdict.status, Status::Verified);
            assert_eq!(verdict.method.as_deref(), Some("cannot be dumped"));
            assert!(verdict.evidence[0].starts_with("the supervisor and all 2 database processes are non-dumpable"));
        }

        #[test]
        fn a_dumpable_supervisor_spoils_a_protected_database() {
            let unlimited =
                [sup(DumpState::Limit("unlimited".into())), db(10, DumpState::NonDumpable), db(11, DumpState::NonDumpable)];
            let verdict = decide(&unlimited, PIPE);
            assert_eq!(verdict.status, Status::Off);
            assert_eq!(verdict.evidence[0], "supervisor process 9 may write crash dumps (limit unlimited)");

            // The kernel ignores a zero limit when it pipes the dump to a crash handler.
            let zero = [sup(DumpState::ZeroLimit), db(10, DumpState::NonDumpable), db(11, DumpState::NonDumpable)];
            let verdict = decide(&zero, PIPE);
            assert_eq!(verdict.status, Status::Unknown);
            assert!(verdict.evidence[0].starts_with("supervisor process 9 is dumpable"));
        }

        #[test]
        fn without_a_supervisor_only_the_database_is_judged() {
            let verdict = decide(&[db(10, DumpState::NonDumpable)], PIPE);
            assert_eq!(verdict.status, Status::Verified);
            assert!(verdict.evidence.iter().any(|line| line == "no supervisor is running for this install"));
        }

        #[test]
        fn an_unreadable_install_lock_is_unknown() {
            let verdict = crash_dump_verdict(Err("lock file: permission denied".into()), &[]);
            assert_eq!(verdict.status, Status::Unknown);
        }

        #[test]
        fn a_zero_limit_is_verified_only_when_dumps_go_to_a_file() {
            let procs = [sup(DumpState::NonDumpable), db(10, DumpState::NonDumpable), db(11, DumpState::ZeroLimit)];
            assert_eq!(decide(&procs, PIPE).status, Status::Unknown);
            let verdict = decide(&procs, "core");
            assert_eq!(verdict.status, Status::Verified);
            assert_eq!(verdict.method.as_deref(), Some("crash-dump limit of 0"));
        }

        #[test]
        fn a_dumpable_process_is_off_and_an_unreadable_one_unknown() {
            let off = decide(&[db(10, DumpState::NonDumpable), db(11, DumpState::Limit("unlimited".into()))], PIPE);
            assert_eq!(off.status, Status::Off);
            let unreadable = decide(&[db(10, DumpState::ZeroLimit), db(11, DumpState::Unreadable)], "core");
            assert_eq!(unreadable.status, Status::Unknown);

            // A dumpable process outranks an unreadable one.
            let both = decide(&[db(10, DumpState::Unreadable), db(11, DumpState::Limit("1024".into()))], "core");
            assert_eq!(both.status, Status::Off);
        }

        #[test]
        fn a_stopped_database_is_unknown() {
            assert_eq!(decide(&[], "core").status, Status::Unknown);
            // A supervisor still starting the database is not enough.
            assert_eq!(decide(&[sup(DumpState::NonDumpable)], "core").status, Status::Unknown);
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

/// macOS: FileVault per folder from `diskutil`, swap from `sysctl`, and both kinds of crash
/// file. Not compiled or run in this spike because the Mac has no Rust toolchain. The parsers
/// above are tested on Linux against output captured on the test Mac, and the facts the crash
/// checks read were confirmed there by hand.
#[cfg(target_os = "macos")]
pub mod macos {
    use super::*;
    use std::process::Command;

    pub fn report(paths: &[(String, PathBuf)]) -> Report {
        let mut checks: Vec<Check> =
            paths.iter().map(|(item, path)| Check::new(item, Some(path), folder_verdict(path))).collect();
        let swap = match sysctl("vm.swapusage") {
            Some(text) => parse_swapusage(&text),
            None => Verdict::unknown("sysctl vm.swapusage failed".into()),
        };
        checks.push(Check::new("Swap", None, swap));
        checks.push(Check::new("Core files", None, core_file_verdict()));
        let reports = std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Library/Logs/DiagnosticReports"));
        checks.push(Check::new("Crash reports", reports.as_deref(), crash_report_verdict(reports.as_deref())));
        Report::from_checks(checks)
    }

    /// FileVault state of the volume holding `path`, or of its nearest existing folder.
    fn folder_verdict(path: &Path) -> Verdict {
        let folder = path.ancestors().find(|p| p.exists()).unwrap_or(Path::new("/"));

        // diskutil accepts a mount point, not an arbitrary folder.
        let Some(volume) = mount_point(folder) else {
            return Verdict::unknown(format!("no volume found for {}", folder.display()));
        };
        match Command::new("/usr/sbin/diskutil").arg("info").arg("-plist").arg(&volume).output() {
            Ok(out) if out.status.success() => parse_diskutil_plist(&String::from_utf8_lossy(&out.stdout)),
            _ => Verdict::unknown(format!("diskutil could not describe {}", volume.display())),
        }
    }

    /// A core file needs `kern.coredump` on, a non-zero core limit and a core folder this user
    /// can write. The supervisor starts Postgres with a limit of 0, but macOS cannot read a
    /// running process's limit back, so the verdict rests on the two facts it can read. Core
    /// files that can be written must land on an encrypted volume.
    fn core_file_verdict() -> Verdict {
        match (sysctl("kern.coredump").as_deref(), sysctl("kern.corefile")) {
            (Some("0"), _) => {
                Verdict::verified("core files off", "core files are off for the whole system (kern.coredump=0)".into())
            }
            (Some(_), Some(pattern)) => {
                let folder = Path::new(&pattern).parent().unwrap_or(Path::new("/"));
                if !writable(folder) {
                    return Verdict::verified(
                        "core files cannot be written",
                        format!("core files go to {}, which this user cannot write", folder.display()),
                    );
                }
                let mut verdict = folder_verdict(folder);
                verdict.evidence.insert(0, format!("core files go to {}, which this user can write", folder.display()));
                verdict
            }
            _ => Verdict::unknown("sysctl did not say whether or where core files are written".into()),
        }
    }

    /// macOS writes a crash report for every crashed process. It holds call stacks and register
    /// values but no memory contents. Register values can carry a few bytes of whatever the
    /// process was handling, so the report folder must be on an encrypted volume.
    fn crash_report_verdict(folder: Option<&Path>) -> Verdict {
        let Some(folder) = folder else {
            return Verdict::unknown("no home folder, so the crash report folder is unknown".into());
        };
        let mut verdict = folder_verdict(folder);
        verdict.evidence.push("a crash report holds call stacks and register values, not memory contents".into());
        verdict
    }

    fn sysctl(name: &str) -> Option<String> {
        let out = Command::new("/usr/sbin/sysctl").arg("-n").arg(name).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    fn writable(folder: &Path) -> bool {
        use std::os::unix::ffi::OsStrExt;
        std::ffi::CString::new(folder.as_os_str().as_bytes())
            .is_ok_and(|path| unsafe { libc::access(path.as_ptr(), libc::W_OK) } == 0)
    }

    /// The mount point of the volume holding `path`, from `statfs`.
    fn mount_point(path: &Path) -> Option<PathBuf> {
        use std::ffi::{CStr, CString, OsStr};
        use std::os::unix::ffi::OsStrExt;
        let c_path = CString::new(path.as_os_str().as_bytes()).ok()?;
        let mut fs: libc::statfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statfs(c_path.as_ptr(), &mut fs) } != 0 {
            return None;
        }
        let name = unsafe { CStr::from_ptr(fs.f_mntonname.as_ptr()) };
        Some(PathBuf::from(OsStr::from_bytes(name.to_bytes())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    /// A fake sysfs. Each device is a folder under `devices/` holding its `dev` file, linked
    /// from `dev/block/<major:minor>` and `class/block/<name>` the way the kernel links them.
    struct Sys(tempfile::TempDir);

    impl Sys {
        fn new() -> Sys {
            let dir = tempfile::tempdir().unwrap();
            for sub in ["devices", "dev/block", "class/block"] {
                std::fs::create_dir_all(dir.path().join(sub)).unwrap();
            }
            Sys(dir)
        }

        fn root(&self) -> &Path {
            self.0.path()
        }

        fn device(&self, name: &str, major: u32, minor: u32) -> PathBuf {
            let dir = self.root().join("devices").join(name);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("dev"), format!("{major}:{minor}\n")).unwrap();
            symlink(&dir, self.root().join(format!("dev/block/{major}:{minor}"))).unwrap();
            symlink(&dir, self.root().join("class/block").join(name)).unwrap();
            dir
        }

        fn partition(&self, name: &str, major: u32, minor: u32) {
            let dir = self.device(name, major, minor);
            std::fs::write(dir.join("partition"), "3\n").unwrap();
        }

        /// A device-mapper device (major 253) stacked on `slaves`.
        fn mapped(&self, name: &str, minor: u32, uuid: &str, slaves: &[&str]) {
            let dir = self.device(name, 253, minor);
            std::fs::create_dir_all(dir.join("dm")).unwrap();
            std::fs::write(dir.join("dm/uuid"), format!("{uuid}\n")).unwrap();
            std::fs::write(dir.join("dm/name"), format!("{name}-mapped\n")).unwrap();
            self.slaves(&dir, slaves);
        }

        fn slaves(&self, dir: &Path, slaves: &[&str]) {
            std::fs::create_dir_all(dir.join("slaves")).unwrap();
            for slave in slaves {
                symlink(self.root().join("devices").join(slave), dir.join("slaves").join(slave)).unwrap();
            }
        }

        fn verdict(&self, major: u32, minor: u32) -> Verdict {
            block_device(self.root(), major, minor, 0)
        }

        /// LUKS2 on an NVMe partition, as `dm-0`.
        fn luks(&self) {
            self.partition("nvme0n1p3", 259, 3);
            self.mapped("dm-0", 0, "CRYPT-LUKS2-0123456789abcdef-luks-0123", &["nvme0n1p3"]);
        }
    }

    #[test]
    fn luks_is_verified() {
        let sys = Sys::new();
        sys.luks();
        let verdict = sys.verdict(253, 0);
        assert_eq!(verdict.status, Status::Verified);
        assert_eq!(verdict.method.as_deref(), Some("LUKS2 (dm-crypt)"));
    }

    #[test]
    fn lvm_on_luks_is_verified() {
        let sys = Sys::new();
        sys.luks();
        sys.mapped("dm-1", 1, "LVM-abcdef", &["dm-0"]);
        let verdict = sys.verdict(253, 1);
        assert_eq!(verdict.status, Status::Verified);
        assert_eq!(verdict.evidence[0], "dm-1 is an LVM volume on dm-0");
    }

    #[test]
    fn a_plain_partition_is_off() {
        let sys = Sys::new();
        sys.partition("sda2", 8, 2);
        let verdict = sys.verdict(8, 2);
        assert_eq!(verdict.status, Status::Off);
        assert!(verdict.evidence[0].starts_with("sda2 is a plain partition"));
    }

    #[test]
    fn lvm_on_a_plain_partition_is_off() {
        let sys = Sys::new();
        sys.partition("sda2", 8, 2);
        sys.mapped("dm-1", 1, "LVM-abcdef", &["sda2"]);
        assert_eq!(sys.verdict(253, 1).status, Status::Off);
    }

    #[test]
    fn raid_is_verified_only_when_every_member_is() {
        let sys = Sys::new();
        sys.luks();
        sys.partition("nvme1n1p3", 259, 7);
        sys.mapped("dm-2", 2, "CRYPT-LUKS2-fedcba9876543210-luks-4567", &["nvme1n1p3"]);
        sys.partition("sdb1", 8, 17);
        let both_encrypted = sys.device("md0", 9, 0);
        sys.slaves(&both_encrypted, &["dm-0", "dm-2"]);
        let one_plain = sys.device("md1", 9, 1);
        sys.slaves(&one_plain, &["dm-0", "sdb1"]);
        assert_eq!(sys.verdict(9, 0).status, Status::Verified);
        assert_eq!(sys.verdict(9, 1).status, Status::Off);
    }

    #[test]
    fn a_missing_layer_or_device_is_unknown() {
        let sys = Sys::new();
        sys.mapped("dm-1", 1, "LVM-abcdef", &["ghost"]);
        assert_eq!(sys.verdict(253, 1).status, Status::Unknown);
        assert_eq!(sys.verdict(8, 99).status, Status::Unknown);
    }

    #[test]
    fn a_loop_device_is_unknown() {
        let sys = Sys::new();
        let dir = sys.device("loop0", 7, 0);
        std::fs::create_dir_all(dir.join("loop")).unwrap();
        std::fs::write(dir.join("loop/backing_file"), "/home/someone/disk.img\n").unwrap();
        assert_eq!(sys.verdict(7, 0).status, Status::Unknown);
    }

    /// A zram device whose `backing_dev` reads `backing`, or has no such file when `None`.
    /// Backing devices are named so that no real `/dev` node matches them.
    fn zram(sys: &Sys, backing: Option<&str>) -> Verdict {
        let dir = sys.device("zram0", 252, 0);
        if let Some(backing) = backing {
            std::fs::write(dir.join("backing_dev"), format!("{backing}\n")).unwrap();
        }
        zram_verdict(sys.root(), "zram0")
    }

    #[test]
    fn zram_without_a_backing_device_is_verified() {
        let sys = Sys::new();
        let verdict = zram(&sys, Some("none"));
        assert_eq!(verdict.status, Status::Verified);
        assert_eq!(verdict.method.as_deref(), Some("zram"));
    }

    #[test]
    fn zram_is_judged_by_its_backing_device() {
        let sys = Sys::new();
        sys.partition("moss-test-sdz1", 8, 33);
        let plain = zram(&sys, Some("/dev/moss-test-sdz1"));
        assert_eq!(plain.status, Status::Off);
        assert_eq!(plain.evidence[0], "swap device /dev/zram0 is zram (compressed memory) and writes pages out to /dev/moss-test-sdz1");
        assert!(plain.evidence[1].starts_with("moss-test-sdz1 is a plain partition"));

        let sys = Sys::new();
        sys.partition("moss-test-nvme9p3", 259, 93);
        sys.mapped("moss-test-dm-9", 9, "CRYPT-LUKS2-0123456789abcdef-luks-0123", &["moss-test-nvme9p3"]);
        let luks = zram(&sys, Some("/dev/moss-test-dm-9"));
        assert_eq!(luks.status, Status::Verified);
        assert_eq!(luks.method.as_deref(), Some("LUKS2 (dm-crypt)"));
    }

    #[test]
    fn zram_with_an_unreadable_or_missing_backing_device_is_unknown() {
        assert_eq!(zram(&Sys::new(), None).status, Status::Unknown);
        assert_eq!(zram(&Sys::new(), Some("/dev/moss-test-gone")).status, Status::Unknown);
    }

    fn mount(point: &str, fs_type: &str, major: u32, minor: u32) -> Mount {
        Mount { major, minor, mount_point: PathBuf::from(point), fs_type: fs_type.into(), source: "/dev/x".into() }
    }

    #[test]
    fn filesystem_kinds() {
        let sys = Sys::new();
        assert_eq!(filesystem(sys.root(), &mount("/home/a", "ecryptfs", 0, 40), None).status, Status::Verified);
        let fuse = filesystem(sys.root(), &mount("/home/a/vault", "fuse.gocryptfs", 0, 41), None);
        assert_eq!((fuse.status, fuse.method.as_deref()), (Status::Verified, Some("gocryptfs")));
        for fs_type in ["nfs4", "tmpfs", "overlay", "zfs", "fuse.sshfs", "fuse.other"] {
            assert_eq!(filesystem(sys.root(), &mount("/x", fs_type, 0, 42), None).status, Status::Unknown, "{fs_type}");
        }
        assert_eq!(filesystem(sys.root(), &mount("/", "ext4", 8, 2), None).status, Status::Unknown);

        sys.partition("sda2", 8, 2);
        let ext4 = filesystem(sys.root(), &mount("/", "ext4", 8, 2), Some((8, 2)));
        assert_eq!(ext4.status, Status::Off);
        assert_eq!(ext4.evidence[0], "/ (ext4) is on block device 8:2");
    }

    #[test]
    fn mountinfo_lines() {
        let text = "22 1 8:2 / / rw,relatime shared:1 - ext4 /dev/sda2 rw,errors=remount-ro\n\
                    36 22 98:0 /mnt1 /mnt/parent rw,noatime master:1 shared:7 - ext3 /dev/root rw\n\
                    40 22 0:45 / /media/my\\040disk rw - vfat /dev/sdb1 rw\n\
                    not a mountinfo line\n\
                    41 22 x:y / /bad rw - ext4 /dev/sdc rw\n";
        let mounts = parse_mountinfo(text);
        assert_eq!(mounts.len(), 3);
        assert_eq!((mounts[0].major, mounts[0].minor, mounts[0].fs_type.as_str()), (8, 2, "ext4"));
        assert_eq!((mounts[1].mount_point.as_path(), mounts[1].fs_type.as_str()), (Path::new("/mnt/parent"), "ext3"));
        assert_eq!((mounts[2].mount_point.as_path(), mounts[2].source.as_str()), (Path::new("/media/my disk"), "/dev/sdb1"));
    }

    #[test]
    fn unescape_takes_one_byte_escapes_only() {
        assert_eq!(unescape("a\\040b\\011c\\134d"), "a b\tc\\d");
        assert_eq!(unescape("x\\777"), "x\\777");
        assert_eq!(unescape("cut\\04"), "cut\\04");
    }

    #[test]
    fn mount_for_takes_the_deepest_then_the_latest() {
        let mounts = vec![mount("/", "ext4", 8, 2), mount("/home", "ext4", 8, 3), mount("/home", "ecryptfs", 0, 50)];
        assert_eq!(mount_for(&mounts, Path::new("/home/someone/x")).unwrap().fs_type, "ecryptfs");
        assert_eq!(mount_for(&mounts, Path::new("/homework")).unwrap().mount_point, Path::new("/"));
        assert!(mount_for(&[], Path::new("/x")).is_none());
    }

    #[test]
    fn swaps_and_core_limits() {
        let swaps = "Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n\
                     /swapfile                               file\t\t2097148\t\t0\t\t-2\n\
                     /dev/dm-1                               partition\t8388604\t\t0\t\t-3\n";
        assert_eq!(
            parse_swaps(swaps),
            vec![
                Swap { path: "/swapfile".into(), kind: "file".into() },
                Swap { path: "/dev/dm-1".into(), kind: "partition".into() },
            ]
        );
        assert!(parse_swaps("Filename\tType\tSize\tUsed\tPriority\n").is_empty());

        let limits = "Limit                     Soft Limit           Hard Limit           Units     \n\
                      Max cpu time              unlimited            unlimited            seconds   \n\
                      Max core file size        0                    unlimited            bytes     \n";
        assert_eq!(core_limit(limits).as_deref(), Some("0"));
        assert_eq!(core_limit("Max core file size        unlimited            unlimited            bytes\n").as_deref(), Some("unlimited"));
        assert_eq!(core_limit("Limit  Soft Limit\n"), None);
    }

    #[test]
    fn split_dev_unpacks_glibc_device_numbers() {
        assert_eq!(split_dev(2242), (8, 194));
        assert_eq!(split_dev(66307), (259, 3));
        assert_eq!(split_dev(1113388), (253, 300));
    }

    /// `diskutil info -plist` lines as printed on the test Mac. Apple Silicon reports
    /// `Encryption` true even with FileVault off, so only the `FileVault` key counts.
    fn plist(filevault: &str) -> String {
        format!(
            "<plist version=\"1.0\">\n<dict>\n\t<key>Encryption</key>\n\t<true/>\n\
             \t<key>EncryptionThisVolumeProper</key>\n\t<true/>\n\t<key>FileVault</key>\n\t{filevault}\n\
             \t<key>VolumeName</key>\n\t<string>Data</string>\n</dict>\n</plist>\n"
        )
    }

    #[test]
    fn mac_command_output() {
        assert_eq!(parse_fdesetup("FileVault is On.\n").status, Status::Verified);
        assert_eq!(parse_fdesetup("FileVault is Off.\n").status, Status::Off);
        assert_eq!(parse_fdesetup("").status, Status::Unknown);

        let on = parse_diskutil_plist(&plist("<true/>"));
        assert_eq!((on.status, on.evidence[0].as_str()), (Status::Verified, "Data has FileVault on"));
        assert_eq!(parse_diskutil_plist(&plist("<false/>")).status, Status::Off);
        assert_eq!(parse_diskutil_plist(&plist("<string>odd</string>")).status, Status::Unknown);
        assert_eq!(parse_diskutil_plist("<plist><dict></dict></plist>").status, Status::Unknown);

        let swap = "total = 5120.00M  used = 4089.88M  free = 1030.12M  (encrypted)\n";
        assert_eq!(parse_swapusage(swap).status, Status::Verified);
        assert_eq!(parse_swapusage(&swap.replace("  (encrypted)", "")).status, Status::Unknown);
    }

    fn check(item: &str, status: Status) -> Check {
        Check { item: item.into(), path: None, status, method: None, evidence: Vec::new() }
    }

    #[test]
    fn protection_is_claimed_only_when_every_check_is_verified() {
        let verified = Report::from_checks(vec![check("Data", Status::Verified), check("Swap", Status::Verified)]);
        assert_eq!((verified.status, verified.claim_protection), (Status::Verified, true));

        let unknown = Report::from_checks(vec![check("Data", Status::Verified), check("Swap", Status::Unknown)]);
        assert_eq!((unknown.status, unknown.claim_protection), (Status::Unknown, false));
        assert!(unknown.message.contains("for: Swap."));

        let off = Report::from_checks(vec![check("Data", Status::Off), check("Swap", Status::Unknown)]);
        assert_eq!((off.status, off.claim_protection), (Status::Off, false));
        assert!(off.message.contains("off for: Data."));

        assert!(!Report::from_checks(Vec::new()).claim_protection);
    }

    #[test]
    fn crash_dumps_are_not_called_a_disk() {
        let dumps_off = Report::from_checks(vec![check("Data", Status::Verified), check(CRASH_DUMPS, Status::Off)]);
        assert_eq!(dumps_off.status, Status::Off);
        assert!(!dumps_off.message.contains("Disk encryption is off"), "{}", dumps_off.message);
        assert!(dumps_off.message.starts_with("A crash can save Moss memory"), "{}", dumps_off.message);

        let both_off = Report::from_checks(vec![check("Data", Status::Off), check(CRASH_DUMPS, Status::Off)]);
        assert!(both_off.message.starts_with("Disk encryption is off for: Data. "), "{}", both_off.message);
        assert!(both_off.message.contains("A crash can save Moss memory"), "{}", both_off.message);

        let dumps_unknown = Report::from_checks(vec![check("Data", Status::Verified), check(CRASH_DUMPS, Status::Unknown)]);
        assert!(!dumps_unknown.message.contains("disk encryption for"), "{}", dumps_unknown.message);
        assert!(dumps_unknown.message.starts_with("Moss could not check whether a crash"), "{}", dumps_unknown.message);
    }
}
