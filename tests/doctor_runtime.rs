use codlet::capabilities::{CapabilityDescriptor, CapabilityScope};
use codlet::catalog::PluginCatalog;
use codlet::diagnostics::{
    Check, DiagnosticIssue, DoctorInputs, DoctorReport, DoctorRuntimeInput, PackageInfo,
    ProcessSnapshot,
};
use codlet::plugins::{PluginRegistry, bundled_plugins};
use codlet::runtime_inspection::{
    InspectedTarget, ProviderKind, RegisteredProvider, RendererInspection, RuntimeInspection,
};
use codlet::runtime_status::{HostState, PluginLifecycle, PluginStatus, StatusEvent};
use serde_json::{Value, json};

fn static_report() -> DoctorReport {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("missing-config.json");
    DoctorReport::from_inputs(DoctorInputs {
        package: Check::ok(PackageInfo {
            family_name: "fixture".to_owned(),
            full_name: "fixture_1".to_owned(),
            version: "1".to_owned(),
            install_location: "C:/fixture".to_owned(),
        }),
        executable: Check::ok("C:/fixture/Codex.exe".to_owned()),
        processes: Check::ok(ProcessSnapshot::new(Vec::new())),
        registry_path: Some(path.clone()),
        registry: PluginRegistry::load(&path),
        catalog: bundled_plugins().map(PluginCatalog::from_bundled),
    })
}

fn inspection() -> RuntimeInspection {
    RuntimeInspection {
        host_pid: 42,
        host_incarnation: "0123456789abcdef0123456789abcdef".to_owned(),
        registry_scope: "abcdef0123456789abcdef0123456789".to_owned(),
        codlet_version: "fixture".to_owned(),
        state: HostState::Ready,
        sequence: 27,
        sampled_at_unix_ms: 10_000,
        codex: None,
        termination: None,
        renderer: Some(RendererInspection {
            providers: vec![
                RegisteredProvider {
                    id: "fixture.host".to_owned(),
                    generation: 1,
                    kind: ProviderKind::Host,
                    provides: vec![
                        CapabilityDescriptor::new("fixture.host.ping", 1, CapabilityScope::Target)
                            .unwrap(),
                    ],
                    capabilities_truncated: false,
                },
                RegisteredProvider {
                    id: "fixture.renderer".to_owned(),
                    generation: 7,
                    kind: ProviderKind::Renderer,
                    provides: vec![
                        CapabilityDescriptor::new(
                            "fixture.renderer.ready",
                            2,
                            CapabilityScope::Target,
                        )
                        .unwrap(),
                    ],
                    capabilities_truncated: false,
                },
            ],
            targets: vec![InspectedTarget {
                target_id: "target-a".to_owned(),
                session_id: "session-a".to_owned(),
                session_live: true,
                document_epoch: 13,
                recovery_pending: false,
                scope_active: true,
                plugins: vec![PluginStatus {
                    id: "fixture.renderer".to_owned(),
                    version: "1.2.3".to_owned(),
                    generation: 7,
                    lifecycle: PluginLifecycle::Active,
                    context_present: true,
                    activation_confirmed: true,
                    active: true,
                }],
            }],
            recent_events: vec![StatusEvent {
                target_id: "target-a".to_owned(),
                code: "previous_recovery_failure".to_owned(),
                message: "Historical fixture failure; the current generation has recovered."
                    .to_owned(),
            }],
            truncated: false,
            lifecycle_busy: false,
        }),
    }
}

fn inspected_report(inspection: RuntimeInspection, queried_at_unix_ms: u64) -> DoctorReport {
    static_report().with_runtime(DoctorRuntimeInput::Inspected {
        inspection: Box::new(inspection),
        queried_at_unix_ms,
    })
}

fn as_json(report: &DoctorReport) -> Value {
    serde_json::from_str(&report.to_json()).unwrap()
}

fn renderer_readiness(report: &Value, target: usize) -> &Value {
    &report["runtime"]["providerReady"]["data"]["providers"][1]["targets"][target]["readiness"]
}

#[test]
fn observed_inventory_stays_independent_of_disk_and_historical_failures() {
    let report = inspected_report(inspection(), 10_040);
    let json = as_json(&report);
    assert_eq!(json["result"]["exitCode"], 0);
    assert_eq!(json["runtime"]["status"], "inspected");
    assert_eq!(json["runtime"]["sample"]["ageMs"], 40);
    assert_eq!(json["runtime"]["sample"]["sequence"], 27);
    assert_eq!(json["runtime"]["sample"]["hostPid"], 42);
    assert_eq!(json["runtime"]["sample"]["complete"], true);
    assert_eq!(json["runtime"]["targets"]["data"], json!(["target-a"]));
    assert_eq!(
        json["runtime"]["pluginGenerations"]["data"]["targets"][0]["document_epoch"],
        13
    );
    assert_eq!(renderer_readiness(&json, 0), "activation_ready");
    assert_eq!(
        json["runtime"]["providerReady"]["data"]["assessment"],
        "activation_ready"
    );
    assert_eq!(json["runtime"]["compatibility"]["status"], "unavailable");
    assert!(json["runtime"].get("issues").is_none());
    assert_eq!(
        json["runtime"]["recentEvents"][0]["code"],
        "previous_recovery_failure"
    );
    let providers = json["runtime"]["providerReady"]["data"]["providers"]
        .as_array()
        .unwrap();
    assert_eq!(
        providers
            .iter()
            .map(|provider| provider["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["fixture.host", "fixture.renderer"]
    );
    assert!(
        json["plugins"]["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|plugin| plugin["id"] == "codlet-gui")
    );
    let human = report.to_human_readable();
    for text in [
        "runtime: inspected",
        "pid=42",
        "sequence=27",
        "age-ms=40",
        "document-epoch=13",
        "generation=7",
        "fixture.renderer.ready@2",
        "readiness=activation_ready",
        "recent-event (history only)",
        "compatibility: not_probed",
    ] {
        assert!(human.contains(text), "missing human evidence: {text}");
    }
}

#[test]
fn fresh_quiet_failures_identify_targets_and_both_generations() {
    let mut snapshot = inspection();
    let renderer = snapshot.renderer.as_mut().unwrap();
    renderer.targets[0].plugins[0].generation = 6;
    let mut inactive = renderer.targets[0].clone();
    inactive.target_id = "target-b".to_owned();
    inactive.plugins[0].generation = 7;
    inactive.plugins[0].active = false;
    inactive.plugins[0].activation_confirmed = false;
    let mut absent = inactive.clone();
    absent.target_id = "target-c".to_owned();
    absent.plugins.clear();
    renderer.targets.extend([inactive, absent]);
    let report = inspected_report(snapshot, 10_001);
    let json = as_json(&report);
    assert_eq!(json["result"]["failedChecks"], json!(["runtime"]));
    assert_eq!(json["result"]["exitCode"], 1);
    assert_eq!(json["result"]["launchPreflight"], "not_blocked_by_snapshot");
    assert_eq!(renderer_readiness(&json, 0), "generation_mismatch");
    assert_eq!(renderer_readiness(&json, 1), "plugin_inactive");
    assert_eq!(renderer_readiness(&json, 2), "plugin_not_observed");
    let issue = &json["runtime"]["issues"][0];
    assert_eq!(issue["code"], "runtime_activation_unready");
    assert_eq!(issue["details"]["count"], 3);
    assert_eq!(issue["details"]["examples"][0]["registeredGeneration"], 7);
    assert_eq!(issue["details"]["examples"][0]["observedGeneration"], 6);
    assert_eq!(issue["details"]["examples"][0]["targetId"], "target-a");
    assert!(issue["remediation"].as_str().unwrap().contains("Host logs"));
    assert!(
        report
            .to_human_readable()
            .contains("runtime: failed [runtime_activation_unready]")
    );
}

#[test]
fn inactive_observed_consumer_is_diagnosed_without_inventing_a_provider_registration() {
    let mut snapshot = inspection();
    let target = &mut snapshot.renderer.as_mut().unwrap().targets[0];
    let mut consumer = target.plugins[0].clone();
    consumer.id = "fixture.consumer".to_owned();
    consumer.generation = 11;
    consumer.active = false;
    consumer.activation_confirmed = false;
    target.plugins.push(consumer);
    let report = as_json(&inspected_report(snapshot, 10_040));
    assert_eq!(report["result"]["failedChecks"], json!(["runtime"]));
    assert_eq!(renderer_readiness(&report, 0), "activation_ready");
    let example = &report["runtime"]["issues"][0]["details"]["examples"][0];
    assert_eq!(example["pluginId"], "fixture.consumer");
    assert_eq!(example["observedGeneration"], 11);
    assert!(example["registeredGeneration"].is_null());
    assert_eq!(
        report["runtime"]["providerReady"]["data"]["assessment"],
        "activation_ready"
    );
    assert_eq!(
        report["runtime"]["providerReady"]["data"]["providers"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn stale_incomplete_and_global_transition_samples_preserve_facts_without_failure() {
    for (case, expected) in [
        ("stale", "stale"),
        ("future", "clock_skew"),
        ("starting", "host_starting"),
        ("terminated", "host_terminated"),
        ("busy", "lifecycle_busy"),
        ("truncated", "incomplete_sample"),
        ("capabilities", "incomplete_sample"),
    ] {
        let mut snapshot = inspection();
        let renderer = snapshot.renderer.as_mut().unwrap();
        renderer.targets[0].plugins[0].generation = 1;
        let queried = match case {
            "stale" => 15_001,
            "future" => 9_999,
            "starting" => {
                snapshot.state = HostState::Starting;
                10_040
            }
            "terminated" => {
                snapshot.state = HostState::Terminated;
                snapshot.termination = Some("fixture exit".to_owned());
                10_040
            }
            "busy" => {
                renderer.lifecycle_busy = true;
                10_040
            }
            "truncated" => {
                renderer.truncated = true;
                10_040
            }
            "capabilities" => {
                renderer.providers[0].capabilities_truncated = true;
                10_040
            }
            _ => unreachable!(),
        };
        let report = as_json(&inspected_report(snapshot, queried));
        assert_eq!(report["result"]["exitCode"], 0, "case {case}");
        assert_eq!(renderer_readiness(&report, 0), expected, "case {case}");
        assert_eq!(
            report["runtime"]["pluginGenerations"]["data"]["targets"][0]["plugins"][0]["generation"],
            1
        );
        assert_eq!(report["runtime"]["compatibility"]["status"], "unavailable");
        assert!(report["runtime"].get("issues").is_none());
    }
    let boundary = as_json(&inspected_report(inspection(), 15_000));
    assert_eq!(renderer_readiness(&boundary, 0), "activation_ready");
}

#[test]
fn target_transitions_suppress_readiness_for_host_and_renderer_without_hiding_other_targets() {
    for (case, expected) in [
        ("dead", "session_not_live"),
        ("recovery", "recovery_pending"),
        ("scope", "scope_inactive"),
    ] {
        let mut snapshot = inspection();
        let renderer = snapshot.renderer.as_mut().unwrap();
        let mut affected = renderer.targets[0].clone();
        affected.target_id = "target-transition".to_owned();
        affected.plugins.clear();
        match case {
            "dead" => affected.session_live = false,
            "recovery" => affected.recovery_pending = true,
            "scope" => affected.scope_active = false,
            _ => unreachable!(),
        }
        renderer.targets.push(affected);
        let report = as_json(&inspected_report(snapshot, 10_010));
        assert_eq!(report["result"]["exitCode"], 0);
        assert_eq!(renderer_readiness(&report, 0), "activation_ready");
        assert_eq!(renderer_readiness(&report, 1), expected);
        assert_eq!(
            report["runtime"]["providerReady"]["data"]["providers"][0]["targets"][1]["readiness"],
            expected
        );
        assert_eq!(
            report["runtime"]["providerReady"]["data"]["assessment"],
            "partial_target_readiness"
        );
    }
}

#[test]
fn absent_runtime_metadata_never_creates_empty_successful_inventories() {
    let mut snapshot = inspection();
    snapshot.renderer = None;
    let report = as_json(&inspected_report(snapshot, 10_040));
    assert_eq!(report["runtime"]["sample"]["complete"], false);
    assert_eq!(report["runtime"]["targets"]["status"], "unavailable");
    assert_eq!(report["runtime"]["providerReady"]["status"], "unavailable");
    assert_eq!(report["result"]["exitCode"], 0);
    for (input, status) in [
        (DoctorRuntimeInput::NotRunning, "not_running"),
        (
            DoctorRuntimeInput::OtherRegistry {
                host_pid: 71,
                registry_scope: "another-scope".to_owned(),
            },
            "other_registry",
        ),
        (
            DoctorRuntimeInput::Unsupported {
                host_pid: Some(72),
                message: "legacy version".to_owned(),
            },
            "unsupported",
        ),
    ] {
        let report = as_json(&static_report().with_runtime(input));
        assert_eq!(report["runtime"]["status"], status);
        assert_eq!(report["result"]["exitCode"], 0);
        for field in [
            "targets",
            "pluginGenerations",
            "providerReady",
            "compatibility",
        ] {
            assert_eq!(report["runtime"][field]["status"], "unavailable");
            assert!(report["runtime"][field].get("data").is_none());
        }
        assert!(report["runtime"].get("sample").is_none());
    }
}

#[test]
fn static_failures_and_runtime_transport_failures_remain_independent() {
    let mut report = static_report();
    report.package = Check::Failed {
        error: DiagnosticIssue::new(
            "fixture_package_error",
            "fixture unavailable",
            "fix fixture",
        ),
    };
    report.result.failed_checks.push("package");
    let report = report.with_runtime(DoctorRuntimeInput::Inspected {
        inspection: Box::new(inspection()),
        queried_at_unix_ms: 10_040,
    });
    let value = as_json(&report);
    assert_eq!(value["result"]["failedChecks"], json!(["package"]));
    assert_eq!(renderer_readiness(&value, 0), "activation_ready");
    let report = report.with_runtime(DoctorRuntimeInput::Unavailable {
        code: "runtime_wrong_identity",
        message: "Host incarnation did not match".to_owned(),
    });
    let value = as_json(&report);
    assert_eq!(
        value["result"]["failedChecks"],
        json!(["package", "runtime"])
    );
    assert_eq!(
        value["runtime"]["issues"][0]["code"],
        "runtime_wrong_identity"
    );
    assert!(
        report
            .to_human_readable()
            .contains("Host incarnation did not match")
    );
    assert!(value["runtime"].get("sample").is_none());
    let value = as_json(&report.with_runtime(DoctorRuntimeInput::NotRunning));
    assert_eq!(value["result"]["failedChecks"], json!(["package"]));
    assert_eq!(value["result"]["exitCode"], 1);
}
