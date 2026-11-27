//! moss-backup: take, verify, list, pin and prune encrypted instance backups.
//!
//! Every command prints one JSON object on stdout. Errors print `{"ok":false,"error":...}` and
//! exit 1. Nothing secret is ever printed.

use std::path::PathBuf;
use std::process::ExitCode;

use bundled_db::cluster::Bundle;
use moss_backup::{capture, drill, ledger};
use serde_json::{json, Value};

const USAGE: &str = "usage:
  moss-backup backup --instance DIR --pg DIR [--test-pause FILE]
  moss-backup verify --instance DIR --pg DIR --id ID [--scratch DIR] [--test-pause FILE]
  moss-backup list   --instance DIR
  moss-backup pin    --instance DIR --id ID
  moss-backup unpin  --instance DIR --id ID
  moss-backup prune  --instance DIR
  moss-backup open   --archive FILE --words-file FILE";

#[derive(Default)]
struct Options {
    instance: Option<PathBuf>,
    pg: Option<PathBuf>,
    id: Option<String>,
    scratch: Option<PathBuf>,
    pause: Option<PathBuf>,
    archive: Option<PathBuf>,
    words: Option<PathBuf>,
}

impl Options {
    fn parse(args: &[String]) -> Result<Options, String> {
        let mut options = Options::default();
        let mut args = args.iter();
        while let Some(flag) = args.next() {
            let mut value = || {
                args.next()
                    .cloned()
                    .ok_or_else(|| format!("{flag} needs a value"))
            };
            match flag.as_str() {
                "--instance" => options.instance = Some(value()?.into()),
                "--pg" => options.pg = Some(value()?.into()),
                "--id" => options.id = Some(value()?),
                "--scratch" => options.scratch = Some(value()?.into()),
                "--test-pause" => options.pause = Some(value()?.into()),
                "--archive" => options.archive = Some(value()?.into()),
                "--words-file" => options.words = Some(value()?.into()),
                other => return Err(format!("unknown option {other}\n{USAGE}")),
            }
        }
        Ok(options)
    }

    fn instance(&self) -> Result<&PathBuf, String> {
        self.instance
            .as_ref()
            .ok_or_else(|| "--instance is required".into())
    }

    fn bundle(&self) -> Result<Bundle, String> {
        Bundle::new(self.pg.as_deref().ok_or("--pg is required")?)
    }

    fn id(&self) -> Result<&str, String> {
        self.id.as_deref().ok_or_else(|| "--id is required".into())
    }
}

fn run(command: &str, options: &Options) -> Result<Value, String> {
    match command {
        "backup" => {
            let done = capture::backup(
                options.instance()?,
                &options.bundle()?,
                options.pause.as_deref(),
            )?;
            Ok(json!({ "id": done.id, "size": done.size, "sha256": done.sha256 }))
        }
        "verify" => {
            let scratch = options
                .scratch
                .clone()
                .unwrap_or_else(drill::default_scratch);
            let report = drill::verify(
                options.instance()?,
                &options.bundle()?,
                options.id()?,
                &scratch,
                options.pause.as_deref(),
            )?;
            Ok(json!({
                "id": options.id()?,
                "verified": true,
                "tables": report.tables,
                "rows": report.rows,
                "files": report.files,
                "dumpBytes": report.dump_bytes,
            }))
        }
        "list" => {
            let entries = ledger::list(options.instance()?)?;
            Ok(json!({ "backups": entries.iter().map(ledger::Entry::to_json).collect::<Vec<_>>() }))
        }
        "pin" | "unpin" => {
            ledger::set_pinned(options.instance()?, options.id()?, command == "pin")?;
            Ok(json!({ "id": options.id()?, "pinned": command == "pin" }))
        }
        "prune" => Ok(json!({ "removed": ledger::prune(options.instance()?)? })),
        "open" => {
            let archive = options.archive.as_ref().ok_or("--archive is required")?;
            let words_file = options.words.as_ref().ok_or("--words-file is required")?;
            let text =
                std::fs::read_to_string(words_file).map_err(|e| format!("words file: {e}"))?;
            let words: Vec<String> = text.split_whitespace().map(str::to_owned).collect();
            let (id, credentials_sha256, entries) = drill::open_with_words(archive, &words)?;
            Ok(json!({ "id": id, "credentialsSha256": credentials_sha256, "entries": entries }))
        }
        _ => Err(USAGE.into()),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some((command, rest)) = args.split_first() else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    let result = Options::parse(rest).and_then(|options| run(command, &options));
    match result {
        Ok(mut value) => {
            value["ok"] = json!(true);
            println!("{value}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            println!("{}", json!({ "ok": false, "error": error }));
            ExitCode::from(1)
        }
    }
}
