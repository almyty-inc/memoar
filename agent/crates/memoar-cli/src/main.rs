use clap::Parser;
use clap::error::ErrorKind;
use memoar_cli::{AppError, Cli, RuntimePaths, error_envelope, execute, success_envelope};
use std::process::ExitCode;

fn main() -> ExitCode {
    let arguments: Vec<_> = std::env::args_os().collect();
    let json_mode = arguments.iter().any(|argument| argument == "--json");
    let cli = match Cli::try_parse_from(arguments) {
        Ok(cli) => cli,
        Err(error) => {
            // `--help` and `--version` come back from clap as errors, and were
            // being handled as usage failures: printed to stderr, exit 2. Asking
            // a program its version is not a mistake, and anything probing for
            // the tool — a package manager, a CI check, `memoar --version` in a
            // script — read that as the tool being broken.
            if matches!(
                error.kind(),
                ErrorKind::DisplayHelp | ErrorKind::DisplayVersion
            ) {
                print!("{error}");
                return ExitCode::SUCCESS;
            }
            let application_error = AppError::usage(error.to_string());
            if json_mode {
                println!("{}", error_envelope(&application_error));
            } else {
                eprint!("{error}");
            }
            return ExitCode::from(application_error.exit_code);
        }
    };
    let paths = match RuntimePaths::resolve(&cli) {
        Ok(paths) => paths,
        Err(error) => return render_error(cli.json, error),
    };
    match execute(&cli, &paths) {
        Ok(output) => {
            if cli.json {
                println!("{}", success_envelope(&output));
            } else if let Ok(text) = serde_json::to_string_pretty(&output.data) {
                println!("{text}");
            }
            ExitCode::SUCCESS
        }
        Err(error) => render_error(cli.json, error),
    }
}

fn render_error(json_mode: bool, error: AppError) -> ExitCode {
    if json_mode {
        println!("{}", error_envelope(&error));
    } else {
        eprintln!("memoar: {}\nhint: {}", error.message, error.hint);
    }
    ExitCode::from(error.exit_code)
}
