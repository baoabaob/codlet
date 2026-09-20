//! Registry paths are case-insensitive on Windows. POSIX names (including a
//! literal backslash) must not be rewritten using Windows path rules.
use std::path::Path;

pub(crate) fn path_key(path: &Path) -> String {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy().replace('/', "\\");
        text.strip_prefix("\\\\?\\")
            .unwrap_or(&text)
            .trim_end_matches('\\')
            .to_lowercase()
    }
    #[cfg(not(windows))]
    path.to_string_lossy().into_owned()
}
pub(crate) fn same_path(left: &Path, right: &Path) -> bool {
    path_key(left) == path_key(right)
}
pub(crate) fn within(path: &Path, root: &Path) -> bool {
    #[cfg(windows)]
    {
        let path = path_key(path);
        let root = path_key(root);
        path == root
            || path
                .strip_prefix(&root)
                .is_some_and(|tail| tail.starts_with('\\'))
    }
    #[cfg(not(windows))]
    path.starts_with(root)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    #[test]
    fn posix_containment_keeps_case_and_literal_backslashes() {
        assert!(within(
            Path::new("/plugins/demo/entry.js"),
            Path::new("/plugins/demo")
        ));
        assert!(!within(
            Path::new("/plugins/demo-other"),
            Path::new("/plugins/demo")
        ));
        assert!(!same_path(
            Path::new("/plugins/demo"),
            Path::new("/plugins/Demo")
        ));
        assert!(!same_path(
            Path::new("/plugins/a\\b"),
            Path::new("/plugins/a/b")
        ));
    }
}
