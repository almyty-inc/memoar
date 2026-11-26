use clap::Parser;
use clap::error::ErrorKind;
use memoar_cli::{AppError, Cli, Command, RuntimePaths, error_envelope, execute, success_envelope};
use std::path::PathBuf;
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
        // These two touch no disk, and a probe asking what this binary
        // supports must not fail for want of a home directory.
        Err(_) if matches!(cli.command, Command::Capabilities | Command::Introspect) => {
            RuntimePaths {
                config_dir: PathBuf::new(),
                data_dir: PathBuf::new(),
                home: PathBuf::new(),
            }
        }
        Err(error) => return render_error(cli.json, error),
    };
    // The stdio MCP server owns standard output: a result envelope printed
    // after the client hangs up would be one more message nobody asked for.
    if let Command::Mcp(args) = &cli.command
        && args.serves()
    {
        return match execute(&cli, &paths) {
            Ok(_) => ExitCode::SUCCESS,
            Err(error) => render_error(false, error),
        };
    }
    match execute(&cli, &paths) {
        Ok(output) => {
            if cli.json {
                println!("{}", success_envelope(&output));
            } else if let Some(text) = output.data.as_str() {
                // A command whose answer is text, such as a log, prints it
                // as text rather than as one JSON string.
                println!("{text}");
            } else if let Ok(text) = serde_json::to_string_pretty(&output.data) {
                println!("{text}");
            }
            warn_if_capture_stopped(cli.json, &output.data);
            ExitCode::SUCCESS
        }
        Err(error) => render_error(cli.json, error),
    }
}

/// `status` and `doctor` print a page of JSON, and a stopped capture is one
/// field in it. For a person reading a terminal it is also the last thing on
/// stderr, where it cannot scroll past unread.
fn warn_if_capture_stopped(json_mode: bool, data: &serde_json::Value) {
    let health = &data["backgroundCapture"];
    if json_mode || health["ok"] != serde_json::Value::Bool(false) {
        return;
    }
    eprintln!(
        "\nmemoar: {}",
        health["summary"].as_str().unwrap_or_default()
    );
    if let Some(hint) = health["hint"].as_str() {
        eprintln!("hint: {hint}");
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
