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

#[cfg(not(windows))]
fn main() {
    eprintln!("codlet-fake-child is Windows-only");
    std::process::exit(1);
}
