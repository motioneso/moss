//! The key setup and recovery screens, served on 127.0.0.1 for a browser. A test harness for
//! the spike, not a design proposal.
//!
//!   keystore-ui --port 5180
//!
//! Key locations come from XDG_CONFIG_HOME and XDG_DATA_HOME. Nothing is written until the
//! owner has shown they wrote the recovery words down.

use std::collections::HashMap;
use std::io::Read;

use keystore::probe::{probe, Keychain};
use keystore::recovery::{full_word, parse_words, split_pasted, RecoveryKey, WordsError, WORD_COUNT};
use keystore::store::{recover, secure, set_up, status, CredentialKeys, Paths, RecoverError, State};
use rand::seq::index::sample;
use tiny_http::{Header, Method, Request, Response, Server};

/// A setup the owner has started but not confirmed. It lives only in memory.
struct Pending {
    recovery: RecoveryKey,
    keys: CredentialKeys,
    /// Three word positions to ask for, counted from 1.
    ask: Vec<usize>,
}

struct App {
    paths: Paths,
    port: u16,
    /// Every form carries it, so another site cannot post to this server.
    token: String,
    pending: Option<Pending>,
}

fn main() {
    let port: u16 = std::env::args()
        .skip_while(|arg| arg != "--port")
        .nth(1)
        .and_then(|port| port.parse().ok())
        .unwrap_or_else(|| {
            eprintln!("usage: keystore-ui --port <port>");
            std::process::exit(2);
        });
    let server = Server::http(("127.0.0.1", port)).expect("port is free");
    let mut app =
        App { paths: Paths::from_env(), port, token: hex::encode(rand::random::<[u8; 32]>()), pending: None };
    println!("listening on http://127.0.0.1:{port}");
    for request in server.incoming_requests() {
        app.serve(request);
    }
}

impl App {
    fn serve(&mut self, mut request: Request) {
        let response = if !self.host_allowed(&request) {
            plain(421, "This server answers only on 127.0.0.1 and localhost.")
        } else if *request.method() == Method::Post {
            let mut body = String::new();
            let read = request.as_reader().take(64 * 1024).read_to_string(&mut body);
            let fields = read.map(|_| form(&body)).unwrap_or_default();
            if !same_text(fields.get("token").map(String::as_str).unwrap_or(""), &self.token) {
                plain(403, "This form has expired. Go back and reload the page.")
            } else {
                self.post(request.url(), &fields)
            }
        } else if *request.method() == Method::Get {
            self.get(request.url())
        } else {
            plain(405, "Not supported.")
        };
        let _ = request.respond(response);
    }

    /// Refuses other host names, so a web page cannot reach this server through DNS tricks.
    fn host_allowed(&self, request: &Request) -> bool {
        let allowed = [format!("127.0.0.1:{}", self.port), format!("localhost:{}", self.port)];
        let host = request.headers().iter().find(|h| h.field.equiv("Host")).map(|h| h.value.as_str());
        host.is_some_and(|host| allowed.iter().any(|name| name == host))
    }

    fn get(&mut self, url: &str) -> Resp {
        let (path, query) = url.split_once('?').unwrap_or((url, ""));
        match path {
            "/" => self.home(query),
            "/style.css" => css(),
            "/setup/words" => match &self.pending {
                Some(pending) => self.words_page(pending),
                None => redirect("/"),
            },
            "/setup/check" => match &self.pending {
                Some(pending) => self.check_page(pending, &HashMap::new(), &[]),
                None => redirect("/"),
            },
            "/not-now" => self.page(
                "Moss will ask again later",
                "<p>Until Moss has somewhere to keep its keys, it can't save passwords or connect \
                 your accounts. Moss will ask again next time you open it.</p>\
                 <p><a class=\"button\" href=\"/\">Set up now</a></p>",
            ),
            _ => plain(404, "Not found."),
        }
    }

    fn post(&mut self, url: &str, fields: &HashMap<String, String>) -> Resp {
        match url {
            "/setup" => {
                if !matches!(status(&self.paths), State::NotSetUp) || !probe().allows_key_file() {
                    return redirect("/");
                }
                let mut ask = sample(&mut rand::thread_rng(), WORD_COUNT, 3).into_vec();
                ask.sort_unstable();
                self.pending = Some(Pending {
                    recovery: RecoveryKey::generate(),
                    keys: CredentialKeys::generate(),
                    ask: ask.into_iter().map(|index| index + 1).collect(),
                });
                redirect("/setup/words")
            }
            "/setup/check" => {
                let Some(pending) = &self.pending else { return redirect("/") };
                let words = pending.recovery.words();
                let wrong: Vec<usize> = pending
                    .ask
                    .iter()
                    .copied()
                    .filter(|position| {
                        let typed = fields.get(&format!("w{position}")).map(String::as_str).unwrap_or("");
                        full_word(typed) != Some(words[position - 1])
                    })
                    .collect();
                if !wrong.is_empty() {
                    return self.check_page(pending, fields, &wrong);
                }
                // The keychain may have appeared or broken since the words were shown.
                match set_up(&self.paths, &probe(), &pending.recovery, &pending.keys) {
                    Ok(()) => {
                        self.pending = None;
                        redirect("/?from=setup")
                    }
                    Err(detail) => self.page(
                        "Moss couldn't save its keys",
                        &format!("<p>Nothing was saved.</p>{}{}", details(&detail), again()),
                    ),
                }
            }
            "/recover" => self.recover(fields),
            "/secure" => match secure(&self.paths) {
                Ok(()) => redirect("/"),
                Err(detail) => self.page(
                    "Moss couldn't make the file private",
                    &format!("<p>Moss still won't use it.</p>{}{}", details(&detail), again()),
                ),
            },
            _ => plain(404, "Not found."),
        }
    }

    fn home(&self, query: &str) -> Resp {
        match status(&self.paths) {
            State::NotSetUp => match probe() {
                Keychain::Working { .. } => self.page(
                    "This computer has a keychain",
                    "<p>Moss would keep its keys in your keychain. This test stops here: keychain \
                     storage is not part of this spike.</p>",
                ),
                Keychain::Broken(detail) => self.page(
                    "Moss can't use this computer's keychain",
                    &format!(
                        "<p>A keychain is installed, but it didn't work when Moss asked. Moss won't \
                         keep its keys in a plain file while a keychain is installed, because the file \
                         would be less safe than the keychain you already have.</p>\
                         <p>Try signing out and back in, or restarting the computer. Then try again.</p>\
                         {}{}",
                        again_labelled("Try again"),
                        details(&detail)
                    ),
                ),
                no_keychain => self.setup_choice(&no_keychain),
            },
            State::Unlocked(unlocked) => {
                let heading = match query {
                    "from=setup" => "Your keys are set up",
                    "from=recovery" => "Your keys are back",
                    _ => "Moss is unlocked",
                };
                self.page(
                    heading,
                    &format!(
                        "<dl><dt>Recovery key</dt><dd class=\"key\">{}</dd>\
                         <dt>Key file</dt><dd><code>{}</code></dd>\
                         <dt>Saved test credential</dt><dd>Opened with these keys</dd>\
                         <dt>Key fingerprint</dt><dd class=\"key\" id=\"fingerprint\">{}</dd></dl>\
                         <p class=\"quiet\">The fingerprint changes only if the keys change.</p>",
                        esc(&unlocked.recovery_key_id),
                        esc(&self.paths.key_file.display().to_string()),
                        unlocked.keys.fingerprint()
                    ),
                )
            }
            State::KeyFileMissing { needs } => {
                self.recovery_page("Moss can't find its key file.", &needs, &HashMap::new(), None)
            }
            State::KeyFileDamaged { needs, .. } => self.recovery_page(
                "Moss's key file is damaged. Moss will keep the damaged file beside the new one.",
                &needs,
                &HashMap::new(),
                None,
            ),
            State::KeyFileForAnotherKey { has, needs } => self.recovery_page(
                &format!("The key file here belongs to a different setup, with recovery key {}.", esc(&has)),
                &needs,
                &HashMap::new(),
                None,
            ),
            other => self.problem_page(other),
        }
    }

    fn setup_choice(&self, keychain: &Keychain) -> Resp {
        let reason = match keychain {
            Keychain::NoSessionBus(_) => "This computer has no desktop session that Moss can ask for a keychain.",
            _ => "This computer has no keychain installed.",
        };
        self.page(
            "Where should Moss keep its keys?",
            &format!(
                "<p>{reason}</p>\
                 <p>Moss can keep its keys in a private file that only your account can read. You'll \
                 also get 24 recovery words to write down. They bring your keys back if the file is \
                 lost.</p>\
                 <p class=\"quiet\">The file is only as safe as this computer's disk. If the disk isn't \
                 encrypted, someone who takes it could read the file.</p>\
                 <form method=\"post\" action=\"/setup\">{}\
                 <button>Use a private file</button> <a class=\"button secondary\" href=\"/not-now\">Not now</a>\
                 </form>",
                self.token_field()
            ),
        )
    }

    fn words_page(&self, pending: &Pending) -> Resp {
        let words: String = pending
            .recovery
            .words()
            .iter()
            .enumerate()
            .map(|(index, word)| format!("<li><span class=\"n\">{}</span>{word}</li>", index + 1))
            .collect();
        self.page(
            "Write down your recovery words",
            &format!(
                "<p>Write the key name and the 24 words on paper, in order, and keep the sheet \
                 somewhere safe.</p>\
                 <p class=\"keyname\">Recovery key <span class=\"key\" id=\"key-name\">{}</span></p>\
                 <ol class=\"words\" id=\"words\">{words}</ol>\
                 <p class=\"warning\">If you lose both this computer's key file and these words, Moss \
                 can't bring back your saved passwords and connections.</p>\
                 <p>Nothing is saved until you finish the next step.</p>\
                 <p><a class=\"button\" href=\"/setup/check\">I've written them down</a></p>",
                pending.recovery.id()
            ),
        )
    }

    fn check_page(&self, pending: &Pending, typed: &HashMap<String, String>, wrong: &[usize]) -> Resp {
        let errors: String = wrong
            .iter()
            .map(|position| format!("<li>Word {position} doesn't match your sheet.</li>"))
            .collect();
        let boxes: String = pending
            .ask
            .iter()
            .map(|position| {
                let name = format!("w{position}");
                let value = typed.get(&name).map(String::as_str).unwrap_or("");
                format!(
                    "<label>Word {position}<input name=\"{name}\" value=\"{}\" {INPUT_FLAGS}></label>",
                    esc(value)
                )
            })
            .collect();
        let error_box =
            if errors.is_empty() { String::new() } else { format!("<div class=\"errors\"><ul>{errors}</ul></div>") };
        self.respond(
            if wrong.is_empty() { 200 } else { 422 },
            "Check your sheet",
            &format!(
                "<p>Type these three words from your sheet. The first four letters of a word are \
                 enough.</p>{error_box}\
                 <form method=\"post\" action=\"/setup/check\" class=\"check\">{}{boxes}\
                 <p><button>Finish setup</button> <a href=\"/setup/words\">Show the words again</a></p></form>",
                self.token_field()
            ),
        )
    }

    fn recover(&mut self, fields: &HashMap<String, String>) -> Resp {
        let needs = match status(&self.paths) {
            State::KeyFileMissing { needs }
            | State::KeyFileDamaged { needs, .. }
            | State::KeyFileForAnotherKey { needs, .. } => needs,
            _ => return redirect("/"),
        };
        let mut typed: Vec<String> =
            (1..=WORD_COUNT).map(|i| fields.get(&format!("w{i}")).cloned().unwrap_or_default()).collect();
        // A whole sheet pasted into the first box fills the rest.
        if typed[1..].iter().all(|word| word.trim().is_empty()) {
            let pasted = split_pasted(&typed[0]);
            if pasted.len() > 1 {
                typed = (0..WORD_COUNT).map(|i| pasted.get(i).cloned().unwrap_or_default()).collect();
            }
        }
        let kept: HashMap<String, String> =
            typed.iter().enumerate().map(|(i, word)| (format!("w{}", i + 1), word.clone())).collect();
        let error = match parse_words(&typed) {
            Err(WordsError::WrongCount { filled }) => {
                format!("<p>Fill in all 24 words. {filled} of 24 are filled in.</p>")
            }
            Err(WordsError::UnknownWords(unknown)) => {
                let items: String = unknown
                    .iter()
                    .map(|word| {
                        let hint = word
                            .suggestion
                            .map(|suggestion| format!(" Did you mean <b>{suggestion}</b>?"))
                            .unwrap_or_default();
                        format!("<li>Word {}, \"{}\", isn't on the word list.{hint}</li>", word.position, esc(&word.typed))
                    })
                    .collect();
                format!("<ul>{items}</ul>")
            }
            Err(WordsError::DoNotFit) => "<p>All 24 words are on the list, but they don't fit together. Check \
                                          for two words in the wrong order, or a word copied from the wrong \
                                          line.</p>"
                .to_string(),
            Ok(recovery) => match recover(&self.paths, &recovery) {
                Ok(_) => return redirect("/?from=recovery"),
                Err(RecoverError::NotThisSetup { typed, needs }) => format!(
                    "<p>These words are for recovery key <span class=\"key\">{}</span>, but this setup \
                     needs <span class=\"key\">{}</span>. Check that you have the right sheet.</p>",
                    esc(&typed),
                    esc(&needs)
                ),
                Err(RecoverError::Unrecoverable(state)) => return self.problem_page(state),
                Err(RecoverError::Io(detail)) => {
                    format!("<p>Moss couldn't write the new key file.</p>{}", details(&detail))
                }
            },
        };
        let reason = match status(&self.paths) {
            State::KeyFileMissing { .. } => "Moss can't find its key file.",
            State::KeyFileDamaged { .. } => "Moss's key file is damaged.",
            _ => "The key file here belongs to a different setup.",
        };
        self.recovery_page(reason, &needs, &kept, Some(&error))
    }

    fn recovery_page(
        &self,
        reason: &str,
        needs: &str,
        typed: &HashMap<String, String>,
        error: Option<&str>,
    ) -> Resp {
        let boxes: String = (1..=WORD_COUNT)
            .map(|i| {
                let value = typed.get(&format!("w{i}")).map(String::as_str).unwrap_or("");
                format!(
                    "<label><span class=\"n\">{i}</span><input name=\"w{i}\" value=\"{}\" {INPUT_FLAGS}></label>",
                    esc(value)
                )
            })
            .collect();
        let error_box = error.map(|error| format!("<div class=\"errors\">{error}</div>")).unwrap_or_default();
        self.respond(
            if error.is_some() { 422 } else { 200 },
            "Enter your recovery words",
            &format!(
                "<p>{reason} Type the 24 words from your recovery sheet to bring your keys back.</p>\
                 <p>Your sheet should say recovery key <span class=\"key\" id=\"needs\">{}</span>.</p>{error_box}\
                 <form method=\"post\" action=\"/recover\">{}\
                 <p class=\"quiet\">The first four letters of each word are enough. You can paste the \
                 whole sheet into the first box.</p>\
                 <div class=\"boxes\">{boxes}</div>\
                 <p><button>Bring my keys back</button></p></form>",
                esc(needs),
                self.token_field()
            ),
        )
    }

    fn problem_page(&self, state: State) -> Resp {
        let bundle = esc(&self.paths.bundle.display().to_string());
        let key_file = esc(&self.paths.key_file.display().to_string());
        match state {
            State::KeyFileExposed { .. } => self.page(
                "Your key file isn't private",
                &format!(
                    "<p>Other accounts on this computer could read Moss's key file or its folder, \
                     <code>{key_file}</code>. Moss won't use the file until it's private again.</p>\
                     <form method=\"post\" action=\"/secure\">{}<button>Make it private</button></form>",
                    self.token_field()
                ),
            ),
            State::KeyFileNotOurs { detail } => self.page(
                "Moss can't trust its key file",
                &format!(
                    "<p>The key file at <code>{key_file}</code> isn't a plain file owned by your account, \
                     so Moss won't read it. Move it away, then check again.</p>{}{}",
                    again(),
                    details(&detail)
                ),
            ),
            State::BundleMissing => self.page(
                "Moss's key bundle is missing",
                &format!(
                    "<p>Moss has its key file, but not the bundle the file unlocks, which belongs at \
                     <code>{bundle}</code>. Restore Moss's data folder from a backup, then check again.</p>{}",
                    again()
                ),
            ),
            State::BundleDamaged(detail) => self.page(
                "Moss's key bundle is damaged",
                &format!(
                    "<p>The bundle at <code>{bundle}</code> failed its safety check, so Moss won't use \
                     it. Restore Moss's data folder from a backup, then check again.</p>{}{}",
                    again(),
                    details(&detail)
                ),
            ),
            State::KeysDoNotMatch(detail) => self.page(
                "Moss's key files don't belong together",
                &format!(
                    "<p>The keys opened, but they don't open Moss's saved test credential. The files \
                     may come from two different setups. Restore all of Moss's files from the same \
                     backup, then check again.</p>{}{}",
                    again(),
                    details(&detail)
                ),
            ),
            _ => redirect("/"),
        }
    }

    fn token_field(&self) -> String {
        format!("<input type=\"hidden\" name=\"token\" value=\"{}\">", self.token)
    }

    fn page(&self, title: &str, body: &str) -> Resp {
        self.respond(200, title, body)
    }

    fn respond(&self, code: u16, title: &str, body: &str) -> Resp {
        let html = format!(
            "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
             <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
             <title>{title} - Moss</title><link rel=\"stylesheet\" href=\"/style.css\"></head>\
             <body><main><p class=\"brand\">Moss</p><h1>{title}</h1>{body}</main></body></html>"
        );
        with_headers(Response::from_string(html).with_status_code(code), "text/html; charset=utf-8")
    }
}

type Resp = Response<std::io::Cursor<Vec<u8>>>;

/// Off for every recovery word box: no saved form history, no cloud spell check, no
/// automatic capitals.
const INPUT_FLAGS: &str = "autocomplete=\"off\" autocapitalize=\"none\" autocorrect=\"off\" spellcheck=\"false\"";

fn again() -> String {
    again_labelled("Check again")
}

fn again_labelled(label: &str) -> String {
    format!("<form method=\"get\" action=\"/\"><button>{label}</button></form>")
}

fn details(detail: &str) -> String {
    format!("<details><summary>What Moss saw</summary><p><code>{}</code></p></details>", esc(detail))
}

fn redirect(to: &str) -> Resp {
    with_headers(Response::from_string("").with_status_code(303), "text/plain; charset=utf-8")
        .with_header(header("Location", to))
}

fn plain(code: u16, text: &str) -> Resp {
    with_headers(Response::from_string(text).with_status_code(code), "text/plain; charset=utf-8")
}

fn css() -> Resp {
    with_headers(Response::from_string(STYLE), "text/css; charset=utf-8")
}

fn with_headers(response: Resp, content_type: &str) -> Resp {
    response
        .with_header(header("Content-Type", content_type))
        .with_header(header("Cache-Control", "no-store"))
        .with_header(header(
            "Content-Security-Policy",
            "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        ))
        .with_header(header("X-Frame-Options", "DENY"))
        .with_header(header("X-Content-Type-Options", "nosniff"))
        .with_header(header("Referrer-Policy", "no-referrer"))
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("ASCII header")
}

fn esc(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

/// Compares two strings in time that depends only on their lengths.
fn same_text(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0, |diff, (x, y)| diff | (x ^ y)) == 0
}

/// An `application/x-www-form-urlencoded` body.
fn form(body: &str) -> HashMap<String, String> {
    body.split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
            (decode(name), decode(value))
        })
        .collect()
}

fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            b'+' => out.push(b' '),
            b'%' => match (hex_digit(bytes.get(at + 1)), hex_digit(bytes.get(at + 2))) {
                (Some(high), Some(low)) => {
                    out.push(high * 16 + low);
                    at += 2;
                }
                _ => out.push(b'%'),
            },
            byte => out.push(byte),
        }
        at += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_digit(byte: Option<&u8>) -> Option<u8> {
    byte.and_then(|byte| char::from(*byte).to_digit(16)).map(|digit| digit as u8)
}

const STYLE: &str = r#"
a { color: var(--accent); }
:root { color-scheme: light; --ink: #1d2320; --muted: #5b655f; --line: #d5dbd7; --accent: #2f6b4f; }
* { box-sizing: border-box; }
body { margin: 0; background: #f6f7f5; color: var(--ink);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 46rem; margin: 3rem auto; padding: 2rem 2.5rem; background: #fff;
  border: 1px solid var(--line); border-radius: 10px; }
.brand { margin: 0 0 .5rem; font-weight: 600; color: var(--accent); letter-spacing: .02em; }
h1 { margin: 0 0 1rem; font-size: 1.6rem; line-height: 1.25; }
p { margin: 0 0 1rem; }
.quiet { color: var(--muted); font-size: .95rem; }
.key { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-weight: 600; }
.keyname { font-size: 1.1rem; }
.warning { padding: .75rem 1rem; background: #fff6e5; border: 1px solid #f0d9a8; border-radius: 8px; }
.errors { padding: .75rem 1rem; margin: 0 0 1rem; background: #fdecec; border: 1px solid #f2c4c4;
  border-radius: 8px; }
.errors p:last-child, .errors ul { margin-bottom: 0; }
.errors ul { padding-left: 1.2rem; margin-top: 0; }
ol.words { display: grid; grid-auto-flow: column; grid-template-rows: repeat(6, auto);
  grid-template-columns: repeat(4, 1fr); gap: .5rem 1rem; padding: 1rem; margin: 0 0 1rem;
  list-style: none; border: 1px solid var(--line); border-radius: 8px;
  font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 1.05rem; }
.n { display: inline-block; min-width: 1.8rem; color: var(--muted); font-size: .85rem; }
.boxes { display: grid; grid-auto-flow: column; grid-template-rows: repeat(6, auto);
  grid-template-columns: repeat(4, 1fr); gap: .5rem 1rem; margin: 0 0 1rem; }
.boxes label { display: flex; align-items: center; }
.boxes input { width: 100%; min-width: 0; }
.check label { display: block; margin: 0 0 .75rem; font-weight: 600; }
.check input { display: block; margin-top: .25rem; width: 16rem; }
input { padding: .45rem .6rem; font: inherit; font-weight: 400; border: 1px solid #b9c2bd; border-radius: 6px; }
button, .button { display: inline-block; padding: .55rem 1.1rem; font: inherit; font-weight: 600;
  color: #fff; background: var(--accent); border: 1px solid var(--accent); border-radius: 6px;
  text-decoration: none; cursor: pointer; }
.button.secondary { color: var(--accent); background: #fff; }
button + a { margin-left: .75rem; }
form { margin: 0 0 1rem; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: .5rem 1.5rem; margin: 0 0 1rem; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: .9rem; overflow-wrap: anywhere; }
details { margin: 0 0 1rem; color: var(--muted); }
"#;
