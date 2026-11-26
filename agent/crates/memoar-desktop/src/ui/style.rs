//! Type, spacing and the lists every screen is built from.

use nsh_core::ui::FontWeight;
use nsh_core::ui::prelude::*;

use super::brand::MONO;
use super::look::{hair, look};
use crate::failure::Failure;

/// Text sizes: secondary, base UI.
pub(crate) const SMALL: f32 = 12.0;
pub(crate) const BASE: f32 = 13.0;

/// The height of a row in a list.
const ROW: f32 = 36.0;
/// The width of a fact's name.
const LABEL: f32 = 124.0;

/// A page title: Manrope 700, 24pt, tracked in.
pub(crate) fn title(words: &'static str) -> impl IntoElement {
    text(words)
        .text_size(px(24.0))
        .line_height(px(30.0))
        .letter_spacing(px(-0.72))
        .font_weight(FontWeight::BOLD)
}

/// The name of a section, above its list.
pub(crate) fn section(words: &'static str) -> impl IntoElement {
    text(words)
        .text_size(px(BASE))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(look().text_2)
        .pb(px(4.0))
}

/// Secondary text: hints, notices.
pub(crate) fn note(words: impl Fn() -> String + 'static) -> impl IntoElement {
    text(words)
        .text_size(px(BASE))
        .line_height(px(19.0))
        .font_weight(FontWeight::MEDIUM)
        .text_color(look().text_2)
}

/// `child` with `space` above it. Screens stack with this rather than with a
/// gap, so a part that is shown only sometimes leaves no gap when it is not.
pub(crate) fn below(space: f32, child: impl IntoElement) -> View {
    view().mt(px(space)).child(child)
}

/// A part shown only when `part` has something to show.
pub(crate) fn maybe<E: IntoElement>(
    space: f32,
    part: impl Fn() -> Option<E> + 'static,
) -> impl IntoElement {
    dynamic(move || match part() {
        Some(shown) => below(space, shown).into_element(),
        None => view().into_element(),
    })
}

/// A row of a list (rows between hairline rules, on the card itself), with a rule above it unless it is the first.
pub(crate) fn row(first: bool) -> View {
    let row = view()
        .flex_row()
        .items_center()
        .gap(px(12.0))
        .min_h(px(ROW))
        .py(px(6.0));
    if first {
        row
    } else {
        row.border_t(px(hair())).border_color(look().rule)
    }
}

/// A fact's name, in its fixed column.
pub(crate) fn label(words: &'static str) -> impl IntoElement {
    text(words)
        .text_size(px(BASE))
        .font_weight(FontWeight::MEDIUM)
        .text_color(look().text_2)
        .w(px(LABEL))
        .flex_shrink_0()
}

/// A fact: its name and its value, in tabular figures so counts and times
/// line up.
pub(crate) fn fact(
    first: bool,
    name: &'static str,
    value: impl Fn() -> String + 'static,
) -> impl IntoElement {
    row(first).child(label(name)).child(
        text(value)
            .text_size(px(14.0))
            .font_weight(FontWeight::MEDIUM)
            .tabular_nums()
            .flex_1()
            .flex_shrink(1.0),
    )
}

/// A fact whose value is an id, in JetBrains Mono.
pub(crate) fn fact_id(
    name: &'static str,
    value: impl Fn() -> String + 'static,
) -> impl IntoElement {
    row(false).child(label(name)).child(
        text(value)
            .font_family(MONO)
            .text_size(px(12.5))
            .flex_1()
            .flex_shrink(1.0),
    )
}

/// A failure: the sentence in the danger colour, and under it what the CLI
/// said when that adds anything.
pub(crate) fn failure_text(id: &'static str, failure: Failure) -> impl IntoElement {
    let detail = failure.detail.clone();
    let shows_detail = !detail.is_empty() && detail != failure.message;
    view()
        .test_id(id)
        .gap(px(4.0))
        .child(
            text(failure.message)
                .text_size(px(14.0))
                .line_height(px(20.0))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(look().danger),
        )
        .child(when(shows_detail, move || {
            let detail = detail.clone();
            note(move || detail.clone())
        }))
}
