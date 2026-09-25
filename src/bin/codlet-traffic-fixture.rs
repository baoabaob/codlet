fn main() {
    if let Err(error) = codlet::run_traffic_fixture() {
        eprintln!("traffic fixture failed: {}", error.code);
        std::process::exit(1);
    }
}
