#![cfg(windows)]

#[test]
#[ignore = "external M0 one-shot smoke: explicitly launches Codex; pipe disconnect only requests cooperative Electron quit"]
fn installed_codex_accepts_inherited_cdp_pipe() {
    assert_eq!(
        std::env::var("CODLET_RUN_REAL_CODEX_GATE").as_deref(),
        Ok("1"),
        "set CODLET_RUN_REAL_CODEX_GATE=1 only after closing every Codex window and accepting that the launched Codex may remain alive after this one-shot smoke"
    );
    let report = codlet::probe::run_real_probe().unwrap();
    assert!(report.marker_inserted);
    assert!(report.marker_removed);
}
