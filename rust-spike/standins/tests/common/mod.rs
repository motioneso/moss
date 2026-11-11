#![allow(dead_code)]
//! A bare line-protocol client for the contract tests.

use moss_standins::mail::Io;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, ReadHalf, WriteHalf};
use tokio_rustls::{
    rustls::{pki_types::ServerName, ClientConfig},
    TlsConnector,
};

pub struct Client {
    r: BufReader<ReadHalf<Box<dyn Io>>>,
    w: WriteHalf<Box<dyn Io>>,
}

pub async fn connect_plain(addr: SocketAddr) -> Client {
    let tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
    wrap(Box::new(tcp))
}

pub async fn connect_tls(addr: SocketAddr, cfg: Arc<ClientConfig>, host: &'static str) -> std::io::Result<Client> {
    let tcp = tokio::net::TcpStream::connect(addr).await?;
    let tls = TlsConnector::from(cfg).connect(ServerName::try_from(host).unwrap(), tcp).await?;
    Ok(wrap(Box::new(tls)))
}

fn wrap(io: Box<dyn Io>) -> Client {
    let (r, w) = tokio::io::split(io);
    Client { r: BufReader::new(r), w }
}

impl Client {
    pub async fn line(&mut self) -> String {
        let mut l = String::new();
        let n = tokio::time::timeout(std::time::Duration::from_secs(5), self.r.read_line(&mut l)).await.expect("server answered in time").unwrap();
        assert!(n > 0, "server closed the connection");
        l.trim_end_matches(['\r', '\n']).to_string()
    }

    pub async fn send(&mut self, s: &str) {
        self.w.write_all(format!("{s}\r\n").as_bytes()).await.unwrap();
    }

    /// Sends a tagged IMAP command and returns every reply line up to and including the tagged one.
    /// Literals are folded into the line that announced them.
    pub async fn imap(&mut self, tag: &str, cmd: &str) -> Vec<String> {
        self.send(&format!("{tag} {cmd}")).await;
        let mut out = vec![];
        loop {
            let mut l = self.line().await;
            if let Some(n) = literal_len(&l) {
                let mut buf = vec![0u8; n];
                self.r.read_exact(&mut buf).await.unwrap();
                l += &format!("\n{}", String::from_utf8_lossy(&buf).replace("\r\n", "\n"));
                // The rest of the line after the literal.
                l += &self.line().await;
            }
            let done = l.starts_with(&format!("{tag} "));
            out.push(l);
            if done {
                return out;
            }
        }
    }

    /// Reads SMTP reply lines until the final one ("250 ..." rather than "250-...").
    pub async fn smtp(&mut self, cmd: &str) -> Vec<String> {
        self.send(cmd).await;
        self.smtp_reply().await
    }

    pub async fn smtp_reply(&mut self) -> Vec<String> {
        let mut out = vec![];
        loop {
            let l = self.line().await;
            let last = l.len() < 4 || l.as_bytes()[3] == b' ';
            out.push(l);
            if last {
                return out;
            }
        }
    }
}

fn literal_len(l: &str) -> Option<usize> {
    let inner = l.strip_suffix('}')?.rsplit_once('{')?.1;
    inner.parse().ok()
}
