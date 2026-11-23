// Superviseur : spawn node (daemon ou relais), capture stdout/stderr vers
// `.zra/logs/`, restart si crash avec backoff, arrêt propre à la demande.
//
// Un thread de surveillance tient l'état derrière un Mutex ; le menu et la
// boucle d'événements lisent des snapshots. Les enfants meurent avec le tray :
// Job Object sous Windows, groupe de processus + PDEATHSIG sous unix.
// L'arrêt unix est gracieux (SIGTERM au groupe, SIGKILL après 3 s) ; sous
// Windows c'est kill direct, comme le faisait Stop-Process -Force.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::config::{Mode, Paths, TrayConfig};
use crate::i18n::tr;

const ROTATE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_BACKOFF: u64 = 30;
/// Au-delà de ce temps de vie, un crash repart avec un backoff court.
const STABLE_AFTER: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum RunState {
    Running,
    Stopped,
    /// Un service externe tient le port : le tray observe, ne spawn pas.
    Adopted,
}

struct State {
    cfg: TrayConfig,
    child: Option<Child>,
    wanted: bool,
    adopted: bool,
    next_retry: Instant,
    backoff: u64,
    started: Option<Instant>,
}

#[derive(Clone)]
pub struct Supervisor {
    state: Arc<Mutex<State>>,
    paths: Arc<Paths>,
    #[cfg(windows)]
    job: Arc<job::Job>,
}

impl Supervisor {
    pub fn new(cfg: TrayConfig, paths: Arc<Paths>) -> Self {
        Self {
            state: Arc::new(Mutex::new(State {
                cfg,
                child: None,
                wanted: false,
                adopted: false,
                next_retry: Instant::now(),
                backoff: 1,
                started: None,
            })),
            paths,
            // Les enfants meurent avec le tray, même tué sauvagement.
            #[cfg(windows)]
            job: Arc::new(job::Job::new().expect("job object Windows")),
        }
    }

    /// Thread de surveillance : spawn, watch, restart. À lancer une fois.
    pub fn spawn_monitor(self: &Arc<Self>) {
        let sup = self.clone();
        thread::spawn(move || loop {
            thread::sleep(Duration::from_millis(500));
            sup.tick();
        });
    }

    fn tick(&self) {
        let mut s = self.state.lock().unwrap();
        if s.adopted || !s.wanted {
            return;
        }
        if let Some(child) = s.child.as_mut() {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let uptime = s.started.map(|t| t.elapsed()).unwrap_or_default();
                    s.backoff = if uptime >= STABLE_AFTER { 1 } else { (s.backoff * 2).min(MAX_BACKOFF) };
                    eprintln!("{}", tr!("[zra-tray] {0} sorti ({1}) — relance dans {2} s", s.cfg.mode.label(), status, s.backoff));
                    s.child = None;
                    s.started = None;
                    s.next_retry = Instant::now() + Duration::from_secs(s.backoff);
                }
                Ok(None) => {}
                Err(_) => {
                    s.child = None;
                    s.started = None;
                }
            }
        }
        if s.child.is_none() && Instant::now() >= s.next_retry {
            match spawn_child(&s.cfg, &self.paths) {
                Ok(child) => {
                    #[cfg(windows)]
                    self.job.assign(&child);
                    s.child = Some(child);
                    s.started = Some(Instant::now());
                }
                Err(err) => {
                    eprintln!("{}", tr!("[zra-tray] spawn impossible : {0} — retry dans {1} s", err, s.backoff));
                    s.next_retry = Instant::now() + Duration::from_secs(s.backoff);
                    s.backoff = (s.backoff * 2).min(MAX_BACKOFF);
                }
            }
        }
    }

    pub fn start(&self) {
        let mut s = self.state.lock().unwrap();
        s.wanted = true;
        s.next_retry = Instant::now();
        s.backoff = 1;
    }

    pub fn stop(&self) {
        let mut s = self.state.lock().unwrap();
        s.wanted = false;
        if let Some(mut child) = s.child.take() {
            kill_child(&mut child);
        }
        s.started = None;
    }

    pub fn restart(&self) {
        self.stop();
        self.start();
    }

    /// Bascule de mode : arrêt du service courant, config sauvée, lancement.
    pub fn switch_mode(&self, mode: Mode) {
        self.stop();
        {
            let mut s = self.state.lock().unwrap();
            s.cfg.mode = mode;
            let _ = self.paths.save_config(&s.cfg);
        }
        self.start();
    }

    /// Un service externe répond déjà : observateur, pas de spawn.
    pub fn adopt(&self) {
        let mut s = self.state.lock().unwrap();
        s.adopted = true;
        s.wanted = false;
    }

    pub fn snapshot(&self) -> (Mode, RunState) {
        let s = self.state.lock().unwrap();
        let run = if s.adopted {
            RunState::Adopted
        } else if s.child.is_some() {
            RunState::Running
        } else {
            RunState::Stopped
        };
        (s.cfg.mode, run)
    }

    pub fn config(&self) -> TrayConfig {
        self.state.lock().unwrap().cfg.clone()
    }
}

/// Arrêt de l'enfant et de sa descendance.
#[cfg(windows)]
fn kill_child(child: &mut Child) {
    // Le Job Object tue le reste du groupe à la mort du tray.
    let _ = child.kill();
    let _ = child.wait();
}

/// Unix : l'enfant est leader de son groupe de processus (`process_group(0)`
/// au spawn) — `killpg` tue node et ses enfants d'un coup. SIGTERM d'abord
/// (arrêt gracieux), SIGKILL après 3 s si ça pend.
#[cfg(unix)]
fn kill_child(child: &mut Child) {
    let pgid = child.id() as libc::pid_t;
    unsafe { libc::killpg(pgid, libc::SIGTERM) };
    for _ in 0..30 {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
    unsafe { libc::killpg(pgid, libc::SIGKILL) };
    let _ = child.wait();
}

/// Rotation simple à l'ouverture : > 5 Mo → `.1` (l'ancien `.1` est écrasé).
fn rotate_log(path: &Path) {
    if let Ok(meta) = fs::metadata(path) {
        if meta.len() > ROTATE_BYTES {
            let old = path.with_extension("log.1");
            let _ = fs::remove_file(&old);
            let _ = fs::rename(path, &old);
        }
    }
}

fn spawn_child(cfg: &TrayConfig, paths: &Paths) -> std::io::Result<Child> {
    fs::create_dir_all(&paths.logs)?;
    let mut cmd = Command::new(&cfg.node);
    // Ce que le tray capture dépend du mode : le daemon journalise lui-même
    // (--log, heure locale datée, rotation par log.js — parité avec les
    // backends service) ; le tray ne garde que son stderr (crashs) dans
    // daemon.err.log. Le relais n'a pas de --log : capture complète dans
    // relay.log, un seul écrivain, rotation par le tray.
    let capture: PathBuf = match cfg.mode {
        Mode::Poste => {
            // --wait-tunnel : mode de la tâche planifiée (tunnel pas encore monté).
            cmd.arg(paths.root.join("zra-daemon").join("index.js"))
                .arg("--wait-tunnel")
                .arg("--log").arg(paths.log_file(Mode::Poste));
            paths.err_log_file()
        }
        Mode::Relais => {
            cmd.arg(paths.root.join("zra-relay").join("index.js"))
                .env("ZRA_RELAY_PORT", cfg.relay.port.to_string())
                .env("ZRA_RELAY_HOST", &cfg.relay.host);
            if let (Some(cert), Some(key)) = (&cfg.relay.tls_cert, &cfg.relay.tls_key) {
                // Chemins relatifs (.zra/tls/…) résolus contre la racine config
                // (installé : dossier config utilisateur) ; le relais reçoit de l'absolu.
                let base = crate::config::config_root(&paths.root);
                let abs = |p: &str| {
                    let pp = std::path::Path::new(p);
                    if pp.is_absolute() { pp.to_path_buf() } else { base.join(pp) }
                };
                cmd.env("ZRA_RELAY_TLS_CERT", abs(cert)).env("ZRA_RELAY_TLS_KEY", abs(key));
            }
            paths.log_file(Mode::Relais)
        }
    };
    rotate_log(&capture);
    let file = Arc::new(Mutex::new(
        OpenOptions::new().create(true).append(true).open(&capture)?,
    ));

    cmd.current_dir(&paths.root)
        .stdin(Stdio::null())
        // stdout du daemon : déjà doublé dans daemon.log par log.js, le
        // recopier mélangeait deux formats (console UTC vs fichier local).
        .stdout(if cfg.mode == Mode::Poste { Stdio::null() } else { Stdio::piped() })
        .stderr(Stdio::piped());
    // CREATE_NO_WINDOW : pas de console pour node, même lancé depuis un shell.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Groupe de processus dédié : kill_child tue node et ses enfants.
        cmd.process_group(0);
        // PDEATHSIG : si le tray meurt sauvagement (SIGKILL, crash), node
        // reçoit SIGKILL — le pendant unix du Job Object, pas d'orphelin qui
        // tient le port. Le signal part à la mort du THREAD spawnant (le
        // thread de surveillance, vivant tant que le tray tourne).
        unsafe {
            cmd.pre_exec(|| {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    let mut child = cmd.spawn()?;
    if let Some(out) = child.stdout.take() {
        pipe_to_file(out, file.clone());
    }
    if let Some(err) = child.stderr.take() {
        pipe_to_file(err, file);
    }
    Ok(child)
}

/// stdout/stderr de l'enfant → journal, jusqu'à EOF (mort du processus).
fn pipe_to_file(mut pipe: impl Read + Send + 'static, file: Arc<Mutex<File>>) {
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match pipe.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let mut f = file.lock().unwrap();
                    let _ = f.write_all(&buf[..n]);
                    let _ = f.flush();
                }
            }
        }
    });
}

/// Job Object `KILL_ON_JOB_CLOSE` : le handle vit dans le tray ; à sa mort
/// (quitter, crash, taskkill /F), Windows tue les processus du job — pas de
/// node orphelin qui tient le port.
#[cfg(windows)]
mod job {
    use std::process::Child;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct Job(HANDLE);
    // Le handle est utilisé depuis le thread de surveillance.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn new() -> Option<Self> {
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    return None;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    CloseHandle(handle);
                    return None;
                }
                Some(Self(handle))
            }
        }

        pub fn assign(&self, child: &Child) {
            use std::os::windows::io::AsRawHandle;
            unsafe {
                AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}