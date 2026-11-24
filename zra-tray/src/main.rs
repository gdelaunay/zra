// zra-tray — tray natif et superviseur de ZRA (conception :
// reference/conception-zra-tray.md). Deux modes : poste (daemon) et relais
// (zra-relay), bascule depuis le menu. Onboarding au premier lancement via
// une page locale dans le navigateur. `--headless` : supervision sans icône
// (homelab sans session graphique).
//
// Dev : cargo run (console). Release : sous-système Windows GUI, pas de
// fenêtre — les messages de debug partent dans le vide, le journal du service
// est dans .zra/logs/.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod console;
mod i18n;
mod install;
mod node;
mod onboarding;
mod orchestrate;
mod relay_unit;
mod status;
mod supervisor;
mod uninstall;
mod update;

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use config::{Mode, Paths};
use crate::i18n::tr;
use supervisor::{RunState, Supervisor};
// X11/Wayland : le presse-papiers est servi par le processus propriétaire ;
// `.wait()` garde le contenu vivant après l'écriture (voir copy_to_clipboard).
#[cfg(target_os = "linux")]
use arboard::SetExtLinux;
use tao::event::Event;
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, TrayIconBuilder};

enum UserEvent {
    Status { text: String, url: Option<String>, up: bool, adopted: bool },
    Quit,
}

/// Verrou partagé des tests qui touchent aux variables d'environnement
/// (HOME, LOCALAPPDATA, XDG…) : cargo test tourne en parallèle.
#[cfg(test)]
pub(crate) mod testutil {
    use std::sync::{Mutex, MutexGuard};
    static ENV_LOCK: Mutex<()> = Mutex::new(());
    pub fn env_guard() -> MutexGuard<'static, ()> {
        ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }
}

const ID_OPEN: &str = "open";
const ID_CONSOLE: &str = "console";
const ID_URL: &str = "url";
const ID_PAIR: &str = "pair";
const ID_LOGS: &str = "logs";
const ID_RESTART: &str = "restart";
const ID_MODE: &str = "mode";
const ID_QUIT: &str = "quit";

fn main() {
    // Headless : le flag, ou pas de session graphique du tout (ni DISPLAY ni
    // WAYLAND_DISPLAY) — le homelab n'a pas de desktop, pas besoin d'y penser.
    let no_display = std::env::var("DISPLAY").unwrap_or_default().is_empty()
        && std::env::var("WAYLAND_DISPLAY").unwrap_or_default().is_empty();
    let headless = std::env::args().skip(1).any(|a| a == "--headless") || (cfg!(unix) && no_display);
    if std::env::args().skip(1).any(|a| a == "--help" || a == "-h") {
        println!("{}", tr!("zra-tray — tray et superviseur ZRA (modes poste et relais)\n\n  --headless   supervision sans icône (automatique si pas de session graphique)\n\nConfig : .zra/tray.json (onboarding au premier lancement)."));
        return;
    }

    let paths = Arc::new(Paths::discover().unwrap_or_else(|| {
        eprintln!("{}", tr!("Racine ZRA introuvable depuis l'exécutable (zra-daemon/index.js attendu en remontant). ZRA_ROOT peut la forcer."));
        std::process::exit(1);
    }));
    let _ = std::fs::create_dir_all(&paths.zra);

    // Cas limite 5.7 : une copie portable relancée alors qu'une instance
    // installée existe → lancer l'installée, pas deux vies parallèles.
    // Layout app seulement : le dev en layout dépôt n'est pas détourné.
    if update::is_app_layout(&paths) && !install::is_installed() && install::installed_exists() {
        if let Some(t) = install::target() {
            eprintln!("{}", tr!("[zra-tray] instance installée détectée ({0}) — lancement de celle-ci.", t.display()));
            let exe = t.join(if cfg!(windows) { "zra-tray.exe" } else { "zra-tray" });
            if install::launch(&exe, &t).is_ok() {
                return;
            }
        }
    }

    // Single-instance : verrou fichier tenu jusqu'à la mort du processus
    // (l'OS le libère même après un crash).
    let lock_file = std::fs::File::create(paths.lock_file()).expect("verrou .zra/tray.lock");
    let mut lock = fd_lock::RwLock::new(lock_file);
    let _guard = match lock.try_write() {
        Ok(guard) => guard,
        Err(_) => return, // un autre zra-tray tourne déjà
    };

    let cfg = match paths.load_config() {
        Some(cfg) => cfg,
        None if headless => {
            eprintln!("{}", tr!("Pas de .zra/tray.json : lancer zra-tray avec une session graphique pour l'onboarding, ou copier une config existante."));
            std::process::exit(1);
        }
        None => onboarding::run(&paths),
    };

    let sup = Arc::new(Supervisor::new(cfg.clone(), paths.clone()));
    sup.spawn_monitor();

    // Console de gestion (mode « installé ») : page locale persistante,
    // ouverte depuis le menu — l'UI du tray.
    let console = console::start(sup.clone(), paths.clone());

    // Updates automatiques (5.4) : vérification au démarrage (+30 s, laisser
    // le service monter) puis chaque jour ; téléchargement si activé. Le
    // pending s'applique au prochain arrêt/redémarrage (quit_with_update).
    {
        let paths = paths.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_secs(30));
            loop {
                if update::UpdateState::load(&paths).auto_update {
                    update::check_and_fetch(&paths, console::app_version(&paths));
                }
                thread::sleep(Duration::from_secs(24 * 3600));
            }
        });
    }

    // Adopter un service déjà vivant plutôt que spawner un second. En mode
    // relais, un /status qui répond trahit un daemon sur le port : ce n'est
    // pas un relais, on n'adopte pas (et on ne spawn pas dans le vide).
    let port = match cfg.mode {
        Mode::Poste => cfg.port,
        Mode::Relais => cfg.relay.port,
    };
    let tcp_up = match cfg.mode {
        Mode::Poste => status::daemon_status(cfg.port).is_some(),
        Mode::Relais => status::relay_up(cfg.relay.port),
    };
    let daemon_on_port = status::daemon_status(port).is_some();
    let already_up = tcp_up && (cfg.mode == Mode::Poste || !daemon_on_port);
    if tcp_up && cfg.mode == Mode::Relais && daemon_on_port {
        eprintln!("{}", tr!("[zra-tray] le port {0} est tenu par un daemon : relais non lancé.", cfg.relay.port));
    } else if already_up {
        eprintln!("{}", tr!("[zra-tray] un service répond déjà sur le port — mode observateur."));
        sup.adopt();
    } else {
        sup.start();
    }

    if headless {
        eprintln!("{}", tr!("[zra-tray] console de gestion : {0}", console.url));
        let sup2 = sup.clone();
        let paths2 = paths.clone();
        ctrlc::set_handler(move || {
            quit_with_update(&sup2, &paths2);
        })
        .expect("handler Ctrl-C");
        loop {
            thread::sleep(Duration::from_secs(1));
        }
    }

    run_gui(sup, paths, cfg, console);
}

fn run_gui(sup: Arc<Supervisor>, paths: Arc<Paths>, cfg: config::TrayConfig, console: console::Console) {
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    // Icônes tray : mark couleur sur transparent, deux variantes embarquées.
    // Windows : swap selon le thème de la barre des tâches ; Linux : sombre fixe.
    let icon_dark = load_icon(include_bytes!("../../zra-client/icons/tray.png"));
    let icon_light = load_icon(include_bytes!("../../zra-client/icons/tray-light.png"));
    let mut light = taskbar_light();
    let icon = if light { icon_light.clone() } else { icon_dark.clone() };

    let menu = Menu::new();
    let status_item = MenuItem::with_id("status", tr!("ZRA — démarrage…"), false, None);
    let open_item = MenuItem::with_id(ID_OPEN, tr!("Ouvrir ZRA"), true, None);
    let console_item = MenuItem::with_id(ID_CONSOLE, tr!("Console de gestion"), true, None);
    let url_item = MenuItem::with_id(ID_URL, tr!("Copier l'URL"), true, None);
    let pair_item = MenuItem::with_id(ID_PAIR, tr!("Copier le code d'appairage"), false, None);
    let logs_item = MenuItem::with_id(ID_LOGS, tr!("Ouvrir le journal"), true, None);
    let restart_item = MenuItem::with_id(ID_RESTART, tr!("Redémarrer"), true, None);
    let mode_item = MenuItem::with_id(ID_MODE, mode_switch_label(cfg.mode), true, None);
    let quit_item = MenuItem::with_id(ID_QUIT, tr!("Quitter"), true, None);
    let sep = || PredefinedMenuItem::separator();
    for item in [
        &status_item as &dyn tray_icon::menu::IsMenuItem,
        &sep(),
        &open_item,
        &console_item,
        &url_item,
        &pair_item,
        &logs_item,
        &sep(),
        &restart_item,
        &mode_item,
        &sep(),
        &quit_item,
    ] {
        menu.append(item).expect("menu");
    }

    let tray = TrayIconBuilder::new()
        .with_icon(icon)
        .with_tooltip("ZRA")
        .with_menu(Box::new(menu))
        .build()
        .expect("tray");

    // Dernière URL connue (http ou https selon le daemon), pour « Ouvrir ZRA ».
    let last_url: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

    // Thread d'état : interroge le service toutes les 5 s, met le menu à jour
    // via la boucle d'événements.
    {
        let sup = sup.clone();
        let proxy = proxy.clone();
        let last_url = last_url.clone();
        thread::spawn(move || loop {
            let (mode, run) = sup.snapshot();
            let cfg = sup.config();
            let adopted = run == RunState::Adopted;
            let ext = if adopted { tr!(" (externe)") } else { String::new() };
            let (text, url, up) = match mode {
                Mode::Poste => match status::daemon_status(cfg.port) {
                    Some((scheme, body)) => {
                        let live = body["threads"]["live"].as_u64().unwrap_or(0);
                        let clients = body["clients"].as_u64().unwrap_or(0);
                        let url = format!("{scheme}://127.0.0.1:{}", cfg.port);
                        (tr!("Poste : ✓ {0} — {1} live, {2} client(s){3}", url, live, clients, ext), Some(url), true)
                    }
                    None => match run {
                        RunState::Running => (tr!("Poste : … démarrage"), None, false),
                        _ => (tr!("Poste : ✗ arrêté"), None, false),
                    },
                },
                Mode::Relais => {
                    let up = status::relay_up(cfg.relay.port);
                    let scheme = if cfg.relay.tls_cert.is_some() { "https" } else { "http" };
                    let url = format!("{scheme}://127.0.0.1:{}", cfg.relay.port);
                    let text = if up {
                        tr!("Relais : ✓ {0}{1}", url, ext)
                    } else if run == RunState::Running {
                        tr!("Relais : … démarrage")
                    } else {
                        tr!("Relais : ✗ arrêté")
                    };
                    (text, up.then_some(url), up)
                }
            };
            *last_url.lock().unwrap() = url.clone();
            let _ = proxy.send_event(UserEvent::Status { text, url, up, adopted });
            thread::sleep(Duration::from_secs(5));
        });
    }

    {
        let proxy = proxy.clone();
        let sup = sup.clone();
        ctrlc::set_handler(move || {
            sup.stop();
            let _ = proxy.send_event(UserEvent::Quit);
        })
        .expect("handler Ctrl-C");
    }

    let menu_rx = MenuEvent::receiver();
    event_loop.run(move |event, _, control_flow| {
        // Réveil régulier : les événements de menu tray-icon arrivent par un
        // canal, pas par la boucle d'événements.
        *control_flow = ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(250));
        match event {
            Event::UserEvent(UserEvent::Status { text, url, up, adopted }) => {
                // Thème de la barre des tâches : swap de variante si changement.
                let now_light = taskbar_light();
                if now_light != light {
                    light = now_light;
                    let _ = tray.set_icon(Some(if light { icon_light.clone() } else { icon_dark.clone() }));
                }
                status_item.set_text(&text);
                let _ = tray.set_tooltip(Some(&text));
                let (mode, _) = sup.snapshot();
                pair_item.set_enabled(mode == Mode::Poste && up);
                restart_item.set_enabled(!adopted);
                mode_item.set_enabled(!adopted);
                mode_item.set_text(mode_switch_label(mode));
                let _ = url;
            }
            Event::UserEvent(UserEvent::Quit) => {
                quit_with_update(&sup, &paths);
            }
            Event::MainEventsCleared => {
                while let Ok(ev) = menu_rx.try_recv() {
                    match ev.id().0.as_str() {
                        ID_OPEN => {
                            let url = current_url(&sup, &last_url);
                            // xdg-open rend 0 même quand le navigateur est
                            // cassé : l'échec détectable est journalisé, et
                            // « Copier l'URL » sert de repli manuel.
                            if let Err(err) = open::that(&url) {
                                eprintln!("{}", tr!("[zra-tray] ouverture du navigateur impossible ({0}) — URL : {1}", err, url));
                            }
                        }
                        ID_CONSOLE => {
                            if let Err(err) = open::that(&console.url) {
                                eprintln!("{}", tr!("[zra-tray] ouverture du navigateur impossible ({0}) — console : {1}", err, console.url));
                            }
                        }
                        ID_URL => {
                            let url = current_url(&sup, &last_url);
                            thread::spawn(move || copy_to_clipboard(url));
                        }
                        ID_PAIR => {
                            let port = sup.config().port;
                            thread::spawn(move || {
                                if let Some(code) = status::pair_code(port) {
                                    copy_to_clipboard(code);
                                }
                            });
                        }
                        ID_LOGS => {
                            let (mode, _) = sup.snapshot();
                            let _ = open::that(paths.log_file(mode));
                        }
                        ID_RESTART => sup.restart(),
                        ID_MODE => {
                            let (mode, _) = sup.snapshot();
                            let next = match mode {
                                Mode::Poste => Mode::Relais,
                                Mode::Relais => Mode::Poste,
                            };
                            sup.switch_mode(next);
                            mode_item.set_text(mode_switch_label(next));
                        }
                        ID_QUIT => {
                            quit_with_update(&sup, &paths);
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    });
}

/// Arrêt du tray : service stoppé, puis update pending appliquée s'il y en
/// a une (5.4 — « application au restart »). apply_and_relaunch ne rend pas
/// la main en cas de succès (exit Windows + script de relance, exec unix).
/// Sans pending : exit propre, les enfants meurent avec le tray.
pub(crate) fn quit_with_update(sup: &Supervisor, paths: &Paths) {
    sup.stop();
    let st = update::UpdateState::load(paths);
    if let Some(version) = st.pending.as_deref() {
        if let Some(inner) = update::pending_inner(paths, version) {
            eprintln!("{}", tr!("[zra-tray] update {0} : application au redémarrage.", version));
            if let Err(err) = update::apply_and_relaunch(paths, &inner) {
                eprintln!("{}", tr!("[zra-tray] update impossible ({0}) — arrêt sans update.", err));
            }
        }
    }
    std::process::exit(0);
}

fn mode_switch_label(current: Mode) -> String {
    match current {
        Mode::Poste => tr!("Passer en mode relais"),
        Mode::Relais => tr!("Passer en mode poste"),
    }
}

fn load_icon(bytes: &[u8]) -> Icon {
    let img = image::load_from_memory(bytes).expect("icône tray").to_rgba8();
    let (w, h) = img.dimensions();
    Icon::from_rgba(img.into_raw(), w, h).expect("icône tray")
}

/// Thème de la barre des tâches Windows : Personalize\SystemUsesLightTheme
/// (thème système, pas apps). Absent/clé manquante → sombre. Hors Windows :
/// pas de thème panel fiable (SNI/AppIndicator) → variante sombre fixe.
#[cfg(windows)]
fn taskbar_light() -> bool {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
    let subkey: Vec<u16> = "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize\0"
        .encode_utf16().collect();
    let value: Vec<u16> = "SystemUsesLightTheme\0".encode_utf16().collect();
    let mut data = 0u32;
    let mut len = std::mem::size_of::<u32>() as u32;
    let status = unsafe {
        RegGetValueW(HKEY_CURRENT_USER, subkey.as_ptr(), value.as_ptr(), RRF_RT_REG_DWORD,
            std::ptr::null_mut(), &mut data as *mut u32 as *mut _, &mut len)
    };
    status == 0 && data == 1
}

#[cfg(not(windows))]
fn taskbar_light() -> bool {
    false
}

/// Dernière URL connue, ou l'origine par défaut du service (pas encore up).
fn current_url(sup: &Supervisor, last_url: &Mutex<Option<String>>) -> String {
    last_url.lock().unwrap().clone().unwrap_or_else(|| {
        let cfg = sup.config();
        match cfg.mode {
            Mode::Poste => format!("http://127.0.0.1:{}", cfg.port),
            Mode::Relais => format!("http://127.0.0.1:{}", cfg.relay.port),
        }
    })
}

/// Presse-papiers : sous Linux le handle doit vivre — le contenu est servi
/// par le processus (X11/Wayland) ; sans gestionnaire de presse-papiers
/// (session xrdp sans klipper…), le drop le perd. `.wait()` bloque le thread
/// appelant jusqu'à ce qu'un autre contenu remplace le texte — à appeler
/// depuis un thread dédié, jamais depuis la boucle d'événements.
fn copy_to_clipboard(text: String) {
    if let Ok(mut clip) = arboard::Clipboard::new() {
        #[cfg(target_os = "linux")]
        let _ = clip.set().wait().text(text);
        #[cfg(not(target_os = "linux"))]
        let _ = clip.set_text(text);
    }
}