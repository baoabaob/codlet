#![cfg(windows)]

#[test]
#[ignore = "external M0 one-shot smoke: explicitly launches Codex, then pipe disconnect makes Electron exit"]
fn installed_codex_accepts_inherited_cdp_pipe() {
    assert_eq!(
        std::env::var("CODLET_RUN_REAL_CODEX_GATE").as_deref(),
        Ok("1"),
        "set CODLET_RUN_REAL_CODEX_GATE=1 only after closing every Codex window and accepting that this one-shot smoke makes the launched Codex exit"
    );
    let report = codlet::probe::run_real_probe().unwrap();
    assert!(report.marker_inserted);
    assert!(report.marker_removed);
}
