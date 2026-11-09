//! The Moss desktop app. It connects to a Moss server on this computer, starting it when
//! needed, or to one on another computer. Everything else runs on the server.
//!
//! The app's own screens are served from `moss-app://`. Server pages open in a separate web
//! view with its own profile. That view allows the server's pinned certificate and closes any
//! page load that arrived over a different one (see `trust_on_linux`).

mod pin;
mod provision;
mod reach;
mod store;

#[cfg(target_os = "linux")]
mod trust_linux;
#[cfg(target_os = "macos")]
mod trust_macos;
#[cfg(windows)]
mod trust_windows;

use reach::Problem;
use serde_json::{json, Value};
use std::borrow::Cow;
use std::path::PathBuf;
use store::{Remote, Servers, Store, Target};
use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::window::{Window, WindowBuilder};
use wry::http::{header, Request, Response, StatusCode};
use wry::{NewWindowResponse, WebContext, WebView, WebViewBuilder};

const SCHEME: &str = "moss-app";
const HOME: &str = "moss-app://localhost/index.html";
const SERVERS_LINK: &str = "moss-app://servers";

enum UserEvent {
    Ipc(String),
    Show(Value),
    Open(Opened),
    ShowServers,
    Connect(String),
    /// A server page failed to load; check whether the server is still there.
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    Check(String),
    /// A server page arrived over a certificate other than the pinned one. Holds its
    /// fingerprint, if it had a certificate at all.
    WrongCertificate(String, Option<String>),
    /// A background result, dropped if the user has acted since it started.
    Later(u64, Box<UserEvent>),
}

struct Opened {
    id: String,
    name: String,
    origin: String,
    certificate: Vec<u8>,
}

/// Declared in this order so the web view drops before the profile it uses.
struct ServerView {
    id: String,
    origin: String,
    view: WebView,
    _profile: Box<WebContext>,
}

struct App {
    store: Store,
    servers: Servers,
    install: PathBuf,
    runtime: tokio::runtime::Runtime,
    proxy: EventLoopProxy<UserEvent>,
    window: Window,
    connect: WebView,
    server: Option<ServerView>,
    current: Option<String>,
    /// The address and code on the certificate screen, the only pin the user can confirm.
    shown_pin: Option<(String, String)>,
    turn: u64,
}

struct Args {
    data: PathBuf,
    install: PathBuf,
}

fn parse_args() -> Result<Args, String> {
    let install = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(PathBuf::from))
        .unwrap_or_default();
    let mut args = Args {
        data: store::default_data_dir().ok_or("no home folder")?,
        install,
    };
    let mut raw = std::env::args().skip(1);
    while let Some(flag) = raw.next() {
        let value = raw.next().ok_or_else(|| format!("{flag} needs a value"))?;
        match flag.as_str() {
            "--data" => args.data = PathBuf::from(value),
            "--install" => args.install = PathBuf::from(value),
            _ => return Err(format!("unknown option {flag}")),
        }
    }
    Ok(args)
}

fn main() {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("moss-app: {e}");
            std::process::exit(2);
        }
    };
    let store = Store::new(args.data);
    let servers = store.load().unwrap_or_else(|_| {
        eprintln!("moss-app: the server list is unreadable; starting with an empty list");
        Servers::default()
    });
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let window = WindowBuilder::new()
        .with_title("Moss")
        .with_inner_size(LogicalSize::new(1360.0, 860.0))
        .with_min_inner_size(LogicalSize::new(360.0, 560.0))
        .build(&event_loop)
        .expect("window");

    let web = args.install.join("web");
    let ipc = proxy.clone();
    let builder = WebViewBuilder::new()
        .with_custom_protocol(SCHEME.into(), move |_, request| asset(&web, request))
        .with_ipc_handler(move |request: Request<String>| {
            // Only the app's own pages may send actions.
            if request.uri().scheme_str() == Some(SCHEME) {
                let _ = ipc.send_event(UserEvent::Ipc(request.into_body()));
            }
        })
        .with_navigation_handler(|url| url.starts_with("moss-app://localhost/"))
        .with_new_window_req_handler(|_, _| NewWindowResponse::Deny)
        .with_url(HOME);
    let connect = build(builder, &window);

    let mut app = App {
        store,
        servers,
        install: args.install,
        runtime: tokio::runtime::Runtime::new().expect("tokio runtime"),
        proxy,
        window,
        connect,
        server: None,
        current: None,
        shown_pin: None,
        turn: 0,
    };
    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => *control_flow = ControlFlow::Exit,
            Event::UserEvent(event) => app.handle(event),
            _ => {}
        }
    });
}

fn build(builder: WebViewBuilder, window: &Window) -> WebView {
    #[cfg(target_os = "linux")]
    {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        builder
            .build_gtk(window.default_vbox().expect("vbox"))
            .expect("webview")
    }
    #[cfg(not(target_os = "linux"))]
    {
        builder.build(window).expect("webview")
    }
}

/// The app's own pages come from this binary; the stylesheet, fonts and theme come from the
/// installed web build, so the screens match the server's.
fn asset(web: &std::path::Path, request: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let path = request.uri().path();
    let embedded: Option<(&str, &'static [u8])> = match path {
        "/" | "/index.html" => Some(("text/html", include_bytes!("../assets/index.html"))),
        "/connect.js" => Some(("text/javascript", include_bytes!("../assets/connect.js"))),
        "/connect.css" => Some(("text/css", include_bytes!("../assets/connect.css"))),
        _ => None,
    };
    let reply = |status: StatusCode, kind: &str, body: Cow<'static, [u8]>| {
        Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, kind)
            .header(
                "content-security-policy",
                "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
            )
            .body(body)
            .expect("response")
    };
    if let Some((kind, body)) = embedded {
        return reply(StatusCode::OK, kind, Cow::Borrowed(body));
    }
    let file = match path {
        "/app.css" | "/boot-theme.js" | "/icon.svg" => {
            Some(path.trim_start_matches('/').to_owned())
        }
        p if p.starts_with("/fonts/") && !p.contains("..") && p.ends_with(".woff2") => {
            Some(p.trim_start_matches('/').to_owned())
        }
        _ => None,
    };
    let kind = match path.rsplit('.').next() {
        Some("css") => "text/css",
        Some("js") => "text/javascript",
        Some("svg") => "image/svg+xml",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    };
    match file.and_then(|f| std::fs::read(web.join(f)).ok()) {
        Some(bytes) => reply(StatusCode::OK, kind, Cow::Owned(bytes)),
        None => reply(StatusCode::NOT_FOUND, "text/plain", Cow::Borrowed(b"")),
    }
}

impl App {
    fn handle(&mut self, event: UserEvent) {
        match event {
            UserEvent::Ipc(body) => {
                if let Ok(message) = serde_json::from_str::<Value>(&body) {
                    self.turn += 1;
                    self.action(&message);
                }
            }
            UserEvent::Later(turn, event) => {
                if turn == self.turn {
                    self.handle(*event);
                }
            }
            UserEvent::Show(state) => self.show(state),
            UserEvent::Open(opened) => self.open(opened),
            UserEvent::ShowServers => self.list_servers(),
            UserEvent::Connect(id) => self.choose(id),
            UserEvent::Check(id) => {
                if self.current.as_deref() == Some(id.as_str()) {
                    self.check(id);
                }
            }
            UserEvent::WrongCertificate(id, fingerprint) => {
                // Only the page on screen counts; the Servers list keeps the page but clears current.
                let showing = self.current.as_deref() == Some(id.as_str())
                    && self.server.as_ref().is_some_and(|s| s.id == id);
                if !showing {
                    return;
                }
                // No certificate means an error page, so the native check reports why.
                let Some(fingerprint) = fingerprint else {
                    return self.check(id);
                };
                self.server = None;
                let Some(target) = self.store.find(&self.servers, &id) else {
                    return self.list_servers();
                };
                self.show(problem_screen(
                    &target,
                    &Problem::CertificateChanged { fingerprint },
                ));
            }
        }
    }

    fn action(&mut self, message: &Value) {
        let text = |key: &str| {
            message
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        match message
            .get("do")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "start" | "retry" => match self.current.clone().or_else(|| self.servers.last.clone()) {
                Some(id) => self.connect(id),
                None => self.show(json!({"screen":"first-run"})),
            },
            "first-run" => self.show(json!({"screen":"first-run"})),
            "this-computer" => self.this_computer(),
            "new-server" => self.show(json!({"screen":"create", "name": text("name")})),
            "create" => self.create(text("name")),
            "stop" => self.stop(text("id")),
            "another" => self.show(json!({
                "screen":"add", "first": self.servers.last.is_none(), "address": text("address"),
            })),
            "probe" => self.probe(text("address")),
            "confirm" => {
                if let Some(pin) = self.confirmed(&text("address"), &text("fingerprint")) {
                    self.add_remote(text("address"), pin);
                }
            }
            "accept-new" => {
                let id = text("id");
                let Some(origin) = self
                    .servers
                    .remotes
                    .iter()
                    .find(|r| r.id == id)
                    .map(|r| r.origin.clone())
                else {
                    return;
                };
                if let Some(pin) = self.confirmed(&origin, &text("fingerprint")) {
                    if let Some(remote) = self.servers.remotes.iter_mut().find(|r| r.id == id) {
                        remote.pin = pin;
                    }
                    self.save();
                    self.connect(id);
                }
            }
            "servers" => self.list_servers(),
            "open" => self.choose(text("id")),
            "remove" => self.remove(text("id")),
            _ => {}
        }
    }

    /// The pin the certificate screen showed for this address, when the page echoes it back.
    fn confirmed(&mut self, address: &str, fingerprint: &str) -> Option<String> {
        let (shown_address, shown) = self.shown_pin.take()?;
        (shown_address == address && shown == fingerprint).then_some(shown)
    }

    fn save(&self) {
        if self.store.save(&self.servers).is_err() {
            eprintln!("moss-app: could not save the server list");
        }
    }

    /// Opens this computer's default server, setting it up first when it does not exist yet.
    fn this_computer(&mut self) {
        let id = store::local_id("default");
        let set_up = self
            .store
            .targets(&self.servers)
            .iter()
            .any(|t| t.id() == id);
        if set_up {
            return self.choose(id);
        }
        self.create("default".into());
    }

    /// Makes a local server (folder, certificate, database) and opens it.
    fn create(&mut self, name: String) {
        if !store::valid_instance(&name) {
            return self.show(
                json!({"screen":"create", "name": name, "error": provision::Failure::BadName.reason()}),
            );
        }
        let label = if name == "default" {
            "This computer".to_owned()
        } else {
            format!("This computer ({name})")
        };
        self.show(json!({"screen":"setting-up", "name": label}));
        let (proxy, turn) = (self.proxy.clone(), self.turn);
        let (store, install) = (self.store.clone(), self.install.clone());
        self.runtime.spawn(async move {
            let made = tokio::task::spawn_blocking({
                let name = name.clone();
                move || provision::create_instance(&store, &install, &name)
            })
            .await;
            let event = match made {
                Ok(Ok(())) => UserEvent::Connect(store::local_id(&name)),
                Ok(Err(failure)) => UserEvent::Show(
                    json!({"screen":"create", "name": name, "error": failure.reason()}),
                ),
                Err(_) => UserEvent::Show(
                    json!({"screen":"create", "name": name, "error": provision::Failure::Other.reason()}),
                ),
            };
            let _ = proxy.send_event(UserEvent::Later(turn, Box::new(event)));
        });
    }

    /// Stops a local server and its database, then refreshes the list.
    fn stop(&mut self, id: String) {
        let Some(Target::Local { folder, .. }) = self.store.find(&self.servers, &id) else {
            return self.list_servers();
        };
        if self.server.as_ref().is_some_and(|s| s.id == id) {
            self.server = None;
        }
        self.current = None;
        let (proxy, install) = (self.proxy.clone(), self.install.clone());
        self.runtime.spawn(async move {
            let _ = reach::stop_local(&install, &folder).await;
            let _ = proxy.send_event(UserEvent::ShowServers);
        });
    }

    fn choose(&mut self, id: String) {
        self.servers.last = Some(id.clone());
        self.save();
        self.connect(id);
    }

    /// Shows one of the app's own screens, hiding any server page.
    fn show(&mut self, state: Value) {
        self.shown_pin = match (
            state["screen"].as_str(),
            state["address"].as_str(),
            state["fingerprint"].as_str(),
        ) {
            (Some("check"), Some(address), Some(fingerprint)) => {
                Some((address.to_owned(), fingerprint.to_owned()))
            }
            _ => None,
        };
        if let Some(server) = &self.server {
            let _ = server.view.set_visible(false);
        }
        let _ = self.connect.set_visible(true);
        self.window.set_title("Moss");
        let _ = self
            .connect
            .evaluate_script(&format!("window.moss.show({state})"));
    }

    fn connect(&mut self, id: String) {
        let Some(target) = self.store.find(&self.servers, &id) else {
            return self.list_servers();
        };
        self.current = Some(id.clone());
        let name = target.name();
        self.show(json!({"screen":"connecting", "name": name}));
        let (proxy, turn) = (self.proxy.clone(), self.turn);
        let install = self.install.clone();
        self.runtime.spawn(async move {
            let reached = match &target {
                Target::Local { folder, .. } => reach::local_or_start(&install, folder)
                    .await
                    .map(|(running, der)| (running.origin, der)),
                Target::Remote(remote) => reach::hello(&remote.origin, &remote.pin)
                    .await
                    .map(|(_, der)| (remote.origin.clone(), der)),
            };
            let event = match reached {
                Ok((origin, certificate)) => UserEvent::Open(Opened {
                    id,
                    name,
                    origin,
                    certificate,
                }),
                Err(problem) => UserEvent::Show(problem_screen(&target, &problem)),
            };
            let _ = proxy.send_event(UserEvent::Later(turn, Box::new(event)));
        });
    }

    /// Re-checks the current server after a page failed to load. The page stays if it answers.
    fn check(&mut self, id: String) {
        let Some(target) = self.store.find(&self.servers, &id) else {
            return;
        };
        let (proxy, turn) = (self.proxy.clone(), self.turn);
        self.runtime.spawn(async move {
            let problem = match &target {
                Target::Local { folder, .. } => reach::local(folder).await.err(),
                Target::Remote(remote) => reach::hello(&remote.origin, &remote.pin).await.err(),
            };
            if let Some(problem) = problem {
                let screen = UserEvent::Show(problem_screen(&target, &problem));
                let _ = proxy.send_event(UserEvent::Later(turn, Box::new(screen)));
            }
        });
    }

    fn probe(&mut self, address: String) {
        let origin = match reach::parse_origin(&address) {
            Ok(origin) => origin,
            Err(error) => {
                return self.show(json!({"screen":"add", "address": address, "error": error, "first": self.servers.last.is_none()}))
            }
        };
        self.show(json!({"screen":"connecting", "name": origin.trim_start_matches("https://")}));
        let first = self.servers.last.is_none();
        let (proxy, turn) = (self.proxy.clone(), self.turn);
        self.runtime.spawn(async move {
            let state = match reach::peek_certificate(&origin).await {
                Ok(fingerprint) => json!({"screen":"check", "address": origin, "fingerprint": fingerprint}),
                Err(problem) => json!({"screen":"add", "address": origin, "error": problem.reason(), "first": first}),
            };
            let _ = proxy.send_event(UserEvent::Later(turn, Box::new(UserEvent::Show(state))));
        });
    }

    fn add_remote(&mut self, address: String, pin: String) {
        let Ok(origin) = reach::parse_origin(&address) else {
            return self.list_servers();
        };
        let name = origin.trim_start_matches("https://").to_owned();
        let id = match self.servers.remotes.iter_mut().find(|r| r.origin == origin) {
            Some(existing) => {
                existing.pin = pin;
                existing.id.clone()
            }
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                self.servers.remotes.push(Remote {
                    id: id.clone(),
                    name,
                    origin,
                    pin,
                });
                id
            }
        };
        self.choose(id);
    }

    fn remove(&mut self, id: String) {
        // Only other computers can be removed; this computer's servers stay listed.
        if !self.servers.remotes.iter().any(|r| r.id == id) {
            return self.list_servers();
        }
        self.servers.remotes.retain(|r| r.id != id);
        if self.servers.last.as_deref() == Some(id.as_str()) {
            self.servers.last = None;
        }
        if self.current.as_deref() == Some(id.as_str()) {
            self.current = None;
        }
        if self.server.as_ref().is_some_and(|s| s.id == id) {
            self.server = None;
        }
        self.store.remove_profile(&id);
        self.save();
        self.list_servers();
    }

    fn list_servers(&mut self) {
        self.current = None;
        let targets = self.store.targets(&self.servers);
        let rows: Vec<Value> = targets.iter().map(|t| server_row(t, "Checking…")).collect();
        self.show(json!({"screen":"servers", "servers": rows}));
        let (proxy, turn) = (self.proxy.clone(), self.turn);
        self.runtime.spawn(async move {
            let mut rows = Vec::new();
            for target in &targets {
                let state = match target {
                    Target::Local { folder, .. } => match reach::local(folder).await {
                        Ok(_) => "Running",
                        Err(_) => "Not running",
                    },
                    Target::Remote(remote) => match reach::hello(&remote.origin, &remote.pin).await
                    {
                        Ok(_) => "Reachable",
                        Err(_) => "Can't reach",
                    },
                };
                rows.push(server_row(target, state));
            }
            let rows = UserEvent::Show(json!({"screen":"servers", "servers": rows}));
            let _ = proxy.send_event(UserEvent::Later(turn, Box::new(rows)));
        });
    }

    fn open(&mut self, opened: Opened) {
        if self.current.as_deref() != Some(opened.id.as_str()) {
            return;
        }
        let reuse = self
            .server
            .as_ref()
            .is_some_and(|s| s.id == opened.id && s.origin == opened.origin);
        if !reuse {
            self.server = None;
            match self.server_view(&opened) {
                Ok(view) => self.server = Some(view),
                Err(_) => {
                    return self.show(json!({"screen":"problem", "name": opened.name, "reason": "This app could not open the server's pages.", "retry": false}))
                }
            }
        }
        let _ = self.connect.set_visible(false);
        if let Some(server) = &self.server {
            let _ = server.view.set_visible(true);
        }
        self.window.set_title(&format!("Moss · {}", opened.name));
    }

    fn server_view(&self, opened: &Opened) -> Result<ServerView, String> {
        let dir = self.store.profile(&opened.id)?;
        let mut profile = Box::new(WebContext::new(Some(dir)));
        let origin = opened.origin.clone();
        let links = self.proxy.clone();
        let builder = WebViewBuilder::new_with_web_context(&mut profile)
            .with_navigation_handler(move |url| {
                if url == SERVERS_LINK || url == format!("{SERVERS_LINK}/") {
                    let _ = links.send_event(UserEvent::ShowServers);
                    return false;
                }
                url == origin || url.starts_with(&format!("{origin}/"))
            })
            .with_new_window_req_handler(|_, _| NewWindowResponse::Deny)
            .with_initialization_script("window.mossApp = true;");
        let view = build(builder, &self.window);
        #[cfg(target_os = "linux")]
        trust_linux::install(&view, opened, self.proxy.clone())?;
        #[cfg(target_os = "macos")]
        trust_macos::install(&view, opened, self.proxy.clone())?;
        #[cfg(windows)]
        trust_windows::install(&view, opened, self.proxy.clone())?;
        view.load_url(&format!("{}/today", opened.origin))
            .map_err(|_| "Cannot load the server")?;
        Ok(ServerView {
            id: opened.id.clone(),
            origin: opened.origin.clone(),
            view,
            _profile: profile,
        })
    }
}

fn server_row(target: &Target, state: &str) -> Value {
    let detail = match target {
        Target::Local { instance, .. } => instance.clone(),
        Target::Remote(remote) => remote.origin.trim_start_matches("https://").to_owned(),
    };
    json!({
        "id": target.id(),
        "name": target.name(),
        "detail": detail,
        "state": state,
        "removable": matches!(target, Target::Remote(_)),
        "stoppable": matches!(target, Target::Local { .. }) && state == "Running",
    })
}

fn problem_screen(target: &Target, problem: &Problem) -> Value {
    let name = target.name();
    let local = matches!(target, Target::Local { .. });
    let mut state = match problem {
        Problem::CertificateChanged { fingerprint } => match target {
            Target::Remote(remote) => json!({
                "screen":"check", "changed": true, "id": remote.id, "name": name,
                "address": remote.origin, "fingerprint": fingerprint,
            }),
            Target::Local { .. } => {
                return json!({"screen":"problem", "code": Problem::Unreachable.code(), "name": name, "reason": Problem::Unreachable.reason(), "retry": false, "local": true});
            }
        },
        Problem::ServerTooOld => json!({
            "screen":"version", "title": problem.reason().trim_end_matches('.'),
            "detail": format!("This app needs a newer Moss on {name}."),
        }),
        Problem::AppTooOld => json!({
            "screen":"version", "title": problem.reason().trim_end_matches('.'),
            "detail": format!("{name} needs a newer app."),
        }),
        Problem::NotSetUp => {
            json!({"screen":"problem", "name": name, "reason": problem.reason(), "retry": false, "local": local})
        }
        _ => {
            json!({"screen":"problem", "name": name, "reason": problem.reason(), "retry": true, "local": local})
        }
    };
    state["code"] = json!(problem.code());
    state
}
