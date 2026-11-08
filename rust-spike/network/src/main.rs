use std::{path::PathBuf, process::ExitCode};

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some("local-certificate") {
        eprintln!(
            "Usage: moss-network local-certificate <new-private-folder> <https-origin> [...]"
        );
        return ExitCode::FAILURE;
    }
    let Some(folder) = args.next() else {
        return ExitCode::FAILURE;
    };
    let origins: Vec<_> = args.collect();
    match moss_network::tls::local_certificate(&PathBuf::from(folder), &origins) {
        Ok(()) => {
            eprintln!("Local certificate created. Verify and trust its public certificate on each device before signing in. Its private key stays on the Moss host.");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}
