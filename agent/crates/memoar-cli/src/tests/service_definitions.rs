use std::path::{Path, PathBuf};

use crate::service::spec::{ServiceSpec, program_note, validate_name};
use crate::service::{launchd, schtasks, systemd};

/// Built by hand, with Unix paths whatever the host, so the definitions read
/// the same on every runner. `ServiceSpec::new` is tested on its own below.
fn spec(program: &str, root: &str) -> ServiceSpec {
    let directory = |leaf: &str| format!("{root}/{leaf}");
    ServiceSpec {
        name: "test-1".to_owned(),
        program: PathBuf::from(program),
        arguments: vec![
            "service".to_owned(),
            "run".to_owned(),
            "--name".to_owned(),
            "test-1".to_owned(),
            "--config-dir".to_owned(),
            directory("config dir"),
            "--data-dir".to_owned(),
            directory("data"),
            "--capture-home".to_owned(),
            directory("home"),
        ],
        data_dir: PathBuf::from(directory("data")),
        log_dir: PathBuf::from(directory("data/logs")),
    }
}

#[cfg(unix)]
#[test]
fn the_service_runs_the_supervisor_with_absolute_directories() {
    let paths = crate::config::RuntimePaths {
        config_dir: PathBuf::from("/tmp/scratch/config dir"),
        data_dir: PathBuf::from("/tmp/scratch/data"),
        home: PathBuf::from("/tmp/scratch/home"),
    };
    let spec = ServiceSpec::new("test-1", Path::new("/usr/local/bin/memoar"), &paths).unwrap();
    assert_eq!(
        spec.arguments,
        [
            "service",
            "run",
            "--name",
            "test-1",
            "--config-dir",
            "/tmp/scratch/config dir",
            "--data-dir",
            "/tmp/scratch/data",
            "--capture-home",
            "/tmp/scratch/home",
        ]
    );
    assert_eq!(spec.log_dir, PathBuf::from("/tmp/scratch/data/logs"));
}

#[test]
fn the_launch_agent_restarts_on_failure_only_and_is_throttled() {
    let plist = launchd::render(&spec("/opt/homebrew/bin/memoar", "/tmp/a&b")).unwrap();
    assert!(
        plist.contains("<string>dev.memoar.test-1</string>"),
        "{plist}"
    );
    assert!(plist.contains("<string>/opt/homebrew/bin/memoar</string>"));
    assert!(
        plist.contains("<string>/tmp/a&amp;b/config dir</string>"),
        "escaped"
    );
    assert!(plist.contains("<key>RunAtLoad</key>\n  <true/>"));
    // Restarted after a crash or a non-zero exit, left alone after exit 0,
    // which is how the service says "retrying cannot fix this".
    assert!(plist.contains(
        "<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>"
    ));
    assert!(plist.contains("<key>ThrottleInterval</key>\n  <integer>30</integer>"));
    // Joined with the host's separator, which is `\` on a Windows runner.
    let stdio = Path::new("/tmp/a&amp;b/data/logs").join("launchd.log");
    assert!(plist.contains(&format!("<string>{}</string>", stdio.display())));
    assert_eq!(
        launchd::definition_path(Path::new("/Users/x"), "test-1"),
        PathBuf::from("/Users/x/Library/LaunchAgents/dev.memoar.test-1.plist")
    );
}

#[test]
fn launchctl_print_is_read_for_state_pid_and_last_exit() {
    let text = "gui/501/dev.memoar.agent = {\n\tactive count = 1\n\tpath = /x.plist\n\tstate = running\n\n\tprogram = /bin/memoar\n\tpid = 4242\n\tlast exit code = 5\n}\n";
    let query = launchd::parse_print(text, true);
    assert_eq!(query.running, Some(true));
    assert_eq!(query.pid, Some(4242));
    assert!(query.detail.contains("last exit 5"), "{}", query.detail);
    let stopped = launchd::parse_print("\tstate = not running\n\tlast exit code = 0\n", true);
    assert_eq!(stopped.running, Some(false));
    assert_eq!(stopped.pid, None);
}

#[test]
fn the_systemd_unit_restarts_on_failure_and_never_on_a_refusal() {
    let unit = systemd::render(&spec("/home/x/.local/bin/memoar", "/tmp/100%")).unwrap();
    assert!(
        unit.contains("ExecStart=\"/home/x/.local/bin/memoar\" \"service\" \"run\""),
        "{unit}"
    );
    assert!(
        unit.contains("\"/tmp/100%%/config dir\""),
        "specifiers are escaped: {unit}"
    );
    assert!(unit.contains("Restart=on-failure\n"));
    assert!(unit.contains("RestartSec=30\n"));
    assert!(unit.contains("RestartPreventExitStatus=2 3 5\n"));
    assert!(unit.contains("StartLimitIntervalSec=0\n"));
    assert!(unit.contains("WantedBy=default.target\n"));
    assert!(unit.contains("WorkingDirectory=/tmp/100%%/data\n"));
    assert_eq!(systemd::quote("a\"b\\c$d"), "\"a\\\"b\\\\c$$d\"");
}

/// Unix only: `/xdg` is not an absolute path on Windows.
#[cfg(unix)]
#[test]
fn the_unit_goes_where_xdg_says_when_it_says_it_absolutely() {
    assert_eq!(
        systemd::unit_dir(Path::new("/home/x"), Some("/xdg".into())),
        PathBuf::from("/xdg/systemd/user")
    );
    assert_eq!(
        systemd::unit_dir(Path::new("/home/x"), Some("relative".into())),
        PathBuf::from("/home/x/.config/systemd/user"),
        "a relative XDG_CONFIG_HOME is ignored, as the specification says"
    );
}

#[test]
fn systemctl_show_is_read_and_a_pending_restart_counts_as_running() {
    let active = systemd::parse_show(
        "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=77\nExecMainStatus=0\n",
        true,
    );
    assert_eq!((active.running, active.pid), (Some(true), Some(77)));
    let restarting = systemd::parse_show(
        "LoadState=loaded\nActiveState=activating\nSubState=auto-restart\nMainPID=0\nExecMainStatus=9\n",
        true,
    );
    assert_eq!((restarting.running, restarting.pid), (Some(true), None));
    let failed = systemd::parse_show(
        "LoadState=loaded\nActiveState=failed\nSubState=failed\nMainPID=0\nExecMainStatus=9\n",
        true,
    );
    assert_eq!(failed.running, Some(false));
    assert!(failed.detail.contains("last exit 9"), "{}", failed.detail);
    let missing = systemd::parse_show("LoadState=not-found\nActiveState=inactive\n", false);
    assert_eq!((missing.loaded, missing.running), (false, Some(false)));
}

#[test]
fn the_scheduled_task_starts_at_logon_hidden_and_restarts() {
    // Built by hand: a Windows path is not absolute to the host running this.
    let spec = ServiceSpec {
        name: "test-1".to_owned(),
        program: PathBuf::from("C:\\Users\\Ann Lee\\memoar.exe"),
        arguments: ["service", "run", "--name", "test-1", "--config-dir"]
            .into_iter()
            .map(str::to_owned)
            .chain(["C:\\Users\\Ann Lee\\config dir".to_owned()])
            .collect(),
        data_dir: PathBuf::from("C:\\Users\\Ann Lee\\data"),
        log_dir: PathBuf::from("C:\\Users\\Ann Lee\\data\\logs"),
    };
    let xml = schtasks::render(
        &spec,
        "PC\\ann",
        Some(Path::new("C:\\Windows\\System32\\conhost.exe")),
    )
    .unwrap();
    assert!(xml.contains("<URI>\\Memoar\\test-1</URI>"), "{xml}");
    assert!(
        xml.contains(
            "<LogonTrigger>\n      <Enabled>true</Enabled>\n      <UserId>PC\\ann</UserId>"
        )
    );
    assert!(xml.contains("<LogonType>InteractiveToken</LogonType>"));
    assert!(xml.contains("<RunLevel>LeastPrivilege</RunLevel>"));
    assert!(xml.contains("<RestartOnFailure>\n      <Interval>PT1M</Interval>"));
    assert!(xml.contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"));
    assert!(xml.contains("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>"));
    // The console host runs without a window, so nothing flashes at logon.
    assert!(xml.contains("<Command>C:\\Windows\\System32\\conhost.exe</Command>"));
    assert!(xml.contains(
        "<Arguments>--headless &quot;C:\\Users\\Ann Lee\\memoar.exe&quot; service run --name test-1 --config-dir &quot;C:\\Users\\Ann Lee\\config dir&quot;</Arguments>"
    ), "{xml}");
    assert!(xml.contains("<WorkingDirectory>C:\\Users\\Ann Lee\\data</WorkingDirectory>"));
    let direct = schtasks::render(&spec, "PC\\ann", None).unwrap();
    assert!(direct.contains("<Command>C:\\Users\\Ann Lee\\memoar.exe</Command>"));
    let bytes = schtasks::utf16_with_bom("<a/>");
    assert_eq!(&bytes[..4], &[0xFF, 0xFE, b'<', 0]);
}

#[test]
fn windows_arguments_are_quoted_the_way_argv_splits_them() {
    assert_eq!(schtasks::quote("plain"), "plain");
    assert_eq!(schtasks::quote(""), "\"\"");
    assert_eq!(schtasks::quote("a b"), "\"a b\"");
    assert_eq!(
        schtasks::quote("C:\\dir with space\\"),
        "\"C:\\dir with space\\\\\""
    );
    assert_eq!(schtasks::quote("say \"hi\""), "\"say \\\"hi\\\"\"");
    assert_eq!(schtasks::quote("a\\\"b c"), "\"a\\\\\\\"b c\"");
}

#[test]
fn service_names_are_one_string_on_every_platform() {
    for good in ["agent", "test-1", "0x"] {
        assert_eq!(validate_name(good).unwrap(), good);
    }
    for bad in ["", "-x", "Agent", "a b", "a.b", "a/b", &"x".repeat(41)] {
        assert!(validate_name(bad).is_err(), "{bad:?} was accepted");
    }
}

/// The guard that keeps a scratch install from taking over the real service
/// matches whole arguments only.
#[test]
fn a_definition_belongs_to_the_configuration_it_names_exactly() {
    let plist = launchd::render(&spec("/bin/memoar", "/tmp/a")).unwrap();
    assert!(crate::service::owner::names_config_dir(
        &plist,
        "/tmp/a/config dir"
    ));
    assert!(!crate::service::owner::names_config_dir(
        &plist,
        "/tmp/a/config d"
    ));
    let unit = systemd::render(&spec("/bin/memoar", "/tmp/a")).unwrap();
    assert!(crate::service::owner::names_config_dir(
        &unit,
        "/tmp/a/config dir"
    ));
    assert!(!crate::service::owner::names_config_dir(
        &unit,
        "/tmp/a/config di"
    ));
}

#[test]
fn a_binary_an_upgrade_will_not_replace_is_called_out() {
    assert!(
        program_note(Path::new(
            "/home/x/.cache/memoar/0.3.0/memoar-x86_64/memoar"
        ))
        .is_some()
    );
    assert!(program_note(Path::new("/home/x/.local/bin/memoar")).is_none());
}
