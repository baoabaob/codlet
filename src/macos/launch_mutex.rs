use std::{fs::File, io, time::Duration};
pub struct LaunchMutexGuard {
    _file: File,
}
impl LaunchMutexGuard {
    pub fn acquire_current_user(timeout: Duration) -> io::Result<Self> {
        Ok(Self {
            _file: super::control_pipe::lock_file(
                &super::control_pipe::socket_root()?.join("launch.lock"),
                timeout,
            )?,
        })
    }
}
