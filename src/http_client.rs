//! Shared transport defaults; callers still own origins, timeouts and proxies.
use std::sync::Once;

pub(crate) fn builder() -> reqwest::ClientBuilder {
    static CRYPTO: Once = Once::new();
    CRYPTO.call_once(|| {
        // reqwest's no-provider feature requires explicit initialization.
        // Another Rust component may already have installed the process default.
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
    reqwest::Client::builder()
        .tls_backend_rustls()
        // Retries belong to the operation owner, which knows whether replay is safe.
        .retry(reqwest::retry::never())
}
