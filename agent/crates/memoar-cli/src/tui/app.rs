//! Everything the TUI knows, and nothing about how it is drawn.
//!
//! Keys change it through `keys`, answers from the archive through `update`,
//! and `draw` only reads it. That split is what lets a test drive the whole
//! interface without a terminal.

use serde_json::Value;
use std::cell::Cell;
use std::collections::HashMap;

use super::model::SessionRow;
use super::render::Memo;
use crate::error::AppError;

/// The targets `convert --here` can write, in the order they are offered.
pub(crate) const TARGETS: [(&str, &str); 3] = [
    ("claude-code", "Claude Code"),
    ("codex", "Codex"),
    ("antigravity-cli", "Antigravity CLI"),
];

/// What has the keys. Sessions and Search are lists with the selected
/// session previewed beside them. Transcript is that preview, focused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Screen {
    Sessions,
    Search,
    Transcript,
    Status,
}

#[derive(Debug, Default)]
pub(crate) struct SessionList {
    pub(crate) rows: Vec<SessionRow>,
    pub(crate) selected: usize,
    pub(crate) next_cursor: Option<String>,
    pub(crate) total: Option<u64>,
    pub(crate) loading: bool,
    /// When the rows on screen came from the disk cache, the time it was saved.
    pub(crate) cached_at: Option<String>,
    /// The first list line on screen. Drawing moves it just far enough to
    /// keep the selection visible, so the list does not jump while scrolling.
    pub(crate) offset: Cell<usize>,
}

impl SessionList {
    pub(crate) fn current(&self) -> Option<&SessionRow> {
        self.rows.get(self.selected)
    }
}

#[derive(Debug)]
pub(crate) struct Transcript {
    pub(crate) session: SessionRow,
    pub(crate) turns: Vec<Value>,
    pub(crate) next_cursor: Option<String>,
    /// Waiting for a chunk. `requested` says whether it has been asked for:
    /// a preview is asked for only once the selection stops moving.
    pub(crate) loading: bool,
    pub(crate) requested: bool,
    /// The first line on screen, where scrolling is headed.
    pub(crate) scroll: usize,
    /// The first line drawn, which eases toward `scroll` a frame at a time.
    pub(crate) shown: Cell<f32>,
    pub(crate) error: Option<String>,
    pub(crate) memo: Memo,
}

impl Transcript {
    /// The turns as lines at this width, from the memo when nothing changed.
    pub(crate) fn rendered(&self, columns: u16, show_thinking: bool) -> super::render::Rendered {
        let agent = super::render::Agent {
            source: &self.session.source,
            label: &self.session.source_label,
        };
        self.memo.get(&self.turns, &agent, columns, show_thinking)
    }

    pub(crate) fn pending(session: SessionRow) -> Self {
        Self {
            session,
            turns: Vec::new(),
            next_cursor: None,
            loading: true,
            requested: false,
            scroll: 0,
            shown: Cell::new(0.0),
            error: None,
            memo: Memo::default(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SearchFocus {
    Input,
    Results,
}

#[derive(Debug)]
pub(crate) struct Search {
    pub(crate) input: String,
    pub(crate) focus: SearchFocus,
    pub(crate) results: SessionList,
    /// The query the results answer, which is not always what is typed.
    pub(crate) query: Option<String>,
    pub(crate) realized_mode: Option<String>,
    pub(crate) error: Option<String>,
}

impl Default for Search {
    fn default() -> Self {
        Self {
            input: String::new(),
            focus: SearchFocus::Input,
            results: SessionList::default(),
            query: None,
            realized_mode: None,
            error: None,
        }
    }
}

#[derive(Debug, Default)]
pub(crate) struct Status {
    pub(crate) data: Option<Value>,
    pub(crate) loading: bool,
    pub(crate) error: Option<String>,
}

/// Something drawn over the current screen that takes the keys until closed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Overlay {
    Palette {
        input: String,
        selected: usize,
    },
    ConvertPicker {
        session_id: String,
        title: String,
        selected: usize,
    },
    Message {
        title: String,
        lines: Vec<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NoticeKind {
    Info,
    Error,
}

/// One line above the status bar: what just happened, or what went wrong.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Notice {
    pub(crate) kind: NoticeKind,
    pub(crate) text: String,
}

#[derive(Debug)]
pub(crate) struct App {
    /// The screens behind the current one. Sessions is always at the bottom,
    /// and leaving it quits.
    pub(crate) stack: Vec<Screen>,
    pub(crate) sessions: SessionList,
    pub(crate) machines: HashMap<String, String>,
    /// The session previewed beside the list, or read in full.
    pub(crate) transcript: Option<Transcript>,
    /// Transcripts read or previewed earlier in this run, so going back to
    /// one is instant and works without the archive.
    pub(crate) viewed: HashMap<String, Transcript>,
    pub(crate) search: Search,
    pub(crate) status: Status,
    pub(crate) overlay: Option<Overlay>,
    pub(crate) notice: Option<Notice>,
    pub(crate) show_thinking: bool,
    /// The last request to the archive failed for want of a connection.
    pub(crate) offline: bool,
    /// Conversions still running, by session id.
    pub(crate) converting: Vec<String>,
    /// The selection moved and its preview has not been asked for yet.
    pub(crate) preview_pending: bool,
    /// Where the archive is, for the status bar.
    pub(crate) endpoint: String,
    /// The terminal's size, set before every frame. Keys need it to know how
    /// far a page is.
    pub(crate) width: u16,
    pub(crate) height: u16,
    pub(crate) quit: bool,
}

impl App {
    pub(crate) fn new(endpoint: impl Into<String>) -> Self {
        Self {
            stack: vec![Screen::Sessions],
            sessions: SessionList {
                loading: true,
                ..SessionList::default()
            },
            machines: HashMap::new(),
            transcript: None,
            viewed: HashMap::new(),
            search: Search::default(),
            status: Status::default(),
            overlay: None,
            notice: None,
            show_thinking: false,
            offline: false,
            converting: Vec::new(),
            preview_pending: false,
            endpoint: endpoint.into(),
            width: 120,
            height: 32,
            quit: false,
        }
    }

    pub(crate) fn screen(&self) -> Screen {
        *self.stack.last().unwrap_or(&Screen::Sessions)
    }

    /// The list beside the transcript: search results when the reader came
    /// from a search, else the session list.
    pub(crate) fn list_screen(&self) -> Screen {
        self.stack
            .iter()
            .rev()
            .copied()
            .find(|screen| matches!(screen, Screen::Sessions | Screen::Search))
            .unwrap_or(Screen::Sessions)
    }

    pub(crate) fn list(&self) -> &SessionList {
        match self.list_screen() {
            Screen::Search => &self.search.results,
            _ => &self.sessions,
        }
    }

    pub(crate) fn list_mut(&mut self) -> &mut SessionList {
        match self.list_screen() {
            Screen::Search => &mut self.search.results,
            _ => &mut self.sessions,
        }
    }

    pub(crate) fn push(&mut self, screen: Screen) {
        if self.screen() != screen {
            self.stack.push(screen);
        }
    }

    /// Back one screen, or quit from the session list.
    pub(crate) fn back(&mut self) {
        if self.stack.len() > 1 {
            self.stack.pop();
        } else {
            self.quit = true;
        }
    }

    pub(crate) fn info(&mut self, text: impl Into<String>) {
        self.notice = Some(Notice {
            kind: NoticeKind::Info,
            text: text.into(),
        });
    }

    /// Shows a failed request. A transport failure marks the TUI offline,
    /// which is what tells the reader the rows on screen may be old.
    pub(crate) fn fail(&mut self, error: &AppError) {
        let text = if is_offline(error) {
            self.offline = true;
            // The transport detail is long. What it means goes first.
            format!(
                "The archive cannot be reached, so this shows what is cached. {}",
                error.message
            )
        } else if error.hint.is_empty() {
            error.message.clone()
        } else {
            format!("{} {}", error.message, error.hint)
        };
        self.notice = Some(Notice {
            kind: NoticeKind::Error,
            text,
        });
    }

    /// The session the actions work on: the one previewed or read.
    pub(crate) fn focused_session(&self) -> Option<&SessionRow> {
        match self.screen() {
            Screen::Status => None,
            Screen::Transcript => self.transcript.as_ref().map(|view| &view.session),
            _ => self.list().current(),
        }
    }
}

/// The archive did not answer, as opposed to answering no.
pub(crate) fn is_offline(error: &AppError) -> bool {
    error.http_status.is_none() && error.kind == "network"
}
