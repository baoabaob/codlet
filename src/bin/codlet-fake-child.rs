#[cfg(windows)]
fn main() {
    match codlet::windows::fake_child::run(std::env::args_os().skip(1)) {
        Ok(()) => {}
        Err(codlet::windows::fake_child::FakeChildError::RequestedExit(exit_code)) => {
            std::process::exit(exit_code);
        }
        Err(error) => {
            eprintln!("codlet-fake-child: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(target_os = "macos")]
#[path = "fixtures/macos.rs"]
mod macos_fixture;

#[cfg(target_os = "macos")]
fn main() {
    if let Err(error) = macos_fixture::run() {
        eprintln!("codlet-fake-child: {error}");
        std::process::exit(1);
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
fn main() {
    eprintln!("codlet-fake-child requires Windows or macOS");
    std::process::exit(1);
}
