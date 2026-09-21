fn main() {
    println!("cargo:rerun-if-changed=native/windows-restart-bridge.c");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    let compiler = cc::Build::new().get_compiler();
    let mut command = compiler.to_command();
    if compiler.is_like_msvc() {
        command.args([
            "/nologo",
            "/O2",
            "/LD",
            "/MT",
            "native/windows-restart-bridge.c",
        ]);
        command.arg(format!(
            "/Fo{}",
            output.join("restart-bridge.obj").display()
        ));
        command.arg("/link").arg(format!(
            "/OUT:{}",
            output.join("codlet-restart-bridge.dll").display()
        ));
        command.args(["kernel32.lib", "user32.lib"]);
    } else {
        command.args([
            "-shared",
            "-O2",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-Wno-cast-function-type",
            "native/windows-restart-bridge.c",
            "-o",
        ]);
        command.arg(output.join("codlet-restart-bridge.dll"));
        command.args(["-Wl,--no-insert-timestamp", "-luser32"]);
    }
    let status = command
        .status()
        .expect("start native restart bridge compiler");
    assert!(status.success(), "native restart bridge compilation failed");
    println!("cargo:rerun-if-changed=native/windows-restart-fixture.c");
    // Debug-only real Windows API fixture; never included in the product binary.
    if std::env::var("PROFILE").as_deref() == Ok("debug") {
        for (filename, dll) in [
            ("restart-fixture.dll", true),
            ("restart-fixture.exe", false),
        ] {
            let mut command = compiler.to_command();
            if compiler.is_like_msvc() {
                command.args(["/nologo", "/O2", "/MT", "native/windows-restart-fixture.c"]);
                if dll {
                    command.args(["/LD", "/DFIXTURE_DLL"]);
                }
                command.arg(format!(
                    "/Fo{}",
                    output.join(format!("{filename}.obj")).display()
                ));
                command
                    .arg("/link")
                    .arg(format!("/OUT:{}", output.join(filename).display()))
                    .args(["kernel32.lib", "user32.lib"]);
            } else {
                command
                    .args(["-O2", "native/windows-restart-fixture.c", "-o"])
                    .arg(output.join(filename));
                if dll {
                    command.args(["-shared", "-DFIXTURE_DLL"]);
                } else {
                    command.arg("-municode");
                }
                command.arg("-luser32");
            }
            assert!(
                command
                    .status()
                    .expect("compile native test fixture")
                    .success()
            );
        }
    }
}
