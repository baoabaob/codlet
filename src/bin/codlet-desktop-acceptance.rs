#[cfg(windows)]
fn main() {
    codlet::probe::run_desktop_acceptance();
}

#[cfg(not(windows))]
fn main() {
    eprintln!("This acceptance harness requires Windows package identity.");
    std::process::exit(1);
}
