//! Shared transport defaults; callers still own origins, timeouts and proxies.
use std::sync::Once;

pub(crate) fn builder() -> reqwest::ClientBuilder {
    static CRYPTO: Once = Once::new();
    CRYPTO.call_once(|| {
        // reqwest's no-provider feature requires explicit initialization.
        // Another Rust component may already have installed the process default.
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
    // Preserve WebPKI validation over OS roots plus each caller's explicitly
    // authorized CA. reqwest 0.13's platform verifier changes private-CA policy
    // on macOS. Skip legacy roots that WebPKI cannot parse, as reqwest 0.12 did.
    let mut roots = rustls::RootCertStore::empty();
    let certificates = rustls_native_certs::load_native_certs()
        .certs
        .into_iter()
        .filter_map(|certificate| {
            roots.add(certificate.clone()).ok()?;
            reqwest::Certificate::from_der(certificate.as_ref()).ok()
        });
    reqwest::Client::builder()
        .tls_backend_rustls()
        .tls_certs_only(certificates)
        // Retries belong to the operation owner, which knows whether replay is safe.
        .retry(reqwest::retry::never())
}

#[cfg(windows)]
pub(crate) fn native_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .tls_backend_native()
        .retry(reqwest::retry::never())
}
