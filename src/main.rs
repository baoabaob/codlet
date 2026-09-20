#[cfg(windows)]
fn main() {
    if let Err(error) = codlet::probe::run_cli(std::env::args_os().skip(1)) {
        eprintln!("codlet: {error}");
        codlet::runtime_log::error("core_failed", &error.to_string());
        std::process::exit(1);
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn main() {
    if let Err(error) = codlet::macos::cli::run(std::env::args_os().skip(1)) {
        eprintln!("codlet: {error}");
        codlet::runtime_log::error("core_failed", &error.to_string());
        std::process::exit(1);
    }
}

#[cfg(not(any(windows, all(target_os = "macos", target_arch = "aarch64"))))]
fn main() {
    eprintln!("Codlet targets Windows x64/ARM64 and macOS ARM64; this platform is not supported");
    std::process::exit(1);
}
