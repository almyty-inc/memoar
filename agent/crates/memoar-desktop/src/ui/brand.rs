//! memoar by almyty: the Thread mark, the wordmark, the endorsement line and
//! the typefaces.
//!
//! The marks are the brand's SVG files, unchanged, drawn by NSH's SVG
//! renderer from `data:` URIs, so they need no asset location and look the
//! same on every desktop. The fonts ship in `assets/fonts` (both OFL): the
//! UI set registers them for packaged apps and `nsh test`, and `main.rs`
//! registers the same files for `cargo run`.

use nsh_core::ui::FontWeight;
use nsh_core::ui::prelude::*;

use super::look::look;

/// Manrope, the variable font, every weight.
pub(crate) const SANS: &str = "Manrope";
/// JetBrains Mono, for ids and paths.
pub(crate) const MONO: &str = "JetBrains Mono";

pub(crate) const MANROPE_TTF: &[u8] = include_bytes!("../../assets/fonts/Manrope.ttf");
pub(crate) const MONO_TTF: &[u8] = include_bytes!("../../assets/fonts/JetBrainsMono-Regular.ttf");

const MEMOAR_MARK: &str = include_str!("../../assets/brand/memoar-mark.svg");
const ALMYTY_MARK: &str = include_str!("../../assets/brand/almyty-mark.svg");

/// `svg` as a `data:` URI: the characters a URI cannot carry escaped.
fn data_uri(svg: &str) -> String {
    let mut out = String::from("data:image/svg+xml;utf8,");
    for c in svg.chars() {
        match c {
            '%' => out.push_str("%25"),
            '#' => out.push_str("%23"),
            '<' => out.push_str("%3C"),
            '>' => out.push_str("%3E"),
            '"' => out.push_str("%22"),
            '\n' | '\r' => out.push(' '),
            c => out.push(c),
        }
    }
    out
}

/// The Thread mark at `height` points (never below 16), its width in the
/// mark's own proportion.
pub(crate) fn mark(height: f32) -> impl IntoElement {
    let height = height.max(16.0);
    image(data_uri(MEMOAR_MARK))
        .w(px(height * 28.0 / 30.0))
        .h(px(height))
        .label(|| "memoar".to_owned())
}

/// The mark and "memoar" in Manrope 600, lowercase, tight.
pub(crate) fn wordmark(size: f32) -> impl IntoElement {
    view()
        .flex_row()
        .items_center()
        .gap(px(size * 0.4))
        .child(mark(size * 1.15))
        .child(
            text("memoar")
                .text_size(px(size))
                .font_weight(FontWeight::SEMIBOLD)
                .letter_spacing(px(-0.05 * size)),
        )
}

/// "memoar by [bolt] almyty", in small secondary text.
pub(crate) fn endorsement() -> impl IntoElement {
    let l = look();
    let words = |w: &'static str| text(w).text_size(px(12.0)).text_color(l.text_2);
    view()
        .flex_row()
        .items_center()
        .justify_center()
        .gap(px(5.0))
        .child(words("memoar by"))
        .child(
            image(data_uri(ALMYTY_MARK))
                .w(px(11.0))
                .h(px(13.0))
                .label(|| "almyty".to_owned()),
        )
        .child(words("almyty").font_weight(FontWeight::SEMIBOLD))
}

#[cfg(test)]
mod tests {
    use super::data_uri;

    #[test]
    fn a_mark_becomes_a_data_uri_without_raw_markup() {
        let uri = data_uri("<svg fill=\"#2775F7\">\n</svg>");
        assert_eq!(
            uri,
            "data:image/svg+xml;utf8,%3Csvg fill=%22%232775F7%22%3E %3C/svg%3E"
        );
    }
}
