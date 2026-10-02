#[cfg(windows)]
fn main() {
    // Management must use the same executable identity as the owned server.
    // A command-bearing invocation retains the ordinary scoped Core CLI.
    if std::env::args_os().nth(1).is_some() {
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
