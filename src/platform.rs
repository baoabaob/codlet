//! Explicit desktop targets. Architecture alone must never select a Windows
//! executable on another operating system.
#[cfg(any(windows, target_os = "macos"))]
pub(crate) mod host;
pub(crate) mod path;
#[cfg(target_os = "macos")]
pub(crate) use crate::macos::filesystem as directory;
#[cfg(target_os = "macos")]
pub(crate) use crate::macos::{control_pipe, folder_dialog, launch_mutex, open_folder};
#[cfg(windows)]
pub(crate) use crate::windows::owned_directory as directory;
#[cfg(windows)]
pub(crate) use crate::windows::{control_pipe, folder_dialog, launch_mutex, open_folder};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopTarget {
    WindowsX64,
    WindowsArm64,
    MacOsArm64,
}

impl DesktopTarget {
    pub fn for_system(os: &str, architecture: &str) -> Option<Self> {
        match (os, architecture) {
            ("windows", "x86_64") => Some(Self::WindowsX64),
            ("windows", "aarch64") => Some(Self::WindowsArm64),
            ("macos", "aarch64") => Some(Self::MacOsArm64),
            _ => None,
        }
    }

    pub fn current() -> Option<Self> {
        Self::for_system(std::env::consts::OS, std::env::consts::ARCH)
    }

    pub fn node_platform(self) -> &'static str {
        match self {
            Self::WindowsX64 => "win-x64",
            Self::WindowsArm64 => "win-arm64",
            Self::MacOsArm64 => "darwin-arm64",
        }
    }

    pub fn node_executable(self) -> &'static str {
        match self {
            Self::WindowsX64 | Self::WindowsArm64 => "node.exe",
            Self::MacOsArm64 => "bin/node",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn os_and_architecture_jointly_select_the_runtime() {
        for ((os, arch), expected) in [
            (("windows", "x86_64"), Some(("win-x64", "node.exe"))),
            (("windows", "aarch64"), Some(("win-arm64", "node.exe"))),
            (("macos", "aarch64"), Some(("darwin-arm64", "bin/node"))),
            (("macos", "x86_64"), None),
            (("linux", "x86_64"), None),
            (("linux", "aarch64"), None),
            (("windows", "x86"), None),
        ] {
            assert_eq!(
                DesktopTarget::for_system(os, arch)
                    .map(|target| (target.node_platform(), target.node_executable())),
                expected
            );
        }
    }
}
