//! One fake mail server: an IMAP listener and an SMTP listener sharing one mailbox.

use crate::{imap, smtp, tls};
use std::{
    collections::BTreeSet,
    net::SocketAddr,
    sync::{Arc, Mutex},
};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::TcpListener,
};
use tokio_rustls::TlsAcceptor;

pub struct MailConfig {
    pub username: String,
    pub password: String,
    /// `None` serves plain TCP. `Some` serves implicit TLS (the 993 and 465 style) with this identity.
    pub tls: Option<&'static tls::Identity>,
}

impl Default for MailConfig {
    fn default() -> Self {
        Self { username: "bob@example.com".into(), password: "correct-horse-battery".into(), tls: None }
    }
}

#[derive(Clone)]
pub struct Message {
    pub uid: u32,
    pub flags: BTreeSet<String>,
    pub body: Vec<u8>,
    pub internal_date: String,
    /// Raised on every change to flags, like IMAP CONDSTORE.
    pub modseq: u64,
}

pub struct Folder {
    pub name: String,
    pub attributes: &'static str,
    pub uid_validity: u32,
    pub next_uid: u32,
    pub messages: Vec<Message>,
}

#[derive(Clone, Debug)]
pub struct SentMail {
    pub from: String,
    pub recipients: Vec<String>,
    /// The message exactly as received, with dot-stuffing removed.
    pub data: String,
}

pub struct State {
    pub username: String,
    pub password: String,
    pub folders: Vec<Folder>,
    pub modseq: u64,
    pub sent: Vec<SentMail>,
    /// Makes IMAP LOGIN answer with the connection-limit refusal.
    pub throttle_imap_login: bool,
    /// Makes SMTP MAIL FROM answer with the daily-limit refusal.
    pub smtp_quota_exceeded: bool,
    pub imap_logins_seen: u32,
    pub smtp_auth_seen: u32,
}

pub struct MailStandIn {
    pub imap_addr: SocketAddr,
    pub smtp_addr: SocketAddr,
    state: Arc<Mutex<State>>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl Drop for MailStandIn {
    fn drop(&mut self) {
        for t in &self.tasks {
            t.abort();
        }
    }
}

pub(crate) type Shared = Arc<Mutex<State>>;

pub trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

impl MailStandIn {
    pub async fn start(config: MailConfig) -> Self {
        let folder = |name: &str, attributes: &'static str| Folder {
            name: name.into(),
            attributes,
            uid_validity: 1_700_000_001,
            next_uid: 1,
            messages: vec![],
        };
        let state: Shared = Arc::new(Mutex::new(State {
            username: config.username,
            password: config.password,
            folders: vec![
                folder("INBOX", "\\HasNoChildren"),
                folder("Drafts", "\\HasNoChildren \\Drafts"),
                folder("Sent", "\\HasNoChildren \\Sent"),
                folder("Trash", "\\HasNoChildren \\Trash"),
            ],
            modseq: 1,
            sent: vec![],
            throttle_imap_login: false,
            smtp_quota_exceeded: false,
            imap_logins_seen: 0,
            smtp_auth_seen: 0,
        }));
        let acceptor = config.tls.map(|id| TlsAcceptor::from(tls::server_config(id)));
        let imap_l = TcpListener::bind("127.0.0.1:0").await.expect("bind imap");
        let smtp_l = TcpListener::bind("127.0.0.1:0").await.expect("bind smtp");
        let (imap_addr, smtp_addr) = (imap_l.local_addr().unwrap(), smtp_l.local_addr().unwrap());
        let tasks = vec![
            spawn_listener(imap_l, acceptor.clone(), state.clone(), |io, st| Box::pin(imap::serve(io, st))),
            spawn_listener(smtp_l, acceptor, state.clone(), |io, st| Box::pin(smtp::serve(io, st))),
        ];
        Self { imap_addr, smtp_addr, state, tasks }
    }

    fn with<R>(&self, f: impl FnOnce(&mut State) -> R) -> R {
        f(&mut self.state.lock().unwrap())
    }

    /// Adds a message to a folder and returns its UID.
    pub fn add_message(&self, folder: &str, raw: &str) -> u32 {
        self.with(|s| {
            let f = s.folders.iter_mut().find(|f| f.name == folder).expect("folder exists");
            let uid = f.next_uid;
            f.next_uid += 1;
            s.modseq += 1;
            let modseq = s.modseq;
            f.messages.push(Message {
                uid,
                flags: BTreeSet::new(),
                body: raw.as_bytes().to_vec(),
                internal_date: "02-Mar-2026 09:15:00 +0000".into(),
                modseq,
            });
            uid
        })
    }

    /// Like `add_message`, with an IMAP internal date such as "02-Mar-2026 09:15:00 +0000".
    pub fn add_message_dated(&self, folder: &str, raw: &str, internal_date: &str) -> u32 {
        let uid = self.add_message(folder, raw);
        self.with(|s| {
            let f = s.folders.iter_mut().find(|f| f.name == folder).expect("folder exists");
            f.messages.iter_mut().find(|m| m.uid == uid).expect("message exists").internal_date =
                internal_date.into();
        });
        uid
    }

    /// The raw text and flags of every message in a folder, oldest first.
    pub fn folder_messages(&self, folder: &str) -> Vec<(String, Vec<String>)> {
        self.with(|s| {
            s.folders
                .iter()
                .find(|f| f.name == folder)
                .map(|f| {
                    f.messages
                        .iter()
                        .map(|m| (String::from_utf8_lossy(&m.body).into_owned(), m.flags.iter().cloned().collect()))
                        .collect()
                })
                .unwrap_or_default()
        })
    }

    /// Changes a message's content in place, keeping its UID, as a server-side edit would.
    pub fn replace_body(&self, folder: &str, uid: u32, raw: &str) {
        self.with(|s| {
            let f = s.folders.iter_mut().find(|f| f.name == folder).expect("folder exists");
            f.messages.iter_mut().find(|m| m.uid == uid).expect("message exists").body =
                raw.as_bytes().to_vec();
        })
    }

    /// Replaces a message's flags, which counts as a change.
    pub fn set_flags(&self, folder: &str, uid: u32, flags: &[&str]) {
        self.with(|s| {
            s.modseq += 1;
            let modseq = s.modseq;
            let f = s.folders.iter_mut().find(|f| f.name == folder).expect("folder exists");
            let m = f.messages.iter_mut().find(|m| m.uid == uid).expect("message exists");
            m.flags = flags.iter().map(|x| x.to_string()).collect();
            m.modseq = modseq;
        })
    }

    /// Removes a message, as another client expunging it would.
    pub fn delete_message(&self, folder: &str, uid: u32) {
        self.with(|s| {
            s.modseq += 1;
            let f = s.folders.iter_mut().find(|f| f.name == folder).expect("folder exists");
            f.messages.retain(|m| m.uid != uid);
        })
    }

    /// Makes clients drop their cache of the folder, as a server rebuild would.
    pub fn bump_uid_validity(&self, folder: &str) {
        self.with(|s| {
            let f = s.folders.iter_mut().find(|f| f.name == folder).expect("folder exists");
            f.uid_validity += 1;
        })
    }

    pub fn throttle_imap_login(&self, on: bool) {
        self.with(|s| s.throttle_imap_login = on)
    }

    pub fn smtp_quota_exceeded(&self, on: bool) {
        self.with(|s| s.smtp_quota_exceeded = on)
    }

    pub fn sent(&self) -> Vec<SentMail> {
        self.with(|s| s.sent.clone())
    }

    pub fn imap_logins_seen(&self) -> u32 {
        self.with(|s| s.imap_logins_seen)
    }

    pub fn smtp_auth_seen(&self) -> u32 {
        self.with(|s| s.smtp_auth_seen)
    }
}

type Handler = fn(Box<dyn Io>, Shared) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>;

fn spawn_listener(
    listener: TcpListener,
    acceptor: Option<TlsAcceptor>,
    state: Shared,
    handler: Handler,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            let Ok((tcp, _)) = listener.accept().await else { return };
            let (acceptor, state) = (acceptor.clone(), state.clone());
            tokio::spawn(async move {
                let io: Box<dyn Io> = match acceptor {
                    // A failed handshake drops the connection, like a real server does.
                    Some(a) => match a.accept(tcp).await {
                        Ok(t) => Box::new(t),
                        Err(_) => return,
                    },
                    None => Box::new(tcp),
                };
                handler(io, state).await;
            });
        }
    })
}
