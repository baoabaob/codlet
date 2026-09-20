//! Same-user Unix sockets carry the existing control protocol. Scope leases,
//! peer executable/PID/birth checks and reply validation precede any mutation.
use super::host::{Channel, LocalIpcError};
use super::identity::ProcessIdentity;
use crate::runtime_control::{
    ControlBroker, ControlReport, ControlRequest, ControlStatus, MAX_CONTROL_REQUEST_BYTES,
    MAX_CONTROL_RESPONSE_BYTES, decode_request, encode_response,
};
use crate::runtime_status::StatusPublisher;
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
pub type ControlPipeError = io::Error;

pub(crate) fn socket_root() -> io::Result<PathBuf> {
    let path = PathBuf::from(format!("/private/tmp/codlet-{}", unsafe {
        libc::geteuid()
    }));
    match std::fs::DirBuilder::new().mode(0o700).create(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    let metadata = std::fs::symlink_metadata(&path)?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o777 != 0o700
    {
        return Err(io::Error::other(
            "Codlet socket directory must be private to the current user",
        ));
    }
    Ok(path)
}

#[derive(Clone)]
pub struct RegistryScope {
    path: PathBuf,
    id: String,
    root: PathBuf,
}
pub struct RegistryScopeGuard {
    scope: RegistryScope,
    _file: File,
}
impl RegistryScopeGuard {
    pub fn scope(&self) -> &RegistryScope {
        &self.scope
    }
}
impl RegistryScope {
    pub fn for_path(path: &Path) -> io::Result<Self> {
        if !path.is_absolute() {
            return Err(io::Error::other("Registry path must be absolute"));
        }
        let parent = path
            .parent()
            .ok_or_else(|| io::Error::other("Registry has no parent"))?;
        std::fs::create_dir_all(parent)?;
        let path = parent.canonicalize()?.join(
            path.file_name()
                .ok_or_else(|| io::Error::other("Registry has no name"))?,
        );
        let id = format!("{:x}", Sha256::digest(path.as_os_str().as_bytes()));
        Ok(Self {
            path,
            id,
            root: socket_root()?,
        })
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn id(&self) -> &str {
        &self.id
    }
    fn socket(&self) -> PathBuf {
        self.root.join(format!("{}.sock", &self.id[..32]))
    }
    pub fn acquire(&self, timeout: Duration) -> io::Result<RegistryScopeGuard> {
        let file = lock_file(&self.root.join(format!("{}.lock", &self.id[..32])), timeout)?;
        Ok(RegistryScopeGuard {
            scope: self.clone(),
            _file: file,
        })
    }
}
pub(crate) fn lock_file(path: &Path, timeout: Duration) -> io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.uid() != unsafe { libc::geteuid() } || metadata.nlink() != 1
    {
        return Err(io::Error::other("Invalid Codlet scope lock"));
    }
    let until = Instant::now() + timeout;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(std::fs::TryLockError::WouldBlock) if Instant::now() < until => {
                std::thread::sleep(Duration::from_millis(10))
            }
            Err(std::fs::TryLockError::WouldBlock) => {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "Registry is already owned",
                ));
            }
            Err(std::fs::TryLockError::Error(e)) => return Err(e),
        }
    }
}

struct ListenerWorker {
    worker: Option<JoinHandle<()>>,
    stop: Arc<AtomicBool>,
    path: PathBuf,
    identity: (u64, u64),
}
pub struct ControlServer {
    workers: Vec<ListenerWorker>,
    broker: ControlBroker,
    lease: RegistryScopeGuard,
}
impl ControlServer {
    pub fn bind_current_user(
        lease: RegistryScopeGuard,
        publisher: StatusPublisher,
    ) -> io::Result<Self> {
        let mut incarnation = [0u8; 16];
        unsafe {
            libc::arc4random_buf(incarnation.as_mut_ptr().cast(), incarnation.len());
        }
        publisher
            .bind_runtime_identity(incarnation, lease.scope.id())
            .map_err(io::Error::other)?;
        let broker =
            ControlBroker::with_inspection(incarnation, lease.scope.id().to_owned(), publisher);
        let scoped = ListenerWorker::bind(lease.scope.socket(), broker.clone(), false)?;
        let discovery =
            ListenerWorker::bind(lease.scope.root.join("active.sock"), broker.clone(), true)?;
        Ok(Self {
            workers: vec![scoped, discovery],
            broker,
            lease,
        })
    }
    pub fn broker(&self) -> ControlBroker {
        self.broker.clone()
    }
    pub fn scope(&self) -> &RegistryScope {
        self.lease.scope()
    }
}
impl Drop for ControlServer {
    fn drop(&mut self) {
        self.broker.stop();
        self.workers.clear();
    }
}
impl ListenerWorker {
    fn bind(path: PathBuf, broker: ControlBroker, discovery: bool) -> io::Result<Self> {
        if path.exists() {
            let metadata = std::fs::symlink_metadata(&path)?;
            if !metadata.file_type().is_socket() || metadata.uid() != unsafe { libc::geteuid() } {
                return Err(io::Error::other(
                    "Control socket path is occupied by another source",
                ));
            }
            match connect(&path, Duration::from_millis(100)) {
                Ok(_) => {
                    return Err(io::Error::new(
                        io::ErrorKind::AddrInUse,
                        "Another Core owns this endpoint",
                    ));
                }
                Err(e) if matches!(e.raw_os_error(), Some(libc::ECONNREFUSED | libc::ENOENT)) => {}
                Err(e) => return Err(e),
            }
            let current = std::fs::symlink_metadata(&path)?;
            if current.dev() != metadata.dev() || current.ino() != metadata.ino() {
                return Err(io::Error::other("Socket identity changed"));
            }
            std::fs::remove_file(&path)?;
        }
        let listener = UnixListener::bind(&path)?;
        listener.set_nonblocking(true)?;
        let metadata = std::fs::symlink_metadata(&path)?;
        let identity = (metadata.dev(), metadata.ino());
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let expected = std::env::current_exe()?.canonicalize()?;
        let worker = std::thread::Builder::new()
            .name("codlet-control".into())
            .spawn(move || {
                while !stopping.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((socket, _)) => {
                            let _ = serve(socket, &expected, &broker, stopping.clone(), discovery);
                        }
                        Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(10))
                        }
                        Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                        Err(e) => {
                            crate::runtime_log::error("control_listener", &e.to_string());
                            break;
                        }
                    }
                }
            })?;
        Ok(Self {
            worker: Some(worker),
            stop,
            path,
            identity,
        })
    }
}
impl Drop for ListenerWorker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        if std::fs::symlink_metadata(&self.path).is_ok_and(|m| (m.dev(), m.ino()) == self.identity)
        {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

fn peer(socket: &UnixStream, expected: &Path) -> io::Result<ProcessIdentity> {
    let mut uid = 0;
    let mut gid = 0;
    if unsafe { libc::getpeereid(socket.as_raw_fd(), &mut uid, &mut gid) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let mut pid = 0i32;
    let mut size = std::mem::size_of_val(&pid) as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            socket.as_raw_fd(),
            libc::SOL_LOCAL,
            libc::LOCAL_PEERPID,
            (&mut pid as *mut i32).cast(),
            &mut size,
        )
    } != 0
        || size != 4
        || pid <= 0
    {
        return Err(io::Error::other("Control peer PID is unavailable"));
    }
    let identity = ProcessIdentity::inspect(pid as u32)?;
    if uid != unsafe { libc::geteuid() } || identity.uid != uid || identity.executable != expected {
        return Err(io::Error::other(
            "Control peer does not match this user and Codlet executable",
        ));
    }
    Ok(identity)
}
fn serve(
    socket: UnixStream,
    expected: &Path,
    broker: &ControlBroker,
    stop: Arc<AtomicBool>,
    discovery: bool,
) -> io::Result<()> {
    let identity = peer(&socket, expected)?;
    let channel = Channel::from_socket(socket, stop)?;
    let deadline = Instant::now() + Duration::from_millis(750);
    let request = decode_request(&read_frame(&channel, MAX_CONTROL_REQUEST_BYTES, deadline)?)
        .map_err(|status| io::Error::other(format!("Invalid control request: {status:?}")))?;
    identity.check_live()?;
    let report = if discovery && !matches!(request, ControlRequest::Identify { .. }) {
        ControlReport::failure(
            ControlStatus::InvalidRequest,
            "Discovery accepts identify only",
        )
    } else {
        broker.handle(request)
    };
    write_frame(
        &channel,
        &encode_response(&report).map_err(io::Error::other)?,
        deadline,
    )?;
    Ok(())
}
fn ipc_error(e: LocalIpcError) -> io::Error {
    match e {
        LocalIpcError::Timeout => io::Error::new(io::ErrorKind::TimedOut, e),
        LocalIpcError::Io(e) => e,
        other => io::Error::other(other),
    }
}
fn read_frame(channel: &Channel, maximum: usize, deadline: Instant) -> io::Result<Vec<u8>> {
    fn fill(channel: &Channel, mut bytes: &mut [u8], deadline: Instant) -> io::Result<()> {
        while !bytes.is_empty() {
            let count = channel
                .read_some(bytes, Some(deadline))
                .map_err(ipc_error)?;
            if count == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "Control peer closed its frame",
                ));
            }
            bytes = &mut bytes[count..];
        }
        Ok(())
    }
    let mut header = [0u8; 4];
    fill(channel, &mut header, deadline)?;
    let length = u32::from_le_bytes(header) as usize;
    if length == 0 || length > maximum {
        return Err(io::Error::other("Invalid control frame length"));
    }
    let mut bytes = vec![0; length];
    fill(channel, &mut bytes, deadline)?;
    Ok(bytes)
}
fn write_frame(channel: &Channel, bytes: &[u8], deadline: Instant) -> io::Result<()> {
    channel
        .write_all(&(bytes.len() as u32).to_le_bytes(), deadline)
        .map_err(ipc_error)?;
    channel.write_all(bytes, deadline).map_err(ipc_error)
}
fn connect(path: &Path, timeout: Duration) -> io::Result<UnixStream> {
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    let bytes = path.as_os_str().as_bytes();
    if bytes.len() >= address.sun_path.len() {
        return Err(io::Error::other(
            "Control socket path exceeds its platform limit",
        ));
    }
    for (target, byte) in address.sun_path.iter_mut().zip(bytes) {
        *target = *byte as libc::c_char;
    }
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    address.sun_len = std::mem::size_of_val(&address) as u8;
    let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let socket = unsafe { UnixStream::from_raw_fd(fd) };
    socket.set_nonblocking(true)?;
    let enabled = 1i32;
    if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0
        || unsafe {
            libc::setsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_NOSIGPIPE,
                (&enabled as *const i32).cast(),
                4,
            )
        } != 0
    {
        return Err(io::Error::last_os_error());
    }
    let result = unsafe {
        libc::connect(
            fd,
            (&address as *const libc::sockaddr_un).cast(),
            address.sun_len as libc::socklen_t,
        )
    };
    if result != 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::EINPROGRESS) {
            return Err(error);
        }
        let mut poll = libc::pollfd {
            fd,
            events: libc::POLLOUT,
            revents: 0,
        };
        let until = Instant::now() + timeout;
        loop {
            let remaining = until.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "Control connect timed out",
                ));
            }
            let count =
                unsafe { libc::poll(&mut poll, 1, remaining.as_millis().clamp(1, 50) as i32) };
            if count > 0 {
                break;
            }
            if count < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                return Err(io::Error::last_os_error());
            }
        }
        let mut error = 0i32;
        let mut length = 4;
        if unsafe {
            libc::getsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_ERROR,
                (&mut error as *mut i32).cast(),
                &mut length,
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
        if error != 0 {
            return Err(io::Error::from_raw_os_error(error));
        }
    }
    Ok(socket)
}
pub fn query(scope: &RegistryScope, request: &ControlRequest) -> ControlReport {
    exchange(&scope.socket(), Some(scope.id()), request)
}
pub fn query_execution_inspection(scope: &RegistryScope) -> ControlReport {
    query(scope, &ControlRequest::inspect_execution())
}
pub fn discover() -> ControlReport {
    match socket_root() {
        Ok(root) => exchange(&root.join("active.sock"), None, &ControlRequest::identify()),
        Err(e) => ControlReport::failure(ControlStatus::CommunicationError, e.to_string()),
    }
}
fn exchange(path: &Path, scope: Option<&str>, request: &ControlRequest) -> ControlReport {
    let until = Instant::now() + Duration::from_millis(1500);
    let socket = match connect(path, until.saturating_duration_since(Instant::now())) {
        Ok(socket) => socket,
        Err(e) => {
            return ControlReport::failure(
                if matches!(e.raw_os_error(), Some(libc::ENOENT | libc::ECONNREFUSED)) {
                    ControlStatus::NotRunning
                } else if e.kind() == io::ErrorKind::TimedOut {
                    ControlStatus::Timeout
                } else {
                    ControlStatus::CommunicationError
                },
                e.to_string(),
            );
        }
    };
    let expected = match std::env::current_exe().and_then(|p| p.canonicalize()) {
        Ok(path) => path,
        Err(e) => return ControlReport::failure(ControlStatus::UntrustedServer, e.to_string()),
    };
    let identity = match peer(&socket, &expected) {
        Ok(identity) => identity,
        Err(e) => return ControlReport::failure(ControlStatus::UntrustedServer, e.to_string()),
    };
    let work = (|| {
        let bytes = serde_json::to_vec(request)?;
        if bytes.len() > MAX_CONTROL_REQUEST_BYTES {
            return Err(io::Error::other("Control request exceeds its limit"));
        }
        let channel = Channel::from_socket(socket, Arc::new(AtomicBool::new(false)))?;
        write_frame(&channel, &bytes, until)?;
        let reply = read_frame(&channel, MAX_CONTROL_RESPONSE_BYTES, until)?;
        identity.check_live()?;
        Ok::<_, io::Error>(crate::control_validation::decode_response(
            &reply,
            identity.pid,
            scope,
            request,
        ))
    })();
    work.unwrap_or_else(|e| {
        ControlReport::failure(
            if e.kind() == io::ErrorKind::TimedOut {
                ControlStatus::Timeout
            } else {
                ControlStatus::CommunicationError
            },
            e.to_string(),
        )
    })
}
