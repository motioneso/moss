//! A small hand-written IMAP4rev1 line protocol (with the CONDSTORE and UIDPLUS bits sync needs).
//!
//! Supported: CAPABILITY, NOOP, LOGIN, LIST, SELECT, EXAMINE, UID SEARCH, UID FETCH (with
//! CHANGEDSINCE), UID STORE, UID EXPUNGE, EXPUNGE, CLOSE, CREATE, APPEND, LOGOUT. Everything else answers BAD.
//! Wording follows Dovecot, whose replies most self-hosted servers copy.

use crate::mail::{Folder, Io, Message, Shared};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

pub(crate) async fn serve(io: Box<dyn Io>, state: Shared) {
    let (r, mut w) = tokio::io::split(io);
    let mut r = BufReader::new(r);
    let _ = w.write_all(b"* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN CONDSTORE UIDPLUS] Moss stand-in ready.\r\n").await;
    let mut authed = false;
    let mut selected: Option<String> = None;
    let mut line = String::new();
    loop {
        line.clear();
        if !matches!(r.read_line(&mut line).await, Ok(n) if n > 0) {
            return;
        }
        let text = line.trim_end_matches(['\r', '\n']);
        let mut parts = text.splitn(2, ' ');
        let tag = parts.next().unwrap_or("*").to_string();
        let rest = parts.next().unwrap_or("").to_string();
        let (cmd, args) = match rest.split_once(' ') {
            Some((c, a)) => (c.to_ascii_uppercase(), a.to_string()),
            None => (rest.to_ascii_uppercase(), String::new()),
        };
        let mut out = String::new();
        let mut bytes: Vec<u8> = Vec::new();
        let mut done = false;
        match cmd.as_str() {
            "CAPABILITY" => {
                out += "* CAPABILITY IMAP4rev1 AUTH=PLAIN CONDSTORE UIDPLUS\r\n";
                out += &format!("{tag} OK Pre-login capabilities listed, post-login capabilities have more.\r\n");
            }
            "NOOP" => out += &format!("{tag} OK NOOP completed.\r\n"),
            "LOGOUT" => {
                out += "* BYE Logging out\r\n";
                out += &format!("{tag} OK Logout completed.\r\n");
                done = true;
            }
            "LOGIN" => {
                let words = words(&args);
                let (user, pass) = (words.first().cloned().unwrap_or_default(), words.get(1).cloned().unwrap_or_default());
                let mut s = state.lock().unwrap();
                s.imap_logins_seen += 1;
                if s.throttle_imap_login {
                    out += &format!("{tag} NO [ALERT] Too many simultaneous connections. (Failure)\r\n");
                } else if user == s.username && pass == s.password {
                    authed = true;
                    out += &format!("{tag} OK [CAPABILITY IMAP4rev1 CONDSTORE UIDPLUS] Logged in\r\n");
                } else {
                    out += &format!("{tag} NO [AUTHENTICATIONFAILED] Authentication failed.\r\n");
                }
            }
            _ if !authed => out += &format!("{tag} BAD Command received in Invalid state.\r\n"),
            "LIST" => {
                let s = state.lock().unwrap();
                for f in &s.folders {
                    out += &format!("* LIST ({}) \"/\" \"{}\"\r\n", f.attributes, f.name);
                }
                out += &format!("{tag} OK List completed.\r\n");
            }
            "SELECT" | "EXAMINE" => {
                let name = words(&args).first().cloned().unwrap_or_default();
                let s = state.lock().unwrap();
                match s.folders.iter().find(|f| f.name == name) {
                    None => out += &format!("{tag} NO [NONEXISTENT] Mailbox doesn't exist: {name}\r\n"),
                    Some(f) => {
                        selected = Some(name);
                        out += &format!("* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n");
                        out += "* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)] Flags permitted.\r\n";
                        out += &format!("* {} EXISTS\r\n* 0 RECENT\r\n", f.messages.len());
                        out += &format!("* OK [UIDVALIDITY {}] UIDs valid\r\n", f.uid_validity);
                        out += &format!("* OK [UIDNEXT {}] Predicted next UID\r\n", f.next_uid);
                        let highest = f.messages.iter().map(|m| m.modseq).max().unwrap_or(1);
                        out += &format!("* OK [HIGHESTMODSEQ {highest}] Highest\r\n");
                        let mode = if cmd == "SELECT" { "READ-WRITE" } else { "READ-ONLY" };
                        out += &format!("{tag} OK [{mode}] {} completed\r\n", cmd.to_ascii_lowercase());
                    }
                }
            }
            "CREATE" => {
                let name = words(&args).first().cloned().unwrap_or_default();
                let mut s = state.lock().unwrap();
                if s.folders.iter().any(|f| f.name == name) {
                    out += &format!("{tag} NO [ALREADYEXISTS] Mailbox already exists\r\n");
                } else {
                    s.folders.push(Folder {
                        name,
                        attributes: "\\HasNoChildren",
                        uid_validity: 1_700_000_100,
                        next_uid: 1,
                        messages: vec![],
                    });
                    out += &format!("{tag} OK Create completed.\r\n");
                }
            }
            "APPEND" => {
                // `APPEND mailbox [(flags)] {size}` then the message after a continuation.
                let size = args
                    .rsplit_once('{')
                    .and_then(|(_, n)| n.trim_end_matches('}').trim_end_matches('+').parse::<usize>().ok());
                let (Some(size), Some(name)) = (size, words(&args).first().cloned()) else {
                    out += &format!("{tag} BAD Error in IMAP command received by server.\r\n");
                    if w.write_all(out.as_bytes()).await.is_err() {
                        return;
                    }
                    continue;
                };
                let exists = state.lock().unwrap().folders.iter().any(|f| f.name == name);
                if !exists {
                    out += &format!("{tag} NO [TRYCREATE] Mailbox doesn't exist: {name}\r\n");
                    if w.write_all(out.as_bytes()).await.is_err() {
                        return;
                    }
                    continue;
                }
                if !args.ends_with("+}") {
                    let _ = w.write_all(b"+ OK\r\n").await;
                }
                let mut body = vec![0u8; size];
                if r.read_exact(&mut body).await.is_err() {
                    return;
                }
                let mut tail = String::new();
                let _ = r.read_line(&mut tail).await;
                let flags: Vec<String> = args
                    .split_once('(')
                    .and_then(|(_, rest)| rest.split_once(')'))
                    .map(|(f, _)| f.split_whitespace().map(String::from).collect())
                    .unwrap_or_default();
                let mut s = state.lock().unwrap();
                s.modseq += 1;
                let modseq = s.modseq;
                let f = folder_mut(&mut s.folders, &name);
                let uid = f.next_uid;
                f.next_uid += 1;
                f.messages.push(Message {
                    uid,
                    flags: flags.into_iter().collect(),
                    body,
                    internal_date: "02-Mar-2026 09:15:00 +0000".into(),
                    modseq,
                });
                out += &format!("{tag} OK [APPENDUID {} {uid}] Append completed.\r\n", f.uid_validity);
            }
            "CLOSE" => {
                selected = None;
                out += &format!("{tag} OK Close completed.\r\n");
            }
            "EXPUNGE" | "UID" if selected.is_none() => out += &format!("{tag} BAD Command received in Invalid state.\r\n"),
            "EXPUNGE" => {
                let mut s = state.lock().unwrap();
                let f = folder_mut(&mut s.folders, selected.as_deref().unwrap());
                expunge(f, &mut out, None);
                out += &format!("{tag} OK Expunge completed.\r\n");
            }
            "UID" => {
                let (sub, sub_args) = args.split_once(' ').unwrap_or((args.as_str(), ""));
                match sub.to_ascii_uppercase().as_str() {
                    "SEARCH" => {
                        let s = state.lock().unwrap();
                        let f = s.folders.iter().find(|f| Some(&f.name) == selected.as_ref()).unwrap();
                        out += &search(f, sub_args);
                        out += &format!("{tag} OK Search completed.\r\n");
                    }
                    "FETCH" => {
                        let s = state.lock().unwrap();
                        let f = s.folders.iter().find(|f| Some(&f.name) == selected.as_ref()).unwrap();
                        fetch(f, sub_args, &mut bytes);
                        bytes.extend_from_slice(format!("{tag} OK Fetch completed.\r\n").as_bytes());
                    }
                    "STORE" => {
                        let mut s = state.lock().unwrap();
                        let (modseq, fname) = (s.modseq + 1, selected.clone().unwrap());
                        s.modseq = modseq;
                        let f = folder_mut(&mut s.folders, &fname);
                        store(f, sub_args, modseq, &mut out);
                        out += &format!("{tag} OK Store completed.\r\n");
                    }
                    "EXPUNGE" => {
                        let mut s = state.lock().unwrap();
                        let f = folder_mut(&mut s.folders, selected.as_deref().unwrap());
                        expunge(f, &mut out, Some(sub_args.trim()));
                        out += &format!("{tag} OK Expunge completed.\r\n");
                    }
                    _ => out += &format!("{tag} BAD Error in IMAP command received by server.\r\n"),
                }
            }
            _ => out += &format!("{tag} BAD Error in IMAP command received by server.\r\n"),
        }
        if w.write_all(out.as_bytes()).await.is_err() || w.write_all(&bytes).await.is_err() || done {
            return;
        }
    }
}

fn folder_mut<'a>(folders: &'a mut [Folder], name: &str) -> &'a mut Folder {
    folders.iter_mut().find(|f| f.name == name).unwrap()
}

/// Splits on spaces, keeping quoted strings whole.
fn words(s: &str) -> Vec<String> {
    let (mut out, mut cur, mut quoted) = (vec![], String::new(), false);
    for c in s.chars() {
        match c {
            '"' => quoted = !quoted,
            ' ' if !quoted => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            _ => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn uid_in_set(set: &str, uid: u32, max_uid: u32) -> bool {
    set.split(',').any(|part| {
        let bound = |x: &str| if x == "*" { max_uid } else { x.parse().unwrap_or(0) };
        match part.split_once(':') {
            Some((a, b)) => {
                let (a, b) = (bound(a), bound(b));
                (a.min(b)..=a.max(b)).contains(&uid)
            }
            None => bound(part) == uid,
        }
    })
}

fn max_uid(f: &Folder) -> u32 {
    f.messages.iter().map(|m| m.uid).max().unwrap_or(0)
}

fn search(f: &Folder, criteria: &str) -> String {
    let c = criteria.to_ascii_uppercase();
    let max = max_uid(f);
    let hits: Vec<String> = f
        .messages
        .iter()
        .filter(|m| {
            if c.trim() == "ALL" {
                true
            } else if c.trim() == "UNSEEN" {
                !m.flags.contains("\\Seen")
            } else if let Some(day) = c.strip_prefix("SINCE ") {
                match (day_key(day.trim()), day_key(&m.internal_date.to_ascii_uppercase())) {
                    (Some(since), Some(sent)) => sent >= since,
                    _ => false,
                }
            } else if let Some(set) = c.strip_prefix("UID ") {
                uid_in_set(set.trim(), m.uid, max)
            } else {
                false
            }
        })
        .map(|m| m.uid.to_string())
        .collect();
    if hits.is_empty() { "* SEARCH\r\n".into() } else { format!("* SEARCH {}\r\n", hits.join(" ")) }
}

/// Sortable (year, month, day) from "D-Mon-YYYY ..." text, upper case.
fn day_key(text: &str) -> Option<(u32, usize, u32)> {
    let mut parts = text.split(' ').next()?.split('-');
    let day = parts.next()?.parse().ok()?;
    let name = parts.next()?;
    let month = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]
        .iter()
        .position(|m| *m == name)?;
    Some((parts.next()?.parse().ok()?, month, day))
}

fn flag_list(m: &Message) -> String {
    m.flags.iter().cloned().collect::<Vec<_>>().join(" ")
}

fn fetch(f: &Folder, args: &str, out: &mut Vec<u8>) {
    let (set, items) = args.split_once(' ').unwrap_or((args, "FLAGS"));
    let upper = items.to_ascii_uppercase();
    let changed_since: Option<u64> = upper.split("CHANGEDSINCE ").nth(1).and_then(|r| {
        r.trim_end_matches(')').split_whitespace().next().and_then(|n| n.parse().ok())
    });
    let max = max_uid(f);
    for (i, m) in f.messages.iter().enumerate() {
        if !uid_in_set(set, m.uid, max) || changed_since.is_some_and(|c| m.modseq <= c) {
            continue;
        }
        let mut head = format!("* {} FETCH (UID {}", i + 1, m.uid);
        if upper.contains("FLAGS") || changed_since.is_some() {
            head += &format!(" FLAGS ({})", flag_list(m));
        }
        if upper.contains("MODSEQ") || changed_since.is_some() {
            head += &format!(" MODSEQ ({})", m.modseq);
        }
        if upper.contains("RFC822.SIZE") {
            head += &format!(" RFC822.SIZE {}", m.body.len());
        }
        if upper.contains("INTERNALDATE") {
            head += &format!(" INTERNALDATE \"{}\"", m.internal_date);
        }
        let section = if upper.contains("BODY.PEEK[HEADER]") || upper.contains("BODY[HEADER]") {
            Some(("BODY[HEADER]", header_of(&m.body)))
        } else if upper.contains("BODY.PEEK[]") || upper.contains("BODY[]") {
            // A partial fetch, `<0.N>`, returns at most N bytes from the start.
            let limit = upper.split("<0.").nth(1).and_then(|r| r.split('>').next()?.parse().ok());
            match limit {
                Some(n) => Some(("BODY[]<0>", m.body[..m.body.len().min(n)].to_vec())),
                None => Some(("BODY[]", m.body.clone())),
            }
        } else if upper.contains("RFC822") && !upper.contains("RFC822.SIZE") {
            Some(("RFC822", m.body.clone()))
        } else {
            None
        };
        match section {
            Some((name, data)) => {
                out.extend_from_slice(format!("{head} {name} {{{}}}\r\n", data.len()).as_bytes());
                out.extend_from_slice(&data);
                out.extend_from_slice(b")\r\n");
            }
            None => out.extend_from_slice(format!("{head})\r\n").as_bytes()),
        }
    }
}

/// Header block including the blank line, as BODY[HEADER] returns it.
fn header_of(body: &[u8]) -> Vec<u8> {
    match body.windows(4).position(|w| w == b"\r\n\r\n") {
        Some(p) => body[..p + 4].to_vec(),
        None => body.to_vec(),
    }
}

fn store(f: &mut Folder, args: &str, modseq: u64, out: &mut String) {
    // "<set> +FLAGS (\Seen)" or "<set> FLAGS (...)" or "<set> -FLAGS (...)"
    let mut it = args.splitn(3, ' ');
    let (set, mode, list) = (it.next().unwrap_or(""), it.next().unwrap_or("").to_ascii_uppercase(), it.next().unwrap_or(""));
    let flags: Vec<String> = list.trim_matches(['(', ')']).split_whitespace().map(String::from).collect();
    let max = max_uid(f);
    for (i, m) in f.messages.iter_mut().enumerate() {
        if !uid_in_set(set, m.uid, max) {
            continue;
        }
        if mode.starts_with('+') {
            m.flags.extend(flags.iter().cloned());
        } else if mode.starts_with('-') {
            for x in &flags {
                m.flags.remove(x);
            }
        } else {
            m.flags = flags.iter().cloned().collect();
        }
        m.modseq = modseq;
        *out += &format!("* {} FETCH (UID {} FLAGS ({}) MODSEQ ({}))\r\n", i + 1, m.uid, flag_list(m), modseq);
    }
}

fn expunge(f: &mut Folder, out: &mut String, only: Option<&str>) {
    let max = max_uid(f);
    let mut seq = 1;
    f.messages.retain(|m| {
        let kill = m.flags.contains("\\Deleted") && only.is_none_or(|s| uid_in_set(s, m.uid, max));
        if kill {
            *out += &format!("* {seq} EXPUNGE\r\n");
        } else {
            seq += 1;
        }
        !kill
    });
}
