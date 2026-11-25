//! The window's state and the actions its controls start.
//!
//! Every action that reads the disk or the network runs on a blocking thread
//! (`blocking`) and hands its result back to the engine thread, which is the
//! only one that touches signals. The window never waits on the archive.

use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use nsh_core::storage::Storage;
use nsh_core::ui::prelude::*;

use crate::account::{self, Credentials};
use crate::browser;
use crate::capture::{self, LastRun, Redaction, State, Status};
use crate::failure::Failure;
use crate::paths::Paths;
use crate::schedule::{self, Gate, Mode};

/// Where the window keeps what it knows across restarts.
const LAST_RUN_KEY: &str = "memoar.desktop.lastRun";
const PAUSED_KEY: &str = "memoar.desktop.paused";
const WEB_URL_KEY: &str = "memoar.desktop.webUrl";
/// How often the status is read again, so "last capture" keeps its meaning
/// and a capture by the CLI on the same machine shows up.
const REFRESH: Duration = Duration::from_secs(15);

#[derive(Clone)]
struct Engine {
    paths: Paths,
    state: Arc<State>,
}

#[derive(Clone, Copy)]
pub(crate) struct Controller {
    engine: Stored<Option<Engine>>,
    /// `None` until the first read of this machine's configuration.
    pub status: Signal<Option<Status>>,
    pub busy: Signal<bool>,
    pub signing_in: Signal<bool>,
    pub sign_in_error: Signal<Option<Failure>>,
    pub paused: Signal<bool>,
    /// A failure of something other than capture: the browser, a setting.
    pub notice: Signal<Option<String>>,
    pub now: Signal<DateTime<Utc>>,
    /// The home directory could not be resolved, so there is nothing to run.
    pub fatal: Signal<Option<String>>,
    /// The web app's address when it differs from the API's origin.
    pub web_url: Signal<String>,
}

fn load_last_run() -> LastRun {
    Storage::get_item(LAST_RUN_KEY)
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

impl Controller {
    pub(crate) fn new() -> Self {
        let (engine, fatal) = match Paths::resolve() {
            Ok(paths) => {
                let state = Arc::new(State::with_last_run(load_last_run()));
                (Some(Engine { paths, state }), None)
            }
            Err(error) => (None, Some(error)),
        };
        Self {
            engine: stored(engine),
            status: signal(None),
            busy: signal(false),
            signing_in: signal(false),
            sign_in_error: signal(None),
            paused: signal(Storage::get_item(PAUSED_KEY).as_deref() == Some("true")),
            notice: signal(None),
            now: signal(Utc::now()),
            fatal: signal(fatal),
            web_url: signal(Storage::get_item(WEB_URL_KEY).unwrap_or_default()),
        }
    }

    pub(crate) fn gate(self) -> Gate {
        Gate {
            signed_in: self.status.get().is_some_and(|status| status.signed_in),
            paused: self.paused.get(),
            busy: self.busy.get(),
        }
    }

    pub(crate) fn last_error(self) -> Option<Failure> {
        self.status.get().and_then(|status| status.last_error)
    }

    pub(crate) fn mode(self) -> Mode {
        schedule::mode(self.gate(), self.last_error().as_ref())
    }

    pub(crate) fn can_capture(self) -> bool {
        schedule::manual(self.gate(), self.last_error().as_ref())
    }

    /// Runs `work` off the engine thread and gives its result to `done` on it.
    fn background<R: Send + 'static>(
        self,
        work: impl FnOnce(&Engine) -> R + Send + 'static,
        done: impl FnOnce(R) + 'static,
    ) {
        let Some(engine) = self.engine.get() else {
            return;
        };
        spawn(async move {
            match blocking(move || work(&engine)).await {
                Ok(result) => done(result),
                Err(error) => {
                    self.busy.set(false);
                    self.signing_in.set(false);
                    self.notice
                        .set(Some(format!("A background task failed: {error}")));
                }
            }
        });
    }

    fn persist(self) {
        if let Some(engine) = self.engine.get()
            && let Ok(raw) = serde_json::to_string(&engine.state.last_run())
        {
            let _ = Storage::set_item(LAST_RUN_KEY, raw);
        }
    }

    /// Reads the status, captures if due, and keeps both going.
    pub(crate) fn start(self) {
        self.background(
            |engine| capture::status(&engine.paths, &engine.state),
            move |status| {
                self.status.set(Some(status));
                self.capture_if_due();
            },
        );
        spawn(async move {
            loop {
                timer(schedule::INTERVAL).await;
                self.capture_if_due();
            }
        });
        spawn(async move {
            loop {
                timer(REFRESH).await;
                self.now.set(Utc::now());
                self.refresh();
            }
        });
    }

    /// Reads the status again. Skipped during a capture, whose own result is
    /// newer than anything a read started now could return.
    pub(crate) fn refresh(self) {
        if self.busy.get() || self.signing_in.get() {
            return;
        }
        self.background(
            |engine| capture::status(&engine.paths, &engine.state),
            move |status| {
                if !self.busy.get() {
                    self.status.set(Some(status));
                }
            },
        );
    }

    fn capture_if_due(self) {
        if schedule::automatic(self.gate(), self.last_error().as_ref()) {
            self.capture();
        }
    }

    pub(crate) fn capture(self) {
        if !self.can_capture() {
            return;
        }
        self.busy.set(true);
        self.background(
            |engine| {
                // The failure, if any, is kept in the state and comes back in
                // the status read right after.
                let _ = capture::sync_now(&engine.paths, &engine.state, &Utc::now().to_rfc3339());
                capture::status(&engine.paths, &engine.state)
            },
            move |status| {
                self.status.set(Some(status));
                self.now.set(Utc::now());
                self.busy.set(false);
                self.persist();
            },
        );
    }

    /// Signs in. `web_url` is where the web app lives when the API does not
    /// serve it, kept on this machine only, and empty to derive it.
    pub(crate) fn sign_in(self, endpoint: String, credentials: Credentials, web_url: String) {
        if self.signing_in.get() {
            return;
        }
        self.signing_in.set(true);
        self.sign_in_error.set(None);
        self.background(
            move |engine| account::sign_in(&engine.paths, &engine.state, &endpoint, &credentials),
            move |result| {
                self.signing_in.set(false);
                match result {
                    Ok(status) => {
                        let web_url = web_url.trim().to_owned();
                        let _ = Storage::set_item(WEB_URL_KEY, web_url.clone());
                        self.web_url.set(web_url);
                        self.status.set(Some(status));
                        self.persist();
                        self.capture();
                    }
                    Err(failure) => self.sign_in_error.set(Some(failure)),
                }
            },
        );
    }

    pub(crate) fn sign_out(self) {
        self.background(
            |engine| account::sign_out(&engine.paths, &engine.state),
            move |result| match result {
                Ok(status) => {
                    self.sign_in_error.set(None);
                    self.status.set(Some(status));
                    self.persist();
                }
                Err(failure) => self.notice.set(Some(failure.message)),
            },
        );
    }

    pub(crate) fn toggle_pause(self) {
        let paused = !self.paused.get();
        self.paused.set(paused);
        let _ = Storage::set_item(PAUSED_KEY, paused.to_string());
        if !paused {
            self.capture_if_due();
        }
    }

    pub(crate) fn set_redaction(self, redaction: Redaction) {
        self.background(
            move |engine| capture::set_redaction(&engine.paths, &engine.state, redaction),
            move |result| match result {
                Ok(status) => self.status.set(Some(status)),
                Err(failure) => self.notice.set(Some(failure.message)),
            },
        );
    }

    /// Where "Open web app" goes, `None` before this machine has an endpoint.
    pub(crate) fn web_app(self) -> Option<String> {
        let endpoint = self.status.get().and_then(|status| status.endpoint)?;
        Some(capture::web_app_url(&self.web_url.get(), &endpoint))
    }

    pub(crate) fn open_web_app(self) {
        let Some(url) = self.web_app() else {
            return;
        };
        self.background(
            move |_| browser::open(&url),
            move |result| {
                if let Err(message) = result {
                    self.notice.set(Some(message));
                }
            },
        );
    }
}
