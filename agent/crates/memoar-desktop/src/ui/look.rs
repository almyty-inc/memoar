//! How the window looks on each desktop.
//!
//! One layout, three sets of tokens: macOS (AppKit's greys and system blue),
//! Windows 11 (Fluent's neutrals, accent and control sizes) and GNOME
//! (libadwaita's palette and sizes). Each color has a light and a dark value,
//! and NSH draws the one of the appearance the system reports, live.
//!
//! NSH 0.2.0 does not hand the app the system's accent color or a material
//! behind the window (vibrancy, Mica), so each desktop gets its default accent
//! and an opaque window in its own background color.

use nsh_core::platform::Os;
use nsh_core::ui::AdaptiveColor;
use nsh_core::ui::prelude::*;

/// How a focused field shows its focus.
#[derive(Clone, Copy)]
pub(crate) enum Focus {
    /// A soft ring around it, as AppKit and GTK draw.
    Ring(f32),
    /// An accent line along its bottom edge, as Fluent draws.
    Underline,
}

pub(crate) struct Look {
    /// The window's background.
    pub page: AdaptiveColor,
    /// Grouped lists and fields, a step off the page.
    pub group: AdaptiveColor,
    pub line: AdaptiveColor,
    pub hover: AdaptiveColor,
    /// A switch's track when it is off.
    pub fill: AdaptiveColor,
    pub text: AdaptiveColor,
    pub text_2: AdaptiveColor,
    pub accent: AdaptiveColor,
    pub accent_hover: AdaptiveColor,
    pub accent_text: AdaptiveColor,
    pub danger: AdaptiveColor,
    pub warning: AdaptiveColor,
    pub ok: AdaptiveColor,
    /// Corner radius of controls and of grouped lists.
    pub radius: f32,
    pub group_radius: f32,
    pub control: f32,
    /// The height of the title bar the app draws under the window controls.
    pub header: f32,
    /// GNOME centres a window's title, macOS and Windows set it at the start.
    pub centred_title: bool,
    pub focus: Focus,
    /// A switch's track, width and height.
    pub switch: (f32, f32),
    /// `None` keeps the toolkit's own UI font.
    pub font: Option<&'static str>,
    pub mono: &'static str,
}

const MACOS: Look = Look {
    page: AdaptiveColor::rgb(0xf5f5f7, 0x1c1c1e),
    group: AdaptiveColor::rgb(0xffffff, 0x2a2a2d),
    line: AdaptiveColor::rgb(0xe3e3e7, 0x3a3a3e),
    hover: AdaptiveColor::rgb(0xececef, 0x36363a),
    fill: AdaptiveColor::rgb(0xdcdce0, 0x48484c),
    text: AdaptiveColor::rgb(0x1d1d1f, 0xf2f2f4),
    text_2: AdaptiveColor::rgb(0x5c5c66, 0xa8a8b0),
    accent: AdaptiveColor::rgb(0x0064e0, 0x0a84ff),
    accent_hover: AdaptiveColor::rgb(0x0058c7, 0x3396ff),
    accent_text: AdaptiveColor::rgb(0xffffff, 0xffffff),
    danger: AdaptiveColor::rgb(0xc92a2a, 0xff6b6b),
    warning: AdaptiveColor::rgb(0xa6620a, 0xf0a541),
    ok: AdaptiveColor::rgb(0x2b8a3e, 0x51cf66),
    radius: 6.0,
    group_radius: 8.0,
    control: 28.0,
    header: 38.0,
    centred_title: false,
    focus: Focus::Ring(3.0),
    switch: (32.0, 18.0),
    font: None,
    mono: "ui-monospace",
};

const WINDOWS: Look = Look {
    page: AdaptiveColor::rgb(0xf3f3f3, 0x202020),
    group: AdaptiveColor::rgb(0xfbfbfb, 0x2b2b2b),
    line: AdaptiveColor::rgb(0xe5e5e5, 0x3b3b3b),
    hover: AdaptiveColor::rgb(0xf0f0f0, 0x323232),
    fill: AdaptiveColor::rgb(0x8a8a8a, 0x9a9a9a),
    text: AdaptiveColor::rgb(0x1b1b1b, 0xffffff),
    text_2: AdaptiveColor::rgb(0x5d5d5d, 0xc5c5c5),
    accent: AdaptiveColor::rgb(0x005fb8, 0x60cdff),
    accent_hover: AdaptiveColor::rgb(0x1a6fbf, 0x5bbbe9),
    accent_text: AdaptiveColor::rgb(0xffffff, 0x000000),
    danger: AdaptiveColor::rgb(0xc42b1c, 0xff99a4),
    warning: AdaptiveColor::rgb(0x9d5d00, 0xfce100),
    ok: AdaptiveColor::rgb(0x0f7b0f, 0x6ccb5f),
    radius: 4.0,
    group_radius: 8.0,
    control: 32.0,
    header: 32.0,
    centred_title: false,
    focus: Focus::Underline,
    switch: (40.0, 20.0),
    font: Some("Segoe UI Variable Text, Segoe UI"),
    mono: "Cascadia Mono, Consolas",
};

const GNOME: Look = Look {
    page: AdaptiveColor::rgb(0xfafafb, 0x222226),
    group: AdaptiveColor::rgb(0xffffff, 0x2e2e32),
    line: AdaptiveColor::rgb(0xe1e1e4, 0x3c3c41),
    hover: AdaptiveColor::rgb(0xececee, 0x38383d),
    fill: AdaptiveColor::rgb(0xd5d5d8, 0x505056),
    text: AdaptiveColor::rgb(0x2e2e33, 0xffffff),
    text_2: AdaptiveColor::rgb(0x5e5e66, 0xb4b4bb),
    accent: AdaptiveColor::rgb(0x2c6fc7, 0x3584e4),
    accent_hover: AdaptiveColor::rgb(0x2a65b4, 0x4a92ea),
    accent_text: AdaptiveColor::rgb(0xffffff, 0xffffff),
    danger: AdaptiveColor::rgb(0xc01c28, 0xff7b63),
    warning: AdaptiveColor::rgb(0x9c6e03, 0xf8e45c),
    ok: AdaptiveColor::rgb(0x1b8553, 0x78e9ab),
    radius: 6.0,
    group_radius: 12.0,
    control: 34.0,
    header: 46.0,
    centred_title: true,
    focus: Focus::Ring(2.0),
    switch: (46.0, 26.0),
    font: None,
    mono: "monospace",
};

/// The look of the desktop this runs on.
pub(crate) fn look() -> &'static Look {
    match os() {
        Os::Windows => &WINDOWS,
        Os::Linux => &GNOME,
        _ => &MACOS,
    }
}

/// A line one device pixel thick, so it is crisp at any scale.
pub(crate) fn hair() -> f32 {
    1.0 / pixel_ratio().max(1.0)
}

/// How long a state change animates: none when the system asks for less
/// motion.
pub(crate) fn motion() -> f32 {
    if reduce_motion() { 0.0 } else { 150.0 }
}
