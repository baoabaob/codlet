use std::collections::BTreeMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use url::Url;

use super::{
    Namespace, Result, ServiceError, ServiceOwner, ServiceRoot, atomic_json, decode, lock_file,
    read_json,
};

const DOCUMENT_BYTES: u64 = 256 * 1024;
const MAX_CREDENTIALS: usize = 256;
const MAX_SECRET_BYTES: usize = 2048;
const MAX_LABEL_BYTES: usize = 128;
const MAX_REFERENCE_ATTEMPTS: usize = 8;

#[derive(Clone)]
pub(super) struct PluginSecrets {
    root: ServiceRoot,
    backend: Arc<dyn SecretBackend>,
}

pub struct SecretValue(SecretBuffer);

impl SecretValue {
    pub(crate) fn as_str(&self) -> &str {
        std::str::from_utf8(&self.0.0).expect("credential secrets are validated as UTF-8")
    }
}

impl std::fmt::Debug for SecretValue {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("SecretValue([REDACTED])")
    }
}

struct SecretBuffer(Vec<u8>);

impl Drop for SecretBuffer {
    fn drop(&mut self) {
        for byte in &mut self.0 {
            unsafe { std::ptr::write_volatile(byte, 0) };
        }
    }
}

trait SecretBackend: Send + Sync {
    fn put(&self, target: &str, username: &str, secret: &[u8]) -> Result<()>;
    fn get(&self, target: &str) -> Result<Option<SecretBuffer>>;
    fn delete(&self, target: &str) -> Result<()>;
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CredentialDocument {
    schema: u32,
    revision: u64,
    #[serde(default)]
    credentials: BTreeMap<String, CredentialMetadata>,
}

impl Default for CredentialDocument {
    fn default() -> Self {
        Self {
            schema: 1,
            revision: 0,
            credentials: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CredentialMetadata {
    reference: String,
    origin: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    created_revision: u64,
    updated_revision: u64,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListInput {
    origin: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MetadataInput {
    reference: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PutInput {
    expected_revision: u64,
    #[serde(default)]
    reference: Option<String>,
    origin: String,
    #[serde(default)]
    label: Option<String>,
    secret: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoveInput {
    expected_revision: u64,
    reference: String,
}

impl PluginSecrets {
    #[cfg(feature = "test-fixtures")]
    pub(super) fn fixture(root: ServiceRoot) -> Self {
        #[derive(Default)]
        struct Memory(std::sync::Mutex<BTreeMap<String, Vec<u8>>>);
        impl SecretBackend for Memory {
            fn put(&self, target: &str, _: &str, secret: &[u8]) -> Result<()> {
                self.0
                    .lock()
                    .unwrap()
                    .insert(target.into(), secret.to_vec());
                Ok(())
            }
            fn get(&self, target: &str) -> Result<Option<SecretBuffer>> {
                Ok(self
                    .0
                    .lock()
                    .unwrap()
                    .get(target)
                    .cloned()
                    .map(SecretBuffer))
            }
            fn delete(&self, target: &str) -> Result<()> {
                self.0.lock().unwrap().remove(target);
                Ok(())
            }
        }
        Self {
            root,
            backend: Arc::new(Memory::default()),
        }
    }
    pub(super) fn system(root: ServiceRoot) -> Self {
        Self {
            root,
            backend: system_backend(),
        }
    }

    #[cfg(test)]
    fn with_backend(root: ServiceRoot, backend: Arc<dyn SecretBackend>) -> Self {
        Self { root, backend }
    }

    pub(super) fn invoke(
        &self,
        owner: &ServiceOwner,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        let namespace = self.root.namespace(owner)?;
        match method {
            "list" => {
                let input = if params.is_null() {
                    ListInput::default()
                } else {
                    decode(params)?
                };
                self.list(&namespace, input)
            }
            "metadata" => self.metadata(&namespace, decode(params)?),
            "put" => self.put(owner, &namespace, decode(params)?),
            "remove" => self.remove(owner, &namespace, decode(params)?),
            _ => Err(ServiceError::new(
                "method_not_found",
                "credential method is not registered",
            )),
        }
    }

    pub(super) fn resolve(
        &self,
        owner: &ServiceOwner,
        reference: &str,
        origin: &str,
    ) -> Result<SecretValue> {
        validate_reference(reference)?;
        let origin = normalize_origin(origin)?;
        let namespace = self.root.namespace(owner)?;
        let _lock = lock_file(&namespace.path.join("credentials.lock"))?;
        let document = self.read(&namespace)?;
        let metadata = document.credentials.get(reference).ok_or_else(not_found)?;
        if metadata.origin != origin {
            return Err(ServiceError::new(
                "credential_origin_mismatch",
                "credential reference is not bound to the requested origin",
            ));
        }
        let target = target(&namespace, reference);
        let secret = self.backend.get(&target)?.ok_or_else(|| {
            ServiceError::new(
                "credential_unavailable",
                "credential metadata exists but its system credential is unavailable",
            )
        })?;
        if std::str::from_utf8(&secret.0).is_err() {
            return Err(ServiceError::new(
                "credential_unavailable",
                "system credential has an unsupported representation",
            ));
        }
        Ok(SecretValue(secret))
    }

    fn read(&self, namespace: &Namespace) -> Result<CredentialDocument> {
        let document = read_json(&namespace.path.join("credentials.json"), DOCUMENT_BYTES)?
            .unwrap_or_default();
        validate_document(&document)?;
        Ok(document)
    }

    fn list(&self, namespace: &Namespace, input: ListInput) -> Result<Value> {
        let origin = input
            .origin
            .map(|origin| normalize_origin(&origin))
            .transpose()?;
        let document = self.read(namespace)?;
        let credentials = document
            .credentials
            .values()
            .filter(|metadata| {
                origin
                    .as_ref()
                    .is_none_or(|origin| metadata.origin.as_str() == origin)
            })
            .map(metadata_value)
            .collect::<Vec<_>>();
        Ok(json!({"revision": document.revision, "credentials": credentials}))
    }

    fn metadata(&self, namespace: &Namespace, input: MetadataInput) -> Result<Value> {
        validate_reference(&input.reference)?;
        let document = self.read(namespace)?;
        let metadata = document
            .credentials
            .get(&input.reference)
            .ok_or_else(not_found)?;
        Ok(json!({"revision": document.revision, "credential": metadata_value(metadata)}))
    }

    fn put(&self, owner: &ServiceOwner, namespace: &Namespace, input: PutInput) -> Result<Value> {
        let origin = normalize_origin(&input.origin)?;
        validate_label(input.label.as_deref())?;
        let secret = SecretBuffer(input.secret.into_bytes());
        if secret.0.is_empty() || secret.0.len() > MAX_SECRET_BYTES {
            return Err(ServiceError::new(
                "invalid_params",
                "credential secret must contain 1..2048 UTF-8 bytes",
            ));
        }
        let _lock = lock_file(&namespace.path.join("credentials.lock"))?;
        let path = namespace.path.join("credentials.json");
        let mut document = self.read(namespace)?;
        check_revision(document.revision, input.expected_revision)?;
        if document.revision == ((1_u64 << 53) - 1) {
            return Err(ServiceError::new(
                "revision_exhausted",
                "credential metadata revision is exhausted",
            ));
        }
        let reference = match input.reference {
            Some(reference) => {
                validate_reference(&reference)?;
                let current = document.credentials.get(&reference).ok_or_else(not_found)?;
                if current.origin != origin {
                    return Err(ServiceError::new(
                        "credential_origin_immutable",
                        "remove and recreate a credential to bind it to another origin",
                    ));
                }
                reference
            }
            None => {
                if document.credentials.len() >= MAX_CREDENTIALS {
                    return Err(ServiceError::new(
                        "quota_exceeded",
                        "credential count exceeds its quota",
                    ));
                }
                self.new_reference(namespace, &document)?
            }
        };
        let target = target(namespace, &reference);
        let previous = self.backend.get(&target)?;
        if document.credentials.contains_key(&reference) && previous.is_none() {
            return Err(ServiceError::new(
                "credential_unavailable",
                "credential metadata exists but its system credential is unavailable",
            ));
        }
        self.backend
            .put(&target, &owner.plugin_id, secret.0.as_slice())?;
        let next_revision = document.revision + 1;
        let created_revision = document
            .credentials
            .get(&reference)
            .map_or(next_revision, |metadata| metadata.created_revision);
        let metadata = CredentialMetadata {
            reference: reference.clone(),
            origin,
            label: input.label,
            created_revision,
            updated_revision: next_revision,
        };
        document.revision = next_revision;
        document
            .credentials
            .insert(reference.clone(), metadata.clone());
        if let Err(error) = atomic_json(&path, &document, DOCUMENT_BYTES) {
            let rollback = match previous {
                Some(previous) => {
                    self.backend
                        .put(&target, &owner.plugin_id, previous.0.as_slice())
                }
                None => self.backend.delete(&target),
            };
            if rollback.is_err() {
                return Err(ServiceError::new(
                    "credential_commit_uncertain",
                    "credential storage failed and rollback could not be confirmed",
                ));
            }
            return Err(error);
        }
        Ok(json!({"revision": document.revision, "credential": metadata_value(&metadata)}))
    }

    fn remove(
        &self,
        owner: &ServiceOwner,
        namespace: &Namespace,
        input: RemoveInput,
    ) -> Result<Value> {
        validate_reference(&input.reference)?;
        let _lock = lock_file(&namespace.path.join("credentials.lock"))?;
        let path = namespace.path.join("credentials.json");
        let mut document = self.read(namespace)?;
        check_revision(document.revision, input.expected_revision)?;
        if document.revision == ((1_u64 << 53) - 1) {
            return Err(ServiceError::new(
                "revision_exhausted",
                "credential metadata revision is exhausted",
            ));
        }
        if !document.credentials.contains_key(&input.reference) {
            return Err(not_found());
        }
        let target = target(namespace, &input.reference);
        let previous = self.backend.get(&target)?.ok_or_else(|| {
            ServiceError::new(
                "credential_unavailable",
                "credential metadata exists but its system credential is unavailable",
            )
        })?;
        self.backend.delete(&target)?;
        document.credentials.remove(&input.reference);
        document.revision += 1;
        if let Err(error) = atomic_json(&path, &document, DOCUMENT_BYTES) {
            if self
                .backend
                .put(&target, &owner.plugin_id, previous.0.as_slice())
                .is_err()
            {
                return Err(ServiceError::new(
                    "credential_commit_uncertain",
                    "credential removal failed and rollback could not be confirmed",
                ));
            }
            return Err(error);
        }
        Ok(json!({"revision": document.revision, "removed": true}))
    }

    fn new_reference(
        &self,
        namespace: &Namespace,
        document: &CredentialDocument,
    ) -> Result<String> {
        for _ in 0..MAX_REFERENCE_ATTEMPTS {
            let mut random = [0_u8; 24];
            fill_random(&mut random)?;
            let reference = format!(
                "cred_{}",
                random
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>()
            );
            if !document.credentials.contains_key(&reference)
                && self.backend.get(&target(namespace, &reference))?.is_none()
            {
                return Ok(reference);
            }
        }
        Err(ServiceError::new(
            "credential_unavailable",
            "could not allocate a unique credential reference",
        ))
    }
}

fn validate_document(document: &CredentialDocument) -> Result<()> {
    if document.schema != 1
        || document.revision > ((1_u64 << 53) - 1)
        || document.credentials.len() > MAX_CREDENTIALS
    {
        return Err(ServiceError::new(
            "storage_corrupt",
            "credential metadata invariants are invalid",
        ));
    }
    for (reference, metadata) in &document.credentials {
        if reference != &metadata.reference
            || validate_reference(reference).is_err()
            || !is_canonical_origin(&metadata.origin)
            || validate_label(metadata.label.as_deref()).is_err()
            || metadata.created_revision == 0
            || metadata.created_revision > metadata.updated_revision
            || metadata.updated_revision > document.revision
        {
            return Err(ServiceError::new(
                "storage_corrupt",
                "credential metadata entry is invalid",
            ));
        }
    }
    Ok(())
}

fn is_canonical_origin(origin: &str) -> bool {
    normalize_origin(origin).is_ok_and(|normalized| normalized == origin)
}

fn normalize_origin(input: &str) -> Result<String> {
    if input.len() > 2048 {
        return Err(ServiceError::new(
            "invalid_params",
            "credential origin is invalid",
        ));
    }
    let mut url = Url::parse(input)
        .map_err(|_| ServiceError::new("invalid_params", "credential origin is invalid"))?;
    if url.scheme() == "ws" {
        url.set_scheme("http")
            .expect("HTTP and WS schemes are replaceable");
    } else if url.scheme() == "wss" {
        url.set_scheme("https")
            .expect("HTTPS and WSS schemes are replaceable");
    }
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(ServiceError::new(
            "invalid_params",
            "credential origin must be an HTTP(S) origin without path, credentials, query or fragment",
        ));
    }
    Ok(url.origin().ascii_serialization())
}

fn validate_reference(reference: &str) -> Result<()> {
    if reference.len() != 53
        || !reference.starts_with("cred_")
        || !reference[5..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(ServiceError::new(
            "invalid_params",
            "credential reference is invalid",
        ));
    }
    Ok(())
}

fn validate_label(label: Option<&str>) -> Result<()> {
    if label.is_some_and(|label| {
        label.trim().is_empty()
            || label.len() > MAX_LABEL_BYTES
            || label.chars().any(char::is_control)
    }) {
        return Err(ServiceError::new(
            "invalid_params",
            "credential label must contain 1..128 readable UTF-8 bytes",
        ));
    }
    Ok(())
}

fn check_revision(current: u64, expected: u64) -> Result<()> {
    if current == expected {
        Ok(())
    } else {
        Err(ServiceError::new(
            "credential_conflict",
            "credential metadata changed in another window; read and retry",
        )
        .with_data(json!({"revision": current})))
    }
}

fn target(namespace: &Namespace, reference: &str) -> String {
    format!("{}/{reference}", namespace.credential_prefix)
}

fn metadata_value(metadata: &CredentialMetadata) -> Value {
    json!({
        "reference": &metadata.reference,
        "origin": &metadata.origin,
        "label": &metadata.label,
        "createdRevision": metadata.created_revision,
        "updatedRevision": metadata.updated_revision,
    })
}

fn not_found() -> ServiceError {
    ServiceError::new(
        "credential_not_found",
        "credential reference does not exist in this plugin namespace",
    )
}

#[cfg(windows)]
fn fill_random(bytes: &mut [u8]) -> Result<()> {
    use windows_sys::Win32::Security::Cryptography::{
        BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom,
    };
    let status = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status >= 0 {
        Ok(())
    } else {
        Err(ServiceError::new(
            "credential_unavailable",
            "system random generator is unavailable",
        ))
    }
}

#[cfg(target_os = "macos")]
fn fill_random(bytes: &mut [u8]) -> Result<()> {
    use std::io::Read;
    std::fs::File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(bytes))
        .map_err(|_| {
            ServiceError::new(
                "credential_unavailable",
                "system random generator is unavailable",
            )
        })
}

#[cfg(not(any(windows, target_os = "macos")))]
fn fill_random(_bytes: &mut [u8]) -> Result<()> {
    Err(ServiceError::new(
        "credential_unavailable",
        "system credential storage is unsupported on this platform",
    ))
}

#[cfg(windows)]
fn system_backend() -> Arc<dyn SecretBackend> {
    Arc::new(WindowsCredentialBackend)
}

#[cfg(target_os = "macos")]
fn system_backend() -> Arc<dyn SecretBackend> {
    Arc::new(MacKeychainBackend)
}

#[cfg(not(any(windows, target_os = "macos")))]
fn system_backend() -> Arc<dyn SecretBackend> {
    Arc::new(UnsupportedBackend)
}

#[cfg(windows)]
struct WindowsCredentialBackend;

#[cfg(windows)]
impl SecretBackend for WindowsCredentialBackend {
    fn put(&self, target: &str, username: &str, secret: &[u8]) -> Result<()> {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Security::Credentials::{
            CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW, CredWriteW,
        };
        let mut target = std::ffi::OsStr::new(target)
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let mut username = std::ffi::OsStr::new(username)
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let credential = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: target.as_mut_ptr(),
            CredentialBlobSize: secret.len() as u32,
            CredentialBlob: secret.as_ptr().cast_mut(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            UserName: username.as_mut_ptr(),
            ..Default::default()
        };
        if unsafe { CredWriteW(&credential, 0) } == 0 {
            return Err(windows_credential_error());
        }
        Ok(())
    }

    fn get(&self, target: &str) -> Result<Option<SecretBuffer>> {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Foundation::{ERROR_NOT_FOUND, GetLastError};
        use windows_sys::Win32::Security::Credentials::{
            CRED_TYPE_GENERIC, CREDENTIALW, CredFree, CredReadW,
        };
        let target = std::ffi::OsStr::new(target)
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let mut credential: *mut CREDENTIALW = std::ptr::null_mut();
        if unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) } == 0 {
            if unsafe { GetLastError() } == ERROR_NOT_FOUND {
                return Ok(None);
            }
            return Err(windows_credential_error());
        }
        struct OwnedCredential(*mut CREDENTIALW);
        impl Drop for OwnedCredential {
            fn drop(&mut self) {
                unsafe { CredFree(self.0.cast()) };
            }
        }
        let owned = OwnedCredential(credential);
        let credential = unsafe { &*owned.0 };
        let bytes = if credential.CredentialBlobSize == 0 {
            Vec::new()
        } else {
            unsafe {
                std::slice::from_raw_parts(
                    credential.CredentialBlob,
                    credential.CredentialBlobSize as usize,
                )
            }
            .to_vec()
        };
        Ok(Some(SecretBuffer(bytes)))
    }

    fn delete(&self, target: &str) -> Result<()> {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Security::Credentials::{CRED_TYPE_GENERIC, CredDeleteW};
        let target = std::ffi::OsStr::new(target)
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        if unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) } == 0 {
            return Err(windows_credential_error());
        }
        Ok(())
    }
}

#[cfg(windows)]
fn windows_credential_error() -> ServiceError {
    use windows_sys::Win32::Foundation::GetLastError;
    let code = unsafe { GetLastError() };
    ServiceError::new(
        "credential_unavailable",
        format!("Windows Credential Manager operation failed ({code})"),
    )
}

#[cfg(target_os = "macos")]
struct MacKeychainBackend;

#[cfg(target_os = "macos")]
mod macos_keychain {
    use std::ffi::c_void;

    pub type Item = *mut c_void;
    pub const ITEM_NOT_FOUND: i32 = -25300;

    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        pub fn SecKeychainAddGenericPassword(
            keychain: *const c_void,
            service_len: u32,
            service: *const u8,
            account_len: u32,
            account: *const u8,
            password_len: u32,
            password: *const u8,
            item: *mut Item,
        ) -> i32;
        pub fn SecKeychainFindGenericPassword(
            keychain_or_array: *const c_void,
            service_len: u32,
            service: *const u8,
            account_len: u32,
            account: *const u8,
            password_len: *mut u32,
            password: *mut *mut c_void,
            item: *mut Item,
        ) -> i32;
        pub fn SecKeychainItemModifyAttributesAndData(
            item: Item,
            attributes: *const c_void,
            length: u32,
            data: *const u8,
        ) -> i32;
        pub fn SecKeychainItemDelete(item: Item) -> i32;
        pub fn SecKeychainItemFreeContent(attributes: *const c_void, data: *mut c_void) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        pub fn CFRelease(value: *const c_void);
    }
}

#[cfg(target_os = "macos")]
impl MacKeychainBackend {
    fn find(&self, target: &str) -> Result<Option<(SecretBuffer, macos_keychain::Item)>> {
        use std::ffi::c_void;
        let service = b"Codlet Plugin Credential";
        let mut length = 0_u32;
        let mut data: *mut c_void = std::ptr::null_mut();
        let mut item = std::ptr::null_mut();
        let status = unsafe {
            macos_keychain::SecKeychainFindGenericPassword(
                std::ptr::null(),
                service.len() as u32,
                service.as_ptr(),
                target.len() as u32,
                target.as_ptr(),
                &mut length,
                &mut data,
                &mut item,
            )
        };
        if status == macos_keychain::ITEM_NOT_FOUND {
            return Ok(None);
        }
        if status != 0 {
            return Err(mac_credential_error(status));
        }
        let secret = if length == 0 {
            Vec::new()
        } else {
            unsafe { std::slice::from_raw_parts(data.cast::<u8>(), length as usize) }.to_vec()
        };
        unsafe {
            let _ = macos_keychain::SecKeychainItemFreeContent(std::ptr::null(), data);
        }
        Ok(Some((SecretBuffer(secret), item)))
    }
}

#[cfg(target_os = "macos")]
impl SecretBackend for MacKeychainBackend {
    fn put(&self, target: &str, _username: &str, secret: &[u8]) -> Result<()> {
        let service = b"Codlet Plugin Credential";
        if let Some((_previous, item)) = self.find(target)? {
            let status = unsafe {
                macos_keychain::SecKeychainItemModifyAttributesAndData(
                    item,
                    std::ptr::null(),
                    secret.len() as u32,
                    secret.as_ptr(),
                )
            };
            unsafe { macos_keychain::CFRelease(item.cast()) };
            if status != 0 {
                return Err(mac_credential_error(status));
            }
            return Ok(());
        }
        let status = unsafe {
            macos_keychain::SecKeychainAddGenericPassword(
                std::ptr::null(),
                service.len() as u32,
                service.as_ptr(),
                target.len() as u32,
                target.as_ptr(),
                secret.len() as u32,
                secret.as_ptr(),
                std::ptr::null_mut(),
            )
        };
        if status != 0 {
            return Err(mac_credential_error(status));
        }
        Ok(())
    }

    fn get(&self, target: &str) -> Result<Option<SecretBuffer>> {
        let found = self.find(target)?;
        if let Some((secret, item)) = found {
            unsafe { macos_keychain::CFRelease(item.cast()) };
            Ok(Some(secret))
        } else {
            Ok(None)
        }
    }

    fn delete(&self, target: &str) -> Result<()> {
        let Some((_secret, item)) = self.find(target)? else {
            return Err(ServiceError::new(
                "credential_unavailable",
                "system credential is unavailable",
            ));
        };
        let status = unsafe { macos_keychain::SecKeychainItemDelete(item) };
        unsafe { macos_keychain::CFRelease(item.cast()) };
        if status != 0 {
            return Err(mac_credential_error(status));
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn mac_credential_error(status: i32) -> ServiceError {
    ServiceError::new(
        "credential_unavailable",
        format!("macOS Keychain operation failed ({status})"),
    )
}

#[cfg(not(any(windows, target_os = "macos")))]
struct UnsupportedBackend;

#[cfg(not(any(windows, target_os = "macos")))]
impl SecretBackend for UnsupportedBackend {
    fn put(&self, _target: &str, _username: &str, _secret: &[u8]) -> Result<()> {
        Err(unsupported())
    }
    fn get(&self, _target: &str) -> Result<Option<SecretBuffer>> {
        Err(unsupported())
    }
    fn delete(&self, _target: &str) -> Result<()> {
        Err(unsupported())
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
fn unsupported() -> ServiceError {
    ServiceError::new(
        "credential_unavailable",
        "system credential storage is unsupported on this platform",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemoryBackend(Mutex<BTreeMap<String, Vec<u8>>>);

    impl SecretBackend for MemoryBackend {
        fn put(&self, target: &str, _username: &str, secret: &[u8]) -> Result<()> {
            self.0
                .lock()
                .unwrap()
                .insert(target.into(), secret.to_vec());
            Ok(())
        }
        fn get(&self, target: &str) -> Result<Option<SecretBuffer>> {
            Ok(self
                .0
                .lock()
                .unwrap()
                .get(target)
                .cloned()
                .map(SecretBuffer))
        }
        fn delete(&self, target: &str) -> Result<()> {
            self.0.lock().unwrap().remove(target);
            Ok(())
        }
    }

    fn fixture() -> (
        tempfile::TempDir,
        PluginSecrets,
        ServiceOwner,
        Arc<MemoryBackend>,
    ) {
        let root = tempfile::tempdir().unwrap();
        let registry = root.path().join("config.json");
        std::fs::write(&registry, b"{}").unwrap();
        let service_root = ServiceRoot::new(&registry).unwrap();
        let backend = Arc::new(MemoryBackend::default());
        (
            root,
            PluginSecrets::with_backend(service_root, backend.clone()),
            ServiceOwner {
                plugin_id: "dev.credential-test".into(),
                source_identity: "github:owner/project".into(),
            },
            backend,
        )
    }

    #[test]
    fn metadata_never_contains_secret_and_resolve_enforces_owner_and_origin() {
        let (_root, secrets, owner, backend) = fixture();
        let created = secrets
            .invoke(
                &owner,
                "put",
                json!({"expectedRevision":0,"origin":"wss://api.example.test","label":"API token","secret":"never-print-this"}),
            )
            .unwrap();
        let reference = created["credential"]["reference"].as_str().unwrap();
        let listed = secrets.invoke(&owner, "list", Value::Null).unwrap();
        assert!(!listed.to_string().contains("never-print-this"));
        assert_eq!(
            listed["credentials"][0]["origin"],
            "https://api.example.test"
        );
        assert_eq!(
            secrets
                .resolve(&owner, reference, "https://api.example.test")
                .unwrap()
                .as_str(),
            "never-print-this"
        );
        assert_eq!(
            secrets
                .resolve(&owner, reference, "https://other.example.test")
                .unwrap_err()
                .code,
            "credential_origin_mismatch"
        );
        let other = ServiceOwner {
            plugin_id: "dev.other-plugin".into(),
            source_identity: owner.source_identity.clone(),
        };
        assert_eq!(
            secrets
                .resolve(&other, reference, "https://api.example.test")
                .unwrap_err()
                .code,
            "credential_not_found"
        );
        assert_eq!(backend.0.lock().unwrap().len(), 1);
    }

    #[test]
    fn credential_metadata_uses_cas_and_origin_binding_is_immutable() {
        let (_root, secrets, owner, _backend) = fixture();
        let created = secrets
            .invoke(
                &owner,
                "put",
                json!({"expectedRevision":0,"origin":"https://api.example.test","secret":"first"}),
            )
            .unwrap();
        let reference = created["credential"]["reference"].as_str().unwrap();
        assert_eq!(
            secrets
                .invoke(
                    &owner,
                    "put",
                    json!({"expectedRevision":0,"reference":reference,"origin":"https://api.example.test","secret":"stale"}),
                )
                .unwrap_err()
                .code,
            "credential_conflict"
        );
        assert_eq!(
            secrets
                .invoke(
                    &owner,
                    "put",
                    json!({"expectedRevision":1,"reference":reference,"origin":"https://other.example.test","secret":"move"}),
                )
                .unwrap_err()
                .code,
            "credential_origin_immutable"
        );
        assert_eq!(
            secrets
                .invoke(
                    &owner,
                    "remove",
                    json!({"expectedRevision":1,"reference":reference}),
                )
                .unwrap()["revision"],
            2
        );
        assert_eq!(
            secrets
                .resolve(&owner, reference, "https://api.example.test")
                .unwrap_err()
                .code,
            "credential_not_found"
        );
    }

    #[test]
    fn changed_source_cannot_inherit_metadata_or_system_secret() {
        let (_root, secrets, owner, backend) = fixture();
        let created = secrets
            .invoke(
                &owner,
                "put",
                json!({"expectedRevision":0,"origin":"https://api.example.test","secret":"source-bound"}),
            )
            .unwrap();
        let reference = created["credential"]["reference"].as_str().unwrap();
        let changed = ServiceOwner {
            plugin_id: owner.plugin_id.clone(),
            source_identity: "github:another/repository".into(),
        };
        assert_eq!(
            secrets
                .resolve(&changed, reference, "https://api.example.test")
                .unwrap_err()
                .code,
            "source_identity_changed"
        );
        assert_eq!(backend.0.lock().unwrap().len(), 1);
    }

    #[test]
    fn secret_debug_output_is_redacted_and_origins_reject_paths_and_userinfo() {
        let (_root, secrets, owner, _backend) = fixture();
        let created = secrets
            .invoke(
                &owner,
                "put",
                json!({"expectedRevision":0,"origin":"https://api.example.test","secret":"do-not-render"}),
            )
            .unwrap();
        let reference = created["credential"]["reference"].as_str().unwrap();
        let value = secrets
            .resolve(&owner, reference, "https://api.example.test")
            .unwrap();
        let rendered = format!("{value:?}");
        assert_eq!(rendered, "SecretValue([REDACTED])");
        assert!(!rendered.contains("do-not-render"));
        for origin in [
            "https://api.example.test/path",
            "https://user@api.example.test",
            "file:///tmp/secret",
        ] {
            assert_eq!(normalize_origin(origin).unwrap_err().code, "invalid_params");
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_credential_manager_round_trip_uses_a_random_test_target_and_cleans_it() {
        let root = tempfile::tempdir().unwrap();
        let registry = root.path().join("config.json");
        std::fs::write(&registry, b"{}").unwrap();
        let service_root = ServiceRoot::new(&registry).unwrap();
        let secrets = PluginSecrets::system(service_root);
        let mut random = [0_u8; 8];
        fill_random(&mut random).unwrap();
        let owner = ServiceOwner {
            plugin_id: format!(
                "dev.credential-test-{}",
                random
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>()
            ),
            source_identity: "test:windows-credential-manager".into(),
        };
        let created = secrets
            .invoke(
                &owner,
                "put",
                json!({"expectedRevision":0,"origin":"https://credential-test.invalid","secret":"random-test-value"}),
            )
            .unwrap();
        let reference = created["credential"]["reference"]
            .as_str()
            .unwrap()
            .to_owned();
        struct Cleanup<'a> {
            secrets: &'a PluginSecrets,
            owner: &'a ServiceOwner,
            reference: String,
        }
        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                if let Ok(namespace) = self.secrets.root.namespace(self.owner) {
                    let _ = self
                        .secrets
                        .backend
                        .delete(&target(&namespace, &self.reference));
                }
            }
        }
        let cleanup = Cleanup {
            secrets: &secrets,
            owner: &owner,
            reference: reference.clone(),
        };
        assert_eq!(
            secrets
                .resolve(&owner, &reference, "https://credential-test.invalid")
                .unwrap()
                .as_str(),
            "random-test-value"
        );
        secrets
            .invoke(
                &owner,
                "remove",
                json!({"expectedRevision":1,"reference":reference}),
            )
            .unwrap();
        drop(cleanup);
    }
}
