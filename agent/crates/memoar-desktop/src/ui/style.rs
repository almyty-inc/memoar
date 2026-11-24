//! The few pieces every screen is built from, drawn with NSH's primitives and
//! the theme's tokens so light and dark mode follow the system.

use nsh_base::theme;
use nsh_core::ui::prelude::*;
use nsh_core::ui::{AutoCapitalize, FontWeight};

use crate::failure::Failure;

pub(crate) fn heading(words: &'static str) -> impl IntoElement {
    text(words)
        .text_size(px(22.0))
        .font_weight(FontWeight::SEMIBOLD)
}

pub(crate) fn note(words: impl Fn() -> String + 'static) -> impl IntoElement {
    text(words)
        .text_size(px(12.0))
        .line_height(px(18.0))
        .text_color(move || theme().muted_foreground)
}

/// A pressable control with the button role, so screen readers and the
/// headless tests find it by its label.
pub(crate) fn button(
    label: impl Fn() -> String + Copy + 'static,
    id: &'static str,
    primary: impl Fn() -> bool + Copy + 'static,
    enabled: impl Fn() -> bool + Copy + 'static,
    press: impl Fn() + 'static,
) -> impl IntoElement {
    view()
        .test_id(id)
        .h(px(34.0))
        .px_4()
        .rounded(px(6.0))
        .items_center()
        .justify_center()
        .role(|| AccessibilityRole::Button)
        .label(label)
        .disabled(move || !enabled())
        .border_1()
        .border_color(move || {
            if primary() {
                theme().primary
            } else {
                theme().border
            }
        })
        .bg(move || {
            if primary() {
                theme().primary
            } else {
                theme().background
            }
        })
        .opacity(move || if enabled() { 1.0_f32 } else { 0.45_f32 })
        .hover(|style| style.opacity(0.85))
        .active(|style| style.opacity(0.6))
        .on_press(move || {
            if enabled() {
                press();
            }
        })
        .child(
            text(label)
                .text_size(px(13.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(move || {
                    if primary() {
                        theme().primary_foreground
                    } else {
                        theme().foreground
                    }
                }),
        )
}

/// A labelled single-line text field bound to `value`.
pub(crate) fn field(
    label: &'static str,
    id: &'static str,
    value: Signal<String>,
    masked: bool,
    placeholder: &'static str,
    submit: impl Fn() + 'static,
) -> impl IntoElement {
    view().gap_1().child(note(move || label.to_owned())).child(
        input()
            .test_id(id)
            .label(label)
            .h(px(34.0))
            .px_3()
            .rounded(px(6.0))
            .border_1()
            .border_color(move || theme().input)
            .text_size(px(14.0))
            .placeholder(placeholder)
            .masked(masked)
            .auto_capitalize(AutoCapitalize::None)
            .auto_correct(false)
            .value(value)
            .on_change(move |text: &str| value.set(text.to_owned()))
            .on_submit(move |_: &str| submit()),
    )
}

/// A label and its value on one line.
pub(crate) fn row(label: &'static str, value: impl Fn() -> String + 'static) -> impl IntoElement {
    view()
        .flex_row()
        .justify_between()
        .gap_4()
        .py_1()
        .child(note(move || label.to_owned()))
        .child(text(value).text_size(px(13.0)).flex_shrink(1.0))
}

/// A failure: the sentence, and underneath it what the CLI said.
pub(crate) fn failure_box(id: &'static str, failure: Failure) -> impl IntoElement {
    let detail = failure.detail.clone();
    let shows_detail = !detail.is_empty() && detail != failure.message;
    view()
        .test_id(id)
        .gap_1()
        .p_3()
        .rounded(px(6.0))
        .border_1()
        .border_color(move || theme().destructive)
        .child(
            text(failure.message)
                .text_size(px(13.0))
                .line_height(px(19.0))
                .text_color(move || theme().destructive),
        )
        .child(when(shows_detail, move || {
            let detail = detail.clone();
            note(move || detail.clone())
        }))
}
