use std::time::{Duration, Instant};

use codlet::runtime_settings::SettingsDocument;
use codlet::runtime_update::{RuntimeUpdatePhase, RuntimeUpdateService};

#[test]
fn an_unavailable_update_worker_cannot_turn_a_failed_settings_apply_into_success() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("runtime")).unwrap();
    // This is rejected locally by the source validator, before any request.
    std::fs::write(root.path().join("runtime/update-channel.json"), br#"{
      "schema": 1, "channel": "stable", "checkIntervalSeconds": 900,
      "source": {"kind": "https", "manifestUrl": "http://invalid.invalid/manifest.json", "allowedAssetOrigins": []}
    }"#).unwrap();
    let service =
        RuntimeUpdateService::start(root.path().to_owned(), root.path().join("updates"), None)
            .unwrap();
    let until = Instant::now() + Duration::from_secs(3);
    while service.status().phase != RuntimeUpdatePhase::Failed {
        assert!(
            Instant::now() < until,
            "the invalid source must fail locally"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    let mut preferences = SettingsDocument {
        revision: 1,
        ..SettingsDocument::default()
    };
    preferences.values.automatic_update_checks = false;
    // Observe channel closure without relying on a fixed scheduling delay.
    loop {
        match service.configure_checks(&preferences) {
            Err(error) => {
                assert_eq!(error.code, "runtime_update_worker");
                break;
            }
            Ok(()) => {
                assert!(Instant::now() < until, "the failed worker must terminate");
                preferences.revision += 1;
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }
    assert!(
        service.configure_checks(&preferences).is_err(),
        "reading or retrying the same persisted revision must not report an unapplied preference as applied"
    );
}
