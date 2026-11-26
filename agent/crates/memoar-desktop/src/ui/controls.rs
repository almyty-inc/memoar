//! The controls: buttons, a two-way segmented switch, text fields and
//! on/off switches, sized and colored by the desktop's [`look`].
//!
//! Each keeps its accessibility role and label, which screen readers and the
//! headless tests find it by.

use nsh_core::ui::prelude::*;
use nsh_core::ui::{AutoCapitalize, FontWeight, StyleRefinement};
use nsh_core::{AccessibilityState, Checked};

use super::look::{Focus, look, motion};
use super::style::{BASE, SMALL, note};

/// The focus style of a field or control on this desktop.
fn focused(style: StyleRefinement) -> StyleRefinement {
    let l = look();
    match l.focus {
        Focus::Ring(width) => style
            .border_color(l.accent)
            .ring(px(width))
            .ring_color(l.accent.opacity(0.35)),
        Focus::Underline => style.border_b(px(2.0)).border_b_color(l.accent),
    }
}

/// A pressable control with the button role. `primary` fills it with the
/// accent. `keys` is a shortcut hint drawn after the label, if any.
pub(crate) fn button(
    label: impl Fn() -> String + Copy + 'static,
    id: &'static str,
    primary: impl Fn() -> bool + Copy + 'static,
    enabled: impl Fn() -> bool + Copy + 'static,
    keys: Option<String>,
    press: impl Fn() + 'static,
) -> impl IntoElement {
    let l = look();
    let ink = move || if primary() { l.accent_text } else { l.text };
    view()
        .test_id(id)
        .flex_row()
        .gap(px(6.0))
        .h(px(l.control))
        .px(px(12.0))
        .rounded(px(l.radius))
        .items_center()
        .justify_center()
        .role(|| AccessibilityRole::Button)
        .label(label)
        .disabled(move || !enabled())
        .border(px(1.0))
        .border_color(move || if primary() { l.accent } else { l.line })
        .bg(move || if primary() { l.accent } else { l.group })
        .opacity(move || if enabled() { 1.0_f32 } else { 0.45_f32 })
        .transition_colors()
        .duration(motion())
        .ease_out()
        .hover(move |style| {
            if primary() {
                style.bg(l.accent_hover).border_color(l.accent_hover)
            } else {
                style.bg(l.hover)
            }
        })
        .active(|style| style.opacity(0.8))
        .focus(focused)
        .on_press(move || {
            if enabled() {
                press();
            }
        })
        .child(
            text(label)
                .text_size(px(BASE))
                .font_weight(FontWeight::MEDIUM)
                .text_color(ink),
        )
        .children(keys.map(|keys| text(keys).text_size(px(SMALL)).text_color(ink).opacity(0.6)))
}

/// One half of a two-way switch: the chosen half raised on the group color.
/// Still a button to assistive technology and the tests.
pub(crate) fn segment(
    words: &'static str,
    id: &'static str,
    chosen: impl Fn() -> bool + Copy + 'static,
    enabled: impl Fn() -> bool + Copy + 'static,
    press: impl Fn() + 'static,
) -> impl IntoElement {
    let l = look();
    view()
        .test_id(id)
        .flex_1()
        .h(px(l.control - 4.0))
        .rounded(px(l.radius - 1.0))
        .items_center()
        .justify_center()
        .role(|| AccessibilityRole::Button)
        .label(move || words.to_owned())
        .accessibility_state(move || AccessibilityState {
            selected: chosen(),
            ..AccessibilityState::default()
        })
        .disabled(move || !enabled())
        .bg(move || if chosen() { l.group } else { l.hover })
        .transition_colors()
        .duration(motion())
        .ease_out()
        .on_press(move || {
            if enabled() {
                press();
            }
        })
        .child(
            text(words)
                .text_size(px(SMALL))
                .font_weight(FontWeight::MEDIUM)
                .text_color(move || if chosen() { l.text } else { l.text_2 }),
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
    let l = look();
    view()
        .gap(px(6.0))
        .child(note(move || label.to_owned()))
        .child(
            input()
                .test_id(id)
                .label(label)
                .h(px(l.control))
                .px(px(8.0))
                .rounded(px(l.radius))
                .border(px(1.0))
                .border_color(l.line)
                .bg(l.group)
                .text_color(l.text)
                .text_size(px(BASE))
                .transition_colors()
                .duration(motion())
                .ease_out()
                .focus(focused)
                .placeholder(placeholder)
                .masked(masked)
                .auto_capitalize(AutoCapitalize::None)
                .auto_correct(false)
                .value(value)
                .on_change(move |text: &str| value.set(text.to_owned()))
                .on_submit(move |_: &str| submit()),
        )
}

/// An on/off switch with the switch role, its state also said in words
/// before it.
pub(crate) fn switch(
    label: &'static str,
    id: &'static str,
    on: impl Fn() -> bool + Copy + 'static,
    press: impl Fn() + 'static,
) -> impl IntoElement {
    let l = look();
    let (width, height) = l.switch;
    let knob = height - 4.0;
    view()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .child(
            text(move || if on() { "On" } else { "Off" }.to_owned())
                .text_size(px(SMALL))
                .text_color(l.text_2),
        )
        .child(
            view()
                .test_id(id)
                .role(|| AccessibilityRole::Switch)
                .label(move || label.to_owned())
                .accessibility_state(move || AccessibilityState {
                    checked: Some(if on() { Checked::True } else { Checked::False }),
                    ..AccessibilityState::default()
                })
                .w(px(width))
                .h(px(height))
                .p(px(2.0))
                .rounded(px(height / 2.0))
                .bg(move || if on() { l.accent } else { l.fill })
                .transition_colors()
                .duration(motion())
                .ease_out()
                .focus(focused)
                .on_press(press)
                .child(
                    view()
                        .w(px(knob))
                        .h(px(knob))
                        .rounded(px(knob / 2.0))
                        .bg(AdaptiveColor::rgb(0xffffff, 0xffffff))
                        .translate_x(move || px(if on() { width - height } else { 0.0 }))
                        .transition_transform()
                        .duration(motion())
                        .ease_out(),
                ),
        )
}
