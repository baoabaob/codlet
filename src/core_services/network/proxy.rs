//! Native, per-destination system proxy resolution. No environment inheritance
//! or silent direct fallback on resolver failure.
use super::*;

#[cfg(windows)]
pub(super) fn system_proxy(target: &url::Url) -> Result<Option<String>> {
    use std::ptr::null;
    use windows_sys::Win32::{Foundation::GlobalFree, Networking::WinHttp::*};
    unsafe fn text(ptr: *const u16) -> Result<String> {
        if ptr.is_null() {
            return Ok(String::new());
        }
        let mut n = 0;
        while n < 32768 && unsafe { *ptr.add(n) } != 0 {
            n += 1;
        }
        if n == 32768 {
            return Err(error(
                "proxy_resolution_failed",
                "system proxy value exceeds limit",
            ));
        }
        String::from_utf16(unsafe { std::slice::from_raw_parts(ptr, n) }).map_err(|_| {
            error(
                "proxy_resolution_failed",
                "system proxy is not valid Unicode",
            )
        })
    }
    struct Config(WINHTTP_CURRENT_USER_IE_PROXY_CONFIG);
    impl Drop for Config {
        fn drop(&mut self) {
            unsafe {
                for ptr in [
                    self.0.lpszProxy,
                    self.0.lpszProxyBypass,
                    self.0.lpszAutoConfigUrl,
                ] {
                    if !ptr.is_null() {
                        GlobalFree(ptr.cast());
                    }
                }
            }
        }
    }
    struct Info(WINHTTP_PROXY_INFO);
    impl Drop for Info {
        fn drop(&mut self) {
            unsafe {
                for ptr in [self.0.lpszProxy, self.0.lpszProxyBypass] {
                    if !ptr.is_null() {
                        GlobalFree(ptr.cast());
                    }
                }
            }
        }
    }
    struct Session(*mut std::ffi::c_void);
    impl Drop for Session {
        fn drop(&mut self) {
            unsafe {
                WinHttpCloseHandle(self.0);
            }
        }
    }
    unsafe {
        let mut config = Config(WINHTTP_CURRENT_USER_IE_PROXY_CONFIG::default());
        if WinHttpGetIEProxyConfigForCurrentUser(&mut config.0) == 0 {
            return Err(error(
                "proxy_resolution_failed",
                "cannot read the current user's system proxy",
            ));
        }
        if config.0.fAutoDetect != 0 || !config.0.lpszAutoConfigUrl.is_null() {
            let agent = "Codlet/1\0".encode_utf16().collect::<Vec<_>>();
            let session = Session(WinHttpOpen(
                agent.as_ptr(),
                WINHTTP_ACCESS_TYPE_NO_PROXY,
                null(),
                null(),
                0,
            ));
            if session.0.is_null() {
                return Err(error(
                    "proxy_resolution_failed",
                    "cannot initialize native proxy resolver",
                ));
            }
            WinHttpSetTimeouts(session.0, 3000, 3000, 3000, 3000);
            let mut options = WINHTTP_AUTOPROXY_OPTIONS::default();
            if !config.0.lpszAutoConfigUrl.is_null() {
                options.dwFlags |= WINHTTP_AUTOPROXY_CONFIG_URL;
                options.lpszAutoConfigUrl = config.0.lpszAutoConfigUrl;
            }
            if config.0.fAutoDetect != 0 {
                options.dwFlags |= WINHTTP_AUTOPROXY_AUTO_DETECT;
                options.dwAutoDetectFlags =
                    WINHTTP_AUTO_DETECT_TYPE_DHCP | WINHTTP_AUTO_DETECT_TYPE_DNS_A;
            }
            // Never send the user's ambient Windows credentials to a PAC server.
            options.fAutoLogonIfChallenged = 0;
            let url = target
                .as_str()
                .encode_utf16()
                .chain(Some(0))
                .collect::<Vec<_>>();
            let mut info = Info(WINHTTP_PROXY_INFO::default());
            if WinHttpGetProxyForUrl(session.0, url.as_ptr(), &mut options, &mut info.0) == 0 {
                return Err(error(
                    "proxy_resolution_failed",
                    "system auto-proxy/PAC resolution failed",
                ));
            }
            if info.0.dwAccessType == WINHTTP_ACCESS_TYPE_NO_PROXY {
                return Ok(None);
            }
            return select_proxy(
                &text(info.0.lpszProxy)?,
                &text(info.0.lpszProxyBypass)?,
                target,
            );
        }
        select_proxy(
            &text(config.0.lpszProxy)?,
            &text(config.0.lpszProxyBypass)?,
            target,
        )
    }
}
fn select_proxy(spec: &str, bypass: &str, target: &url::Url) -> Result<Option<String>> {
    let host = target.host_str().unwrap_or("").to_ascii_lowercase();
    if bypass
        .split([';', ',', ' '])
        .filter(|s| !s.is_empty())
        .any(|pattern| {
            let pattern = pattern.to_ascii_lowercase();
            if pattern == "<local>" {
                !host.contains('.') && !host.contains(':')
            } else {
                wildcard(&pattern, &host)
                    || wildcard(
                        &pattern,
                        &format!("{}:{}", host, target.port_or_known_default().unwrap_or(0)),
                    )
                    || wildcard(&pattern, target.as_str())
            }
        })
    {
        return Ok(None);
    }
    if spec.trim().is_empty() {
        return Ok(None);
    }
    let mut selected = None;
    for entry in spec.split([';', ' ']).filter(|s| !s.is_empty()) {
        if let Some((scheme, proxy)) = entry.split_once('=') {
            if scheme == target.scheme() {
                selected = Some(proxy);
                break;
            }
        } else if !spec.contains('=') {
            selected = Some(entry);
            break;
        }
    }
    let Some(selected) = selected else {
        return Ok(None);
    };
    let value = if selected.contains("://") {
        selected.to_owned()
    } else {
        format!("http://{selected}")
    };
    validate_proxy(&value)?;
    Ok(Some(value))
}
fn wildcard(pattern: &str, value: &str) -> bool {
    let p = pattern.as_bytes();
    let v = value.as_bytes();
    let (mut i, mut j, mut star, mut matched) = (0, 0, None, 0);
    while j < v.len() {
        if i < p.len() && (p[i] == b'?' || p[i] == v[j]) {
            i += 1;
            j += 1;
        } else if i < p.len() && p[i] == b'*' {
            star = Some(i);
            i += 1;
            matched = j;
        } else if let Some(s) = star {
            matched += 1;
            j = matched;
            i = s + 1;
        } else {
            return false;
        }
    }
    while i < p.len() && p[i] == b'*' {
        i += 1;
    }
    i == p.len()
}

#[cfg(target_os = "macos")]
pub(super) fn system_proxy(target: &url::Url) -> Result<Option<String>> {
    mac::resolve(target)
}

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use std::ffi::{c_char, c_void};
    type CF = *const c_void;
    #[repr(C)]
    struct Context {
        version: isize,
        info: *mut c_void,
        retain: Option<unsafe extern "C" fn(*const c_void) -> *const c_void>,
        release: Option<unsafe extern "C" fn(*const c_void)>,
        copy_description: Option<unsafe extern "C" fn(*const c_void) -> CF>,
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(value: CF);
        fn CFRetain(value: CF) -> CF;
        fn CFEqual(a: CF, b: CF) -> u8;
        fn CFStringCreateWithBytes(
            allocator: CF,
            bytes: *const u8,
            len: isize,
            encoding: u32,
            external: u8,
        ) -> CF;
        fn CFStringGetCString(value: CF, buffer: *mut c_char, len: isize, encoding: u32) -> u8;
        fn CFURLCreateWithString(allocator: CF, value: CF, base: CF) -> CF;
        fn CFArrayGetCount(array: CF) -> isize;
        fn CFArrayGetValueAtIndex(array: CF, index: isize) -> CF;
        fn CFDictionaryGetValue(dict: CF, key: CF) -> CF;
        fn CFNumberGetValue(value: CF, kind: i32, result: *mut c_void) -> u8;
        fn CFRunLoopGetCurrent() -> CF;
        fn CFRunLoopAddSource(loop_: CF, source: CF, mode: CF);
        fn CFRunLoopRemoveSource(loop_: CF, source: CF, mode: CF);
        fn CFRunLoopSourceInvalidate(source: CF);
        fn CFRunLoopRunInMode(mode: CF, seconds: f64, return_after: u8) -> i32;
        static kCFRunLoopDefaultMode: CF;
    }
    #[link(name = "CFNetwork", kind = "framework")]
    unsafe extern "C" {
        fn CFNetworkCopySystemProxySettings() -> CF;
        fn CFNetworkCopyProxiesForURL(url: CF, settings: CF) -> CF;
        fn CFNetworkExecuteProxyAutoConfigurationURL(
            pac: CF,
            target: CF,
            callback: unsafe extern "C" fn(*mut c_void, CF, CF),
            context: *mut Context,
        ) -> CF;
        static kCFProxyTypeKey: CF;
        static kCFProxyTypeNone: CF;
        static kCFProxyTypeHTTP: CF;
        static kCFProxyTypeHTTPS: CF;
        static kCFProxyTypeAutoConfigurationURL: CF;
        static kCFProxyHostNameKey: CF;
        static kCFProxyPortNumberKey: CF;
        static kCFProxyAutoConfigurationURLKey: CF;
    }
    struct Owned(CF);
    impl Drop for Owned {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CFRelease(self.0) }
            }
        }
    }
    fn own(value: CF) -> Result<Owned> {
        if value.is_null() {
            Err(error(
                "proxy_resolution_failed",
                "macOS proxy resolver returned no result",
            ))
        } else {
            Ok(Owned(value))
        }
    }
    fn text(value: CF) -> Result<String> {
        if value.is_null() {
            return Err(error("proxy_resolution_failed", "missing proxy property"));
        }
        let mut bytes = vec![0u8; 16384];
        if unsafe {
            CFStringGetCString(
                value,
                bytes.as_mut_ptr().cast(),
                bytes.len() as isize,
                0x08000100,
            )
        } == 0
        {
            return Err(error("proxy_resolution_failed", "invalid proxy property"));
        }
        let end = bytes.iter().position(|b| *b == 0).unwrap_or(bytes.len());
        String::from_utf8(bytes[..end].to_vec())
            .map_err(|_| error("proxy_resolution_failed", "invalid proxy text"))
    }
    struct Pac {
        done: bool,
        array: Option<Owned>,
        failed: bool,
    }
    unsafe extern "C" fn callback(info: *mut c_void, array: CF, error: CF) {
        let state = unsafe { &mut *info.cast::<Pac>() };
        state.done = true;
        state.failed = !error.is_null();
        if !array.is_null() {
            state.array = Some(Owned(unsafe { CFRetain(array) }));
        }
    }
    pub(super) fn resolve(target: &url::Url) -> Result<Option<String>> {
        unsafe {
            let raw = target.as_str().as_bytes();
            let text = own(CFStringCreateWithBytes(
                std::ptr::null(),
                raw.as_ptr(),
                raw.len() as isize,
                0x08000100,
                0,
            ))?;
            let url = own(CFURLCreateWithString(
                std::ptr::null(),
                text.0,
                std::ptr::null(),
            ))?;
            let settings = own(CFNetworkCopySystemProxySettings())?;
            let proxies = own(CFNetworkCopyProxiesForURL(url.0, settings.0))?;
            if CFArrayGetCount(proxies.0) == 0 {
                return Err(error(
                    "proxy_resolution_failed",
                    "macOS returned an empty proxy list",
                ));
            }
            let first = CFArrayGetValueAtIndex(proxies.0, 0);
            let kind = CFDictionaryGetValue(first, kCFProxyTypeKey);
            if !kind.is_null() && CFEqual(kind, kCFProxyTypeAutoConfigurationURL) != 0 {
                let pac_url = CFDictionaryGetValue(first, kCFProxyAutoConfigurationURLKey);
                if pac_url.is_null() {
                    return Err(error("proxy_resolution_failed", "PAC URL is missing"));
                }
                let mut state = Pac {
                    done: false,
                    array: None,
                    failed: false,
                };
                let mut context = Context {
                    version: 0,
                    info: (&mut state as *mut Pac).cast(),
                    retain: None,
                    release: None,
                    copy_description: None,
                };
                let source = own(CFNetworkExecuteProxyAutoConfigurationURL(
                    pac_url,
                    url.0,
                    callback,
                    &mut context,
                ))?;
                let run_loop = CFRunLoopGetCurrent();
                CFRunLoopAddSource(run_loop, source.0, kCFRunLoopDefaultMode);
                let start = Instant::now();
                while !state.done && start.elapsed() < Duration::from_secs(8) {
                    CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.1, 1);
                }
                CFRunLoopSourceInvalidate(source.0);
                CFRunLoopRemoveSource(run_loop, source.0, kCFRunLoopDefaultMode);
                if !state.done || state.failed {
                    return Err(error(
                        "proxy_resolution_failed",
                        "macOS PAC resolution failed or timed out",
                    ));
                }
                return choose(
                    state
                        .array
                        .ok_or_else(|| error("proxy_resolution_failed", "PAC result is empty"))?
                        .0,
                );
            }
            choose(proxies.0)
        }
    }
    unsafe fn choose(array: CF) -> Result<Option<String>> {
        unsafe {
            if CFArrayGetCount(array) == 0 {
                return Err(error("proxy_resolution_failed", "proxy list is empty"));
            }
            let entry = CFArrayGetValueAtIndex(array, 0);
            let kind = CFDictionaryGetValue(entry, kCFProxyTypeKey);
            if kind.is_null() {
                return Err(error("proxy_resolution_failed", "proxy type is missing"));
            }
            if CFEqual(kind, kCFProxyTypeNone) != 0 {
                return Ok(None);
            }
            let scheme = if CFEqual(kind, kCFProxyTypeHTTP) != 0 {
                "http"
            } else if CFEqual(kind, kCFProxyTypeHTTPS) != 0 {
                "https"
            } else {
                return Err(error(
                    "proxy_protocol_unsupported",
                    "the system selected a proxy protocol other than HTTP(S)",
                ));
            };
            let host = text(CFDictionaryGetValue(entry, kCFProxyHostNameKey))?;
            let number = CFDictionaryGetValue(entry, kCFProxyPortNumberKey);
            let mut port = 0i32;
            if number.is_null()
                || CFNumberGetValue(number, 3, (&mut port as *mut i32).cast()) == 0
                || !(1..=65535).contains(&port)
            {
                return Err(error("proxy_resolution_failed", "proxy port is invalid"));
            }
            let host = if host.contains(':') {
                format!("[{host}]")
            } else {
                host
            };
            let value = format!("{scheme}://{host}:{port}");
            validate_proxy(&value)?;
            Ok(Some(value))
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn static_proxy_is_destination_specific_and_obeys_bypass() {
        let target = url::Url::parse("https://example.com/v1").unwrap();
        assert_eq!(
            select_proxy("http=one:80;https=two:81", "", &target).unwrap(),
            Some("http://two:81".into())
        );
        assert_eq!(
            select_proxy("proxy:8080", "*.example.com;example.com", &target).unwrap(),
            None
        );
        assert!(select_proxy("socks5://proxy:1080", "", &target).is_err());
    }
    #[test]
    fn bypass_wildcards_match_the_entire_host() {
        assert!(wildcard("*.example.com", "a.example.com"));
        assert!(!wildcard("*.example.com", "example.com.evil"));
        assert!(wildcard("?bc", "abc"));
    }
}
