use super::*;
use rcgen::{
    BasicConstraints, CertificateParams, CertifiedIssuer, DnType, ExtendedKeyUsagePurpose, IsCa,
    KeyPair, KeyUsagePurpose,
};

// Only the Native owner holds the CA signing key. Leaf material travels solely
// over its authenticated gateway connection and is never persisted or logged.
pub(super) struct Certificates {
    issuer: CertifiedIssuer<'static, KeyPair>,
    leaves: BTreeMap<String, (Instant, Value)>,
}
impl Certificates {
    pub(super) fn new() -> Result<Self> {
        let now = time::OffsetDateTime::now_utc();
        let mut params = CertificateParams::default();
        params.not_before = now - time::Duration::minutes(5);
        params.not_after = now + time::Duration::days(30);
        params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
        params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
        params
            .distinguished_name
            .push(DnType::CommonName, "Codlet private launch traffic");
        let issuer = CertifiedIssuer::self_signed(params, KeyPair::generate().map_err(cert_error)?)
            .map_err(cert_error)?;
        Ok(Self {
            issuer,
            leaves: BTreeMap::new(),
        })
    }
    pub(super) fn pem(&self) -> String {
        self.issuer.pem()
    }
    pub(super) fn leaf(&mut self, hostname: &str) -> Result<Value> {
        let now = Instant::now();
        self.leaves.retain(|_, (expires, _)| *expires > now);
        if let Some((_, value)) = self.leaves.get(hostname) {
            return Ok(value.clone());
        }
        if self.leaves.len() >= 64 {
            return Err(error("resource_limit", "launch certificate limit reached"));
        }
        let mut params = CertificateParams::new(vec![hostname.into()]).map_err(cert_error)?;
        params.not_before = time::OffsetDateTime::now_utc() - time::Duration::minutes(5);
        params.not_after = time::OffsetDateTime::now_utc() + time::Duration::days(1);
        params.is_ca = IsCa::ExplicitNoCa;
        params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        let key = KeyPair::generate().map_err(cert_error)?;
        let cert = params.signed_by(&key, &self.issuer).map_err(cert_error)?;
        let value = json!({"cert":cert.pem(),"key":key.serialize_pem()});
        self.leaves.insert(
            hostname.into(),
            (now + Duration::from_secs(12 * 60 * 60), value.clone()),
        );
        Ok(value)
    }
}
fn cert_error(_: rcgen::Error) -> ServiceError {
    error(
        "certificate_unavailable",
        "cannot prepare the private launch certificate",
    )
}
