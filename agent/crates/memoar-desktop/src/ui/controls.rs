//! The controls: buttons, a two-way segmented switch, text fields and
//! on/off switches, in almyty's shapes (10pt corners, 600 weight, a solid
//! blue primary with a soft blue shadow, secondary as a ring only).
//!
//! Each keeps its accessibility role and label, which screen readers and the
//! headless tests find it by.

use nsh_core::ui::prelude::*;
use nsh_core::ui::{AdaptiveColor, AutoCapitalize, FontWeight, StyleRefinement};
use nsh_core::{AccessibilityState, BoxShadow, Checked, Color};

use super::look::{look, motion};
use super::style::{BASE, SMALL, note};

const RADIUS: f32 = 10.0;
const CONTROL: f32 = 36.0;

/// The ring a focused field or control shows.
fn focused(style: StyleRefinement) -> StyleRefinement {
    let l = look();
    style
        .border_color(l.primary)
        .ring(px(3.0))
        .ring_color(l.primary.opacity(0.3))
}

/// The primary button's soft blue shadow (almyty: 0 4px 14px of the blue
/// at 30%).
fn blue_shadow() -> [BoxShadow; 1] {
    [BoxShadow {
        offset_x: px(0.0),
        offset_y: px(4.0),
        blur: px(14.0),
        spread: px(0.0),
        color: Color::rgba(20, 105, 236, 77),
        inset: false,
    }]
}

/// A pressable control with the button role. `primary` fills it with the
/// blue. `keys` is a shortcut hint drawn after the label, if any.
pub(crate) fn button(
    label: impl Fn() -> String + Copy + 'static,
    id: &'static str,
    primary: impl Fn() -> bool + Copy + 'static,
    enabled: impl Fn() -> bool + Copy + 'static,
    keys: Option<String>,
    press: impl Fn() + 'static,
) -> impl IntoElement {
    let l = look();
    let ink = move || if primary() { l.on_primary } else { l.text };
    let fill = move || {
        if primary() {
            l.primary
        } else {
            AdaptiveColor::TRANSPARENT
        }
    };
    let control = view()
        .test_id(id)
        .flex_row()
        .gap(px(7.0))
        .h(px(CONTROL))
        .px(px(16.0))
        .rounded(px(RADIUS))
        .items_center()
        .justify_center()
        .role(|| AccessibilityRole::Button)
        .label(label)
        .disabled(move || !enabled())
        .border(px(1.0))
        .border_color(move || if primary() { l.primary } else { l.rule })
        .bg(fill)
        .opacity(move || if enabled() { 1.0_f32 } else { 0.5_f32 })
        .transition_colors()
        .duration(motion())
        .ease_out()
        .hover(move |style| {
            if primary() {
                style.bg(l.primary_hover).border_color(l.primary_hover)
            } else {
                style.bg(l.inset)
            }
        })
        .active(|style| style.opacity(0.85))
        .focus(focused)
        .on_press(move || {
            if enabled() {
                press();
            }
        })
        .child(
            text(label)
                .text_size(px(13.5))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(ink),
        )
        .children(keys.map(|keys| {
            text(keys)
                .text_size(px(SMALL))
                .font_weight(FontWeight::MEDIUM)
                .text_color(ink)
                .opacity(0.65)
        }));
    if untracked(primary) {
        control.shadow(blue_shadow())
    } else {
        control
    }
}

/// One half of a two-way switch: the chosen half raised onto the canvas.
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
        .h(px(CONTROL - 6.0))
        .rounded(px(RADIUS - 2.0))
        .items_center()
        .justify_center()
        .role(|| AccessibilityRole::Button)
        .label(move || words.to_owned())
        .accessibility_state(move || AccessibilityState {
            selected: chosen(),
            ..AccessibilityState::default()
        })
        .disabled(move || !enabled())
        .bg(move || {
            if chosen() {
                l.canvas
            } else {
                AdaptiveColor::TRANSPARENT
            }
        })
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
                .text_size(px(BASE))
                .font_weight(FontWeight::SEMIBOLD)
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
                .h(px(CONTROL + 2.0))
                .px(px(12.0))
                .rounded(px(RADIUS))
                .border(px(1.0))
                .border_color(l.rule)
                .bg(l.canvas)
                .text_color(l.text)
                .text_size(px(14.0))
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
    let (width, height) = (36.0, 20.0);
    let knob = height - 4.0;
    view()
        .flex_row()
        .items_center()
        .gap(px(10.0))
        .child(
            text(move || if on() { "On" } else { "Off" }.to_owned())
                .text_size(px(SMALL))
                .font_weight(FontWeight::MEDIUM)
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
                .bg(move || if on() { l.primary } else { l.rule })
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
