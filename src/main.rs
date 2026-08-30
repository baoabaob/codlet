#[cfg(windows)]
fn main() {
    if let Err(error) = codlet::probe::run_cli(std::env::args_os().skip(1)) {
        eprintln!("codlet: {error}");
        std::process::exit(1);
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("codlet M0 is Windows-only");
    std::process::exit(1);
}
