//! Agent marks: a rounded square in the agent's colour with a two-letter
//! monogram, never a vendor's logo. The colours are the web app's.

use nsh_core::ui::prelude::*;
use nsh_core::ui::{AdaptiveColor, FontWeight};

/// An agent's monogram, its colour, and the colour of the letters on it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Agent {
    pub monogram: &'static str,
    pub color: AdaptiveColor,
    pub ink: AdaptiveColor,
}

const WHITE: AdaptiveColor = AdaptiveColor::rgb(0xffffff, 0xffffff);

const fn agent(monogram: &'static str, light: u32, dark: u32) -> Agent {
    Agent {
        monogram,
        color: AdaptiveColor::rgb(light, dark),
        ink: WHITE,
    }
}

/// Distinct mid-saturation hues for agents without a colour of their own.
const OTHERS: [u32; 6] = [0xd4a52c, 0x3fa7c4, 0xd0607a, 0x6f8f3a, 0x9a7bd0, 0xc97a3a];

/// The mark of the agent a source's display name names.
pub(crate) fn of(name: &str) -> Agent {
    match name {
        "Claude Code" => agent("CC", 0xe0865f, 0xe0865f),
        "Codex CLI" | "Codex" => Agent {
            monogram: "CX",
            color: AdaptiveColor::rgb(0x2b2f36, 0x9aa3b5),
            ink: AdaptiveColor::rgb(0xffffff, 0x101827),
        },
        "Antigravity CLI" | "Antigravity" => agent("AG", 0x5b8def, 0x5b8def),
        "Cursor" => agent("CU", 0x8a94a6, 0x8a94a6),
        "OpenCode" => agent("OC", 0x2fbf8f, 0x2fbf8f),
        "GitHub Copilot" | "Copilot" => agent("CP", 0xc26be0, 0xc26be0),
        other => {
            let hash = other.bytes().fold(0_usize, |h, b| {
                h.wrapping_mul(31).wrapping_add(usize::from(b))
            });
            let color = OTHERS[hash % OTHERS.len()];
            agent("", color, color)
        }
    }
}

/// Two letters for a name without a monogram of its own: the initials of
/// its first two words, or its first two letters.
fn initials(name: &str) -> String {
    let words: Vec<&str> = name.split_whitespace().collect();
    let letters: String = match words.as_slice() {
        [first, second, ..] => first
            .chars()
            .take(1)
            .chain(second.chars().take(1))
            .collect(),
        [only] => only.chars().take(2).collect(),
        [] => String::new(),
    };
    letters.to_uppercase()
}

/// The mark of `name` at `size` points.
pub(crate) fn mark(name: &str, size: f32) -> impl IntoElement {
    let agent = of(name);
    let monogram = if agent.monogram.is_empty() {
        initials(name)
    } else {
        agent.monogram.to_owned()
    };
    view()
        .w(px(size))
        .h(px(size))
        .rounded(px(size * 10.0 / 32.0))
        .bg(agent.color)
        .items_center()
        .justify_center()
        .flex_shrink_0()
        .child(
            text(monogram)
                .text_size(px(size * 0.36))
                .font_weight(FontWeight::BOLD)
                .text_color(agent.ink),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_agents_keep_their_colours() {
        assert_eq!(of("Claude Code").monogram, "CC");
        assert_eq!(
            of("Claude Code").color,
            AdaptiveColor::rgb(0xe0865f, 0xe0865f)
        );
        assert_eq!(of("Codex CLI").monogram, "CX");
        assert_eq!(of("GitHub Copilot").monogram, "CP");
    }

    #[test]
    fn other_agents_get_initials_and_a_stable_colour() {
        assert_eq!(of("Roo Code").monogram, "");
        assert_eq!(initials("Roo Code"), "RC");
        assert_eq!(initials("Goose"), "GO");
        assert_eq!(of("Goose"), of("Goose"));
    }
}
