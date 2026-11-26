//! How the window looks: almyty's tokens, light and dark, on every desktop,
//! and what each desktop's own window chrome needs.
//!
//! The colours are the same everywhere, as the brand is. What differs is the
//! title bar: its height under the traffic lights, Windows' caption buttons
//! or GTK's window controls, and whether the title sits at the start
//! (macOS, Windows) or in the middle (GNOME). Each colour has a light and a
//! dark value and NSH draws the one of the appearance the system reports.
//!
//! NSH 0.2.0 hands the app neither the system's accent nor a material behind
//! the window (vibrancy, Mica), so the window draws almyty's product field
//! itself.

use nsh_core::platform::Os;
use nsh_core::ui::AdaptiveColor;
use nsh_core::ui::prelude::*;

pub(crate) struct Look {
    /// The surround: the product field gradient behind the card.
    pub field: [AdaptiveColor; 3],
    /// The card the screens sit on.
    pub canvas: AdaptiveColor,
    /// Wells: the segmented control, a switch's track when off.
    pub inset: AdaptiveColor,
    pub rule: AdaptiveColor,
    pub text: AdaptiveColor,
    pub text_2: AdaptiveColor,
    pub primary: AdaptiveColor,
    pub primary_hover: AdaptiveColor,
    pub on_primary: AdaptiveColor,
    pub danger: AdaptiveColor,
    pub warning: AdaptiveColor,
    pub ok: AdaptiveColor,
    /// The height of the title bar the app draws under the window controls.
    pub header: f32,
    /// GNOME centres a window's title, macOS and Windows set it at the start.
    pub centred_title: bool,
}

const BRAND: Look = Look {
    field: [
        AdaptiveColor::rgb(0xeaf1ff, 0x172d53),
        AdaptiveColor::rgb(0xe5f8ff, 0x173b4b),
        AdaptiveColor::rgb(0xe6fcf1, 0x17382e),
    ],
    canvas: AdaptiveColor::rgb(0xffffff, 0x162235),
    inset: AdaptiveColor::rgb(0xeff3f8, 0x1d2b42),
    rule: AdaptiveColor::rgb(0xe6ebf2, 0x2a3a52),
    text: AdaptiveColor::rgb(0x141e30, 0xedf3fc),
    text_2: AdaptiveColor::rgb(0x5c6980, 0xacbad0),
    primary: AdaptiveColor::rgb(0x1469ec, 0x7ab5ff),
    primary_hover: AdaptiveColor::rgb(0x105bd0, 0x96c4ff),
    on_primary: AdaptiveColor::rgb(0xffffff, 0x0d2440),
    danger: AdaptiveColor::rgb(0xb72e35, 0xffb3bc),
    warning: AdaptiveColor::rgb(0x9a5b00, 0xf5c36b),
    ok: AdaptiveColor::rgb(0x276c52, 0x86dbb4),
    header: 40.0,
    centred_title: false,
};

const MACOS: Look = BRAND;
const WINDOWS: Look = Look {
    header: 36.0,
    ..BRAND
};
const GNOME: Look = Look {
    header: 46.0,
    centred_title: true,
    ..BRAND
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
