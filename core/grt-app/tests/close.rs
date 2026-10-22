use std::time::{Duration, Instant};

use grt_app::close::{Decision, Guard};

#[test]
fn a_window_with_nothing_to_lose_closes() {
    let mut guard = Guard::default();
    assert_eq!(guard.request(Instant::now()), Decision::Close);
}

#[test]
fn a_held_window_asks_the_page_first() {
    let mut guard = Guard::default();
    guard.hold(true);
    assert_eq!(guard.request(Instant::now()), Decision::Ask);
}

#[test]
fn a_page_that_answered_is_asked_again_however_long_it_takes() {
    let start = Instant::now();
    let mut guard = Guard::default();
    guard.hold(true);
    assert_eq!(guard.request(start), Decision::Ask);
    guard.answer();
    // The user took a minute over the dialog and clicked the cross again.
    assert_eq!(guard.request(start + Duration::from_secs(60)), Decision::Ask);
}

#[test]
fn a_page_that_never_answered_lets_the_window_go() {
    let start = Instant::now();
    let mut guard = Guard::default();
    guard.hold(true);
    assert_eq!(guard.request(start), Decision::Ask);
    assert_eq!(guard.request(start + Duration::from_secs(4)), Decision::Close);
}

#[test]
fn clicking_again_quickly_does_not_restart_the_wait() {
    let start = Instant::now();
    let mut guard = Guard::default();
    guard.hold(true);
    assert_eq!(guard.request(start), Decision::Ask);
    assert_eq!(guard.request(start + Duration::from_secs(2)), Decision::Ask);
    assert_eq!(guard.request(start + Duration::from_secs(4)), Decision::Close);
}

#[test]
fn releasing_the_guard_forgets_an_unanswered_request() {
    let start = Instant::now();
    let mut guard = Guard::default();
    guard.hold(true);
    guard.request(start);
    guard.hold(false);
    guard.hold(true);
    assert_eq!(guard.request(start + Duration::from_secs(10)), Decision::Ask);
}

#[test]
fn a_cancelled_dialog_asks_again_next_time() {
    let start = Instant::now();
    let mut guard = Guard::default();
    guard.hold(true);
    guard.request(start);
    guard.answer();
    assert_eq!(guard.request(start + Duration::from_secs(300)), Decision::Ask);
    assert_eq!(guard.request(start + Duration::from_secs(304)), Decision::Close);
}
