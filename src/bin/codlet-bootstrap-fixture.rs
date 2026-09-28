//! Small standalone native test peer: avoids linking the full Core's debug data.
#[cfg(windows)]
fn main() {
    use std::fs::File;
    use std::io::{BufRead, BufReader, Write};
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::System::{
        Diagnostics::Debug::CheckRemoteDebuggerPresent, Threading::GetCurrentProcess,
    };
    static mut CELL: [u8; 33] = *b"Codlet-owned-bootstrap-fixture:0!";
    let pipes = std::env::args()
        .find_map(|arg| {
            arg.strip_prefix("--remote-debugging-io-pipes=")
                .map(str::to_owned)
        })
        .unwrap();
    let (read, write) = pipes.split_once(',').unwrap();
    let input = unsafe { File::from_raw_handle(read.parse::<usize>().unwrap() as _) };
    let mut output = unsafe { File::from_raw_handle(write.parse::<usize>().unwrap() as _) };
    for bytes in BufReader::new(input).split(0) {
        let request: serde_json::Value = serde_json::from_slice(&bytes.unwrap()).unwrap();
        let mut debugger = 0;
        let value = unsafe {
            if request["method"] == "Fixture.corrupt" {
                std::ptr::write_volatile(std::ptr::addr_of_mut!(CELL).cast::<u8>().add(31), 50);
            }
            CheckRemoteDebuggerPresent(GetCurrentProcess(), &mut debugger);
            std::ptr::read_volatile(std::ptr::addr_of!(CELL).cast::<u8>().add(31))
        };
        let result = serde_json::json!({"id":request["id"],"result":{"value":value,"debugger":debugger != 0}});
        output.write_all(result.to_string().as_bytes()).unwrap();
        output.write_all(&[0]).unwrap();
        if request["method"] == "Browser.close" {
            break;
        }
    }
}
#[cfg(not(windows))]
fn main() {}
