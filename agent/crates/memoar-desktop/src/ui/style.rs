//! Type, spacing and the grouped list every screen is built from.

use nsh_core::ui::FontWeight;
use nsh_core::ui::prelude::*;

use super::look::{hair, look};
use crate::failure::Failure;

/// Text sizes: secondary, base UI and page title.
pub(crate) const SMALL: f32 = 12.0;
pub(crate) const BASE: f32 = 13.0;
pub(crate) const TITLE: f32 = 16.0;

/// The height of a row in a grouped list.
const ROW: f32 = 36.0;
/// The width of a fact's name.
const LABEL: f32 = 112.0;

pub(crate) fn title(words: &'static str) -> impl IntoElement {
    text(words)
        .text_size(px(TITLE))
        .line_height(px(22.0))
        .letter_spacing(px(-0.2))
        .font_weight(FontWeight::SEMIBOLD)
}

/// The name of a section, above its group.
pub(crate) fn section(words: &'static str) -> impl IntoElement {
    text(words)
        .text_size(px(BASE))
        .font_weight(FontWeight::SEMIBOLD)
        .pl(px(2.0))
        .pb(px(6.0))
}

/// Secondary text: hints, notices.
pub(crate) fn note(words: impl Fn() -> String + 'static) -> impl IntoElement {
    text(words)
        .text_size(px(SMALL))
        .line_height(px(17.0))
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

/// A grouped list: rows on the group color inside one hairline outline.
pub(crate) fn group() -> View {
    let l = look();
    view()
        .bg(l.group)
        .rounded(px(l.group_radius))
        .border(px(hair()))
        .border_color(l.line)
        .overflow_hidden()
}

/// A row of a group, with a hairline above it unless it is the first.
pub(crate) fn row(first: bool) -> View {
    let l = look();
    let row = view()
        .flex_row()
        .items_center()
        .gap(px(12.0))
        .min_h(px(ROW))
        .px(px(12.0))
        .py(px(4.0));
    if first {
        row
    } else {
        row.border_t(px(hair())).border_color(l.line)
    }
}

/// A fact: its name in a fixed column and its value after it, in tabular
/// figures so counts and times line up.
pub(crate) fn fact(
    first: bool,
    label: &'static str,
    value: impl Fn() -> String + 'static,
) -> impl IntoElement {
    fact_in(first, label, value, None)
}

/// A fact whose value is an id, set in the monospaced face.
pub(crate) fn fact_id(
    label: &'static str,
    value: impl Fn() -> String + 'static,
) -> impl IntoElement {
    fact_in(false, label, value, Some(look().mono))
}

fn fact_in(
    first: bool,
    label: &'static str,
    value: impl Fn() -> String + 'static,
    family: Option<&'static str>,
) -> impl IntoElement {
    let l = look();
    let shown = text(value)
        .text_size(px(BASE))
        .tabular_nums()
        .flex_1()
        .flex_shrink(1.0);
    let shown = match family {
        Some(family) => shown.font_family(family).text_size(px(SMALL)),
        None => shown,
    };
    row(first)
        .child(
            text(label)
                .text_size(px(BASE))
                .text_color(l.text_2)
                .w(px(LABEL))
                .flex_shrink_0(),
        )
        .child(shown)
}

/// A failure: the sentence in the danger color, and under it what the CLI
/// said when that adds anything.
pub(crate) fn failure_text(id: &'static str, failure: Failure) -> impl IntoElement {
    let detail = failure.detail.clone();
    let shows_detail = !detail.is_empty() && detail != failure.message;
    view()
        .test_id(id)
        .gap(px(2.0))
        .child(
            text(failure.message)
                .text_size(px(BASE))
                .line_height(px(18.0))
                .text_color(look().danger),
        )
        .child(when(shows_detail, move || {
            let detail = detail.clone();
            note(move || detail.clone())
        }))
}
