//! The almyty colours, in as many colours as the terminal has.
//!
//! Truecolor where the terminal says it has it (`COLORTERM`, or Windows
//! Terminal), the nearest of the 256 xterm colours where `TERM` says so, and
//! the nearest of the 16 ANSI colours otherwise, which every console has.
//! Light or dark follows `COLORFGBG` where the terminal sets it, else dark.

use ratatui::style::Color;
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Depth {
    True,
    Ansi256,
    Ansi16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Theme {
    pub(crate) depth: Depth,
    pub(crate) dark: bool,
}

/// What tests and an undecided start see: truecolor on dark.
pub(crate) const DEFAULT: Theme = Theme {
    depth: Depth::True,
    dark: true,
};

static THEME: OnceLock<Theme> = OnceLock::new();

pub(crate) fn theme() -> Theme {
    *THEME.get().unwrap_or(&DEFAULT)
}

/// Reads the environment once, at start.
pub(crate) fn choose_theme() {
    let variable = |name: &str| std::env::var(name).unwrap_or_default();
    let _ = THEME.set(detect(
        &variable("COLORTERM"),
        &variable("TERM"),
        std::env::var_os("WT_SESSION").is_some(),
        &variable("COLORFGBG"),
    ));
}

/// Anything that does not say it has more gets 16 colours, the Windows
/// console host included: an older one turns truecolor into noise.
pub(crate) fn detect(
    colorterm: &str,
    term: &str,
    windows_terminal: bool,
    colorfgbg: &str,
) -> Theme {
    let depth = if matches!(colorterm, "truecolor" | "24bit") || windows_terminal {
        Depth::True
    } else if term.contains("256") {
        Depth::Ansi256
    } else {
        Depth::Ansi16
    };
    // "15;0" is light text on a dark background. The last field is the
    // background, 7 and 15 being the light greys and white.
    let dark = !matches!(colorfgbg.rsplit(';').next(), Some("7" | "15"));
    Theme { depth, dark }
}

/// A colour for this terminal. `fallback` is the ANSI colour to use with 16,
/// chosen by hand: the nearest by distance is often the wrong hue.
pub(crate) fn rgb(hex: u32, fallback: Color) -> Color {
    let (red, green, blue) = ((hex >> 16) as u8, (hex >> 8) as u8, hex as u8);
    match theme().depth {
        Depth::True => Color::Rgb(red, green, blue),
        Depth::Ansi256 => Color::Indexed(nearest_256(red, green, blue)),
        Depth::Ansi16 => fallback,
    }
}

/// The light value on a light background, the dark value on a dark one.
pub(crate) fn pick(light: u32, dark: u32, fallback: Color) -> Color {
    rgb(if theme().dark { dark } else { light }, fallback)
}

/// The nearest colour in the xterm 6x6x6 cube or its grey ramp.
pub(crate) fn nearest_256(red: u8, green: u8, blue: u8) -> u8 {
    const STEPS: [u8; 6] = [0, 95, 135, 175, 215, 255];
    let step = |value: u8| {
        STEPS
            .iter()
            .enumerate()
            .min_by_key(|(_, step)| (i32::from(**step) - i32::from(value)).abs())
            .map_or(0, |(index, _)| index as u8)
    };
    let (r, g, b) = (step(red), step(green), step(blue));
    let cube = 16 + 36 * r + 6 * g + b;
    let distance = |x: u8, y: u8, z: u8| {
        let d = |a: u8, b: u8| (i32::from(a) - i32::from(b)).pow(2);
        d(x, red) + d(y, green) + d(z, blue)
    };
    let cube_distance = distance(STEPS[r as usize], STEPS[g as usize], STEPS[b as usize]);
    let average = (u16::from(red) + u16::from(green) + u16::from(blue)) / 3;
    let grey_index = ((average.saturating_sub(8)) / 10).min(23) as u8;
    let grey = 8 + 10 * grey_index;
    if distance(grey, grey, grey) < cube_distance {
        232 + grey_index
    } else {
        cube
    }
}

/// almyty blue: focus, selection and the primary action.
pub(crate) fn accent() -> Color {
    pick(0x1469EC, 0x7AB5FF, Color::Blue)
}

/// The start of the logo's gradient, for the thread glyph.
pub(crate) fn brand() -> Color {
    rgb(0x2775F7, Color::Blue)
}

pub(crate) fn selection_surface() -> Color {
    pick(0xEBF3FF, 0x203A5F, Color::Blue)
}

pub(crate) fn selection_text() -> Color {
    pick(0x185FCA, 0xB7D5FF, Color::White)
}

/// The inset surface, behind a selected row in a pane without the keys.
pub(crate) fn inset() -> Color {
    pick(0xEFF3F8, 0x1D2B42, Color::DarkGray)
}

pub(crate) fn success() -> (Color, Option<Color>) {
    (
        pick(0x276C52, 0x86DBB4, Color::Green),
        surface(0xEAF9F1, 0x15392E),
    )
}

pub(crate) fn danger() -> (Color, Option<Color>) {
    (
        pick(0xB72E35, 0xFFB3BC, Color::Red),
        surface(0xFFF0F0, 0x47232A),
    )
}

/// A tinted line background, only where there are enough colours for one to
/// be a tint rather than a block of solid colour.
fn surface(light: u32, dark: u32) -> Option<Color> {
    (theme().depth != Depth::Ansi16).then(|| pick(light, dark, Color::Reset))
}

/// The colour of an agent's mark, by source id.
pub(crate) fn agent(source: &str) -> Color {
    let (hex, fallback) = match source {
        "claude-code" | "claude" => (0xE0865F, Color::LightRed),
        "codex" => (if theme().dark { 0x9AA3B5 } else { 0x2B2F36 }, Color::Gray),
        id if id.starts_with("antigravity") || id.starts_with("gemini") => {
            (0x5B8DEF, Color::LightBlue)
        }
        "cursor" => (0x8A94A6, Color::Gray),
        "opencode" => (0x2FBF8F, Color::Green),
        "copilot" => (0xC26BE0, Color::Magenta),
        other => {
            // Distinct mid-saturation hues, the same one for an id every time.
            const OTHERS: [(u32, Color); 6] = [
                (0xD9A441, Color::Yellow),
                (0x4FB3D9, Color::Cyan),
                (0xE06C9F, Color::LightMagenta),
                (0xA3C45A, Color::LightGreen),
                (0xE07A5F, Color::LightRed),
                (0x6FA8DC, Color::LightBlue),
            ];
            let index = other.bytes().fold(0_usize, |sum, byte| {
                sum.wrapping_mul(31).wrapping_add(byte.into())
            });
            OTHERS[index % OTHERS.len()]
        }
    };
    rgb(hex, fallback)
}
