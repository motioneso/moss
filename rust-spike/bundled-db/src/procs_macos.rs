//! Darwin preserves argv boundaries in KERN_PROCARGS2, unlike the display text from ps.

#[cfg(target_os = "macos")]
pub(super) fn command_line(pid: i32) -> Option<Vec<String>> {
    let mut mib = [libc::CTL_KERN, libc::KERN_ARGMAX];
    let mut maximum: libc::c_int = 0;
    let mut size = std::mem::size_of_val(&maximum);
    if unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            mib.len() as _,
            (&mut maximum as *mut libc::c_int).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } != 0
        || !(1..=16 * 1024 * 1024).contains(&maximum)
    {
        return None;
    }
    let mut raw = vec![0; maximum as usize];
    size = raw.len();
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    if unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            mib.len() as _,
            raw.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } != 0
    {
        return None;
    }
    decode(raw.get(..size)?)
}

fn decode(raw: &[u8]) -> Option<Vec<String>> {
    let count_size = std::mem::size_of::<i32>();
    let count = i32::from_ne_bytes(raw.get(..count_size)?.try_into().ok()?);
    if count <= 0 || count as usize > raw.len() {
        return None;
    }
    // argc, executable path, NUL padding, argv[0..argc], then environment strings.
    let rest = raw.get(count_size..)?;
    let end = rest.iter().position(|byte| *byte == 0)?;
    let mut rest = &rest[end + 1..];
    while rest.first() == Some(&0) {
        rest = &rest[1..];
    }
    let mut args = Vec::new();
    for _ in 0..count {
        let end = rest.iter().position(|byte| *byte == 0)?;
        args.push(String::from_utf8_lossy(&rest[..end]).into_owned());
        rest = &rest[end + 1..];
    }
    Some(args)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kernel_arguments_keep_program_and_instance_spaces_without_environment() {
        let args = [
            "/Applications/Moss Test/versions/7.1.0/moss-db",
            "up",
            "--root",
            "/Users/test/Moss data/database",
        ];
        let mut raw = (args.len() as i32).to_ne_bytes().to_vec();
        raw.extend_from_slice(args[0].as_bytes());
        raw.extend_from_slice(&[0, 0, 0]);
        for arg in args {
            raw.extend_from_slice(arg.as_bytes());
            raw.push(0);
        }
        raw.extend_from_slice(b"IGNORED=environment\0");
        let decoded = decode(&raw).unwrap();
        assert_eq!(decoded, args);
        assert!(super::super::supervisor_args(&decoded));
        assert!(decode(&raw[..10]).is_none());
        raw[..4].copy_from_slice(&i32::MAX.to_ne_bytes());
        assert!(decode(&raw).is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn actual_kernel_arguments_match_this_process() {
        assert_eq!(
            command_line(std::process::id() as i32).unwrap(),
            std::env::args().collect::<Vec<_>>()
        );
    }
}
