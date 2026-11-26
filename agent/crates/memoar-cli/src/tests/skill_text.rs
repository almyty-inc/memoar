//! The skill an agent follows names only commands and flags this binary has.
//!
//! The reference page told agents to run `memoar view --turn-start`, a flag
//! that never existed. An agent following it literally got a usage error.
//! The server's tests hold the MCP tool names, and this holds the CLI.

use clap::CommandFactory;
use std::collections::BTreeSet;

use crate::args::Cli;
use crate::integrate::skill::SKILL_FILES;

fn long_flags(command: &clap::Command, into: &mut BTreeSet<String>) {
    for argument in command.get_arguments() {
        if let Some(long) = argument.get_long() {
            into.insert(format!("--{long}"));
        }
    }
    for sub in command.get_subcommands() {
        long_flags(sub, into);
    }
}

fn words(text: &str) -> Vec<&str> {
    text.split(|character: char| !(character.is_ascii_alphanumeric() || character == '-'))
        .filter(|word| !word.is_empty())
        .collect()
}

#[test]
fn every_flag_the_skill_names_exists() {
    let mut flags = BTreeSet::from(["--help".to_owned(), "--version".to_owned()]);
    long_flags(&Cli::command(), &mut flags);
    for (name, text) in SKILL_FILES {
        let named = words(text).into_iter().filter(|word| {
            word.strip_prefix("--")
                .is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_lowercase()))
        });
        for word in named {
            assert!(
                flags.contains(word),
                "{name} names {word}, which memoar does not accept"
            );
        }
    }
}

/// Every command written as code, such as `memoar mcp call <tool>`, names
/// subcommands that exist, down to the first argument or flag.
#[test]
fn every_command_the_skill_names_exists() {
    let cli = Cli::command();
    let mut checked = 0;
    for (name, text) in SKILL_FILES {
        for line in text.split(['`', '\n']) {
            let Some(rest) = line.trim().strip_prefix("memoar ") else {
                continue;
            };
            checked += 1;
            walk(
                name,
                &cli,
                rest.split_whitespace().collect::<Vec<_>>().as_slice(),
            );
        }
    }
    assert!(checked > 10, "the skill should show commands as code");
}

fn walk(file: &str, command: &clap::Command, words: &[&str]) {
    let Some((word, rest)) = words.split_first() else {
        return;
    };
    if !command.has_subcommands() || word.starts_with(['<', '[', '-', '\'', '"']) {
        return;
    }
    for alternative in word.split('|') {
        let sub = command.find_subcommand(alternative).unwrap_or_else(|| {
            panic!(
                "{file} names `{} {alternative}`, which is not a command",
                command.get_name()
            )
        });
        walk(file, sub, rest);
    }
}
