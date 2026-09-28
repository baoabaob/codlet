use super::*;
use serde_json::json;
use std::path::PathBuf;
use std::time::Duration;
use windows_sys::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::System::Threading::WaitForSingleObject;

fn fixture() -> (tempfile::TempDir, PathBuf, ModuleDataPlan) {
    let directory = tempfile::tempdir().unwrap();
    let original = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("codlet-bootstrap-fixture.exe");
    let image = directory.path().join("fixture.exe");
    std::fs::copy(original, &image).unwrap();
    let bytes = std::fs::read(&image).unwrap();
    let marker = b"Codlet-owned-bootstrap-fixture:0!";
    let offsets: Vec<_> = bytes
        .windows(marker.len())
        .enumerate()
        .filter_map(|(i, b)| (b == marker).then_some(i))
        .collect();
    assert_eq!(offsets.len(), 1);
    let plan = ModuleDataPlan::parse(
        json!({"module":"fixture.exe","sha256":format!("{:x}",Sha256::digest(&bytes)),
        "patches":[{"fileOffset":offsets[0]+31,"expected":[48],"replacement":[49]}]}),
    )
    .unwrap();
    (directory, image, plan)
}

fn suspended(image: &Path) -> (SuspendedChild, super::super::pipes::ParentCdpPipes) {
    use super::super::{
        pipes::CdpPipes,
        process::{NativeLaunch, create_suspended},
    };
    let pipes = CdpPipes::create().unwrap();
    let child = create_suspended(&NativeLaunch {
        executable: image,
        arguments: &["--scenario=bootstrap".into()],
        no_window: true,
        environment: None,
        current_directory: None,
        cdp: pipes.child_handles(),
        stderr: None,
        preserve_package_identity: false,
    })
    .unwrap();
    (child, pipes.into_parent())
}

#[test]
fn plan_rejects_paths_overlap_and_unbounded_edits() {
    let valid = json!({"module":"sample.dll","sha256":"a".repeat(64),"patches":[{"fileOffset":4096,"expected":[0],"replacement":[1]}]});
    for module in [
        "",
        "../sample.dll",
        "C:\\sample.dll",
        "sample.dll:stream",
        "sample.dll.",
        "sub/sample.dll",
    ] {
        let mut invalid = valid.clone();
        invalid["module"] = json!(module);
        assert!(ModuleDataPlan::parse(invalid).is_err());
    }
    for patches in [
        json!([]),
        json!([valid["patches"][0], valid["patches"][0]]),
        json!([{"fileOffset":0,"expected":vec![0;65],"replacement":vec![1;65]}]),
        json!([{"fileOffset":u64::MAX,"expected":[0],"replacement":[1]}]),
    ] {
        let mut invalid = valid.clone();
        invalid["patches"] = patches;
        assert!(ModuleDataPlan::parse(invalid).is_err());
    }
}

#[test]
fn image_verification_rejects_hash_bytes_headers_and_code_sections() {
    let (_directory, image, mut plan) = fixture();
    let deadline = Instant::now() + Duration::from_secs(10);
    assert!(plan.prepare(&image, deadline).is_ok());
    let original = plan.sha256.clone();
    plan.sha256 = "0".repeat(64);
    assert_eq!(
        plan.prepare(&image, deadline).err().unwrap().code,
        "bootstrap_image_changed"
    );
    plan.sha256 = original;
    plan.patches[0].expected[0] = 47;
    assert_eq!(
        plan.prepare(&image, deadline).err().unwrap().code,
        "bootstrap_original_changed"
    );
    plan.patches[0].expected[0] = 48;
    let mut bytes = std::fs::read(&image).unwrap();
    let pe = u32_at(&bytes, 60) as usize;
    let table = pe + 24 + usize::from(u16_at(&bytes, pe + 20));
    let count = usize::from(u16_at(&bytes, pe + 6));
    let offset = plan.patches[0].file_offset;
    for section in bytes[table..].chunks_exact_mut(40).take(count) {
        if offset >= u64::from(u32_at(section, 20))
            && offset < u64::from(u32_at(section, 20)) + u64::from(u32_at(section, 16))
        {
            section[36..40].copy_from_slice(&0x60000060u32.to_le_bytes());
        }
    }
    std::fs::write(&image, &bytes).unwrap();
    plan.sha256 = format!("{:x}", Sha256::digest(&bytes));
    assert_eq!(
        plan.prepare(&image, deadline).err().unwrap().code,
        "bootstrap_executable_patch_denied"
    );
    bytes[0] = 0;
    std::fs::write(&image, &bytes).unwrap();
    plan.sha256 = format!("{:x}", Sha256::digest(&bytes));
    assert_eq!(
        plan.prepare(&image, deadline).err().unwrap().code,
        "bootstrap_image_invalid"
    );
}

#[test]
fn owned_child_observes_edit_then_restoration_and_debugger_detach() {
    let (_directory, image, plan) = fixture();
    let before = std::fs::read(&image).unwrap();
    let (mut child, pipes) = suspended(&image);
    let deadline = Instant::now() + Duration::from_secs(10);
    let session = BootstrapSession::arm(&child, &image, plan, deadline).unwrap();
    child.resume().unwrap();
    session.wait_patched(deadline).unwrap();
    let (client, _) = crate::cdp::CdpClient::spawn(pipes).unwrap();
    let first = client
        .request("Fixture.value", None, None, Duration::from_secs(2))
        .unwrap()
        .result
        .unwrap();
    assert_eq!(first["value"], 49);
    assert_eq!(first["debugger"], true);
    session.restore(deadline).unwrap();
    let restored = client
        .request("Fixture.value", None, None, Duration::from_secs(2))
        .unwrap()
        .result
        .unwrap();
    assert_eq!(restored["value"], 48);
    assert_eq!(restored["debugger"], false);
    assert_eq!(std::fs::read(&image).unwrap(), before);
    client
        .request("Browser.close", None, None, Duration::from_secs(2))
        .unwrap();
    client.shutdown().unwrap();
}

#[test]
fn abort_and_deadline_reap_only_the_owned_child() {
    for expire in [false, true] {
        let (_directory, image, plan) = fixture();
        let (mut child, _pipes) = suspended(&image);
        let deadline = Instant::now() + Duration::from_secs(2);
        let session = BootstrapSession::arm(&child, &image, plan, deadline).unwrap();
        child.resume().unwrap();
        session.wait_patched(deadline).unwrap();
        assert_eq!(
            unsafe { WaitForSingleObject(child.process.as_raw_handle(), 0) },
            WAIT_TIMEOUT
        );
        if expire {
            let result = session.done.recv_timeout(Duration::from_secs(3)).unwrap();
            assert_eq!(result.err().unwrap().code, "bootstrap_timeout");
        }
        drop(session);
        assert_eq!(
            unsafe { WaitForSingleObject(child.process.as_raw_handle(), 2000) },
            WAIT_OBJECT_0
        );
    }
}

#[test]
fn early_exit_is_reported_without_a_successful_restoration_receipt() {
    let (_directory, image, plan) = fixture();
    let (mut child, pipes) = suspended(&image);
    let deadline = Instant::now() + Duration::from_secs(10);
    let session = BootstrapSession::arm(&child, &image, plan, deadline).unwrap();
    child.resume().unwrap();
    session.wait_patched(deadline).unwrap();
    let (client, _) = crate::cdp::CdpClient::spawn(pipes).unwrap();
    client
        .request("Browser.close", None, None, Duration::from_secs(2))
        .unwrap();
    let error = session
        .done
        .recv_timeout(Duration::from_secs(2))
        .unwrap()
        .unwrap_err();
    assert_eq!(error.code, "bootstrap_client_exited");
    drop(session);
    client.shutdown().unwrap();
    assert_eq!(
        unsafe { WaitForSingleObject(child.process.as_raw_handle(), 2000) },
        WAIT_OBJECT_0
    );
}

#[test]
fn failed_restore_reaps_the_client_instead_of_overwriting_changed_memory() {
    let (_directory, image, plan) = fixture();
    let (mut child, pipes) = suspended(&image);
    let deadline = Instant::now() + Duration::from_secs(10);
    let session = BootstrapSession::arm(&child, &image, plan, deadline).unwrap();
    child.resume().unwrap();
    session.wait_patched(deadline).unwrap();
    let (client, _) = crate::cdp::CdpClient::spawn(pipes).unwrap();
    client
        .request("Fixture.corrupt", None, None, Duration::from_secs(2))
        .unwrap();
    assert_eq!(
        session.restore(deadline).unwrap_err().code,
        "bootstrap_memory_changed"
    );
    assert_eq!(
        unsafe { WaitForSingleObject(child.process.as_raw_handle(), 2000) },
        WAIT_OBJECT_0
    );
    client.shutdown().unwrap();
}

#[test]
fn changed_image_rejection_never_resumes_the_uncommitted_child() {
    let (_directory, image, mut plan) = fixture();
    plan.sha256 = "0".repeat(64);
    let (child, _pipes) = suspended(&image);
    let observer = child.process.try_clone().unwrap();
    assert_eq!(
        BootstrapSession::arm(
            &child,
            &image,
            plan,
            Instant::now() + Duration::from_secs(10)
        )
        .err()
        .unwrap()
        .code,
        "bootstrap_image_changed"
    );
    assert_eq!(
        unsafe { WaitForSingleObject(observer.as_raw_handle(), 0) },
        WAIT_TIMEOUT
    );
    drop(child);
    assert_eq!(
        unsafe { WaitForSingleObject(observer.as_raw_handle(), 2000) },
        WAIT_OBJECT_0
    );
}
