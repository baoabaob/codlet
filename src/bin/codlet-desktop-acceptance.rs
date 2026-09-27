#[cfg(windows)]
fn main() {
    if std::env::args_os()
        .nth(1)
        .is_some_and(|arg| arg == "--internal-package-launch")
    {
        if let Err(error) = codlet::probe::run_cli(std::env::args_os().skip(1)) {
            eprintln!("package helper: {error}");
            std::process::exit(1);
        }
        return;
    }
    codlet::probe::run_desktop_acceptance();
}

#[cfg(not(windows))]
fn main() {
    eprintln!("This acceptance harness requires Windows package identity.");
    std::process::exit(1);
}
