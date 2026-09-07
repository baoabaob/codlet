#[cfg(windows)]
fn main() {
    if let Err(error) = codlet::lab::run_cli(std::env::args_os().skip(1)) {
        eprintln!("codlet-lab: {error}");
        std::process::exit(1);
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("codlet-lab is Windows-only");
    std::process::exit(1);
}
