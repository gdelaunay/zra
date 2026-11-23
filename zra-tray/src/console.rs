// Console de gestion (mode « installé ») : page locale servie sur loopback,
// ouverte depuis le menu du tray — l'UI du tray, pas de fenêtre native
// (conception : reference/conception-zra-tray.md, Distribution).
//
// Serveur persistant (l'onboarding, lui, est éphémère) : il vit tant que le
// tray tourne, sur un port loopback choisi par l'OS. Les actions sensibles
// (redémarrer, quitter, désinstaller) restent sur loopback, même niveau de
// confiance que /pair du daemon : être sur le poste suffit.

use std::sync::Arc;
use std::thread;

use serde_json::{json, Value};
use tiny_http::{Header, Method, Response, Server};

use crate::config::{Mode, Paths};
use crate::i18n;
use crate::install;
use crate::i18n::tr;
use crate::orchestrate;
use crate::relay_unit;
use crate::status;
use crate::supervisor::{RunState, Supervisor};
use crate::uninstall;
use crate::update;

const PAGE: &str = include_str!("console.html");
const LOGO: &str = include_str!("../../zra-client/icons/icon.svg");

pub struct Console {
    pub url: String,
}

fn json_response(body: String) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_string(body).with_header(
        Header::from_bytes(&b"Content-Type"[..], &b"application/json; charset=utf-8"[..]).unwrap(),
    )
}

fn ok_json(v: Value) -> Response<std::io::Cursor<Vec<u8>>> {
    json_response(v.to_string())
}

fn err_json(error: String) -> Response<std::io::Cursor<Vec<u8>>> {
    json_response(json!({ "ok": false, "error": error }).to_string())
}

/// Version de l'app : `package.json` à la racine (embarqué dans l'archive).
pub fn app_version(paths: &Paths) -> Option<String> {
    let text = std::fs::read_to_string(paths.root.join("package.json")).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    v.get("version")?.as_str().map(str::to_string)
}

/// Dernières lignes d'un journal (rotation comprise : le fichier courant).
pub fn tail_lines(path: &std::path::Path, lines: usize) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(path) else { return Vec::new() };
    let all: Vec<&str> = text.split('\n').filter(|l| !l.trim().is_empty()).collect();
    all.iter().skip(all.len().saturating_sub(lines)).map(|s| s.to_string()).collect()
}

fn run_label(run: RunState) -> &'static str {
    match run {
        RunState::Running => "running",
        RunState::Stopped => "stopped",
        RunState::Adopted => "adopted",
    }
}

/// État projeté pour la page : service, mode, versions, chemins.
fn state_json(sup: &Supervisor, paths: &Paths) -> Value {
    let (mode, run) = sup.snapshot();
    let cfg = sup.config();
    let mut out = json!({
        "mode": mode,
        "run": run_label(run),
        "adopted": run == RunState::Adopted,
        "version": app_version(paths),
        "trayVersion": env!("CARGO_PKG_VERSION"),
        "node": cfg.node,
        "port": cfg.port,
        "relay": cfg.relay,
        "root": paths.root.to_string_lossy(),
        "appLayout": crate::update::is_app_layout(paths),
        "installed": install::is_installed(),
        "installTarget": install::target().map(|p| p.to_string_lossy().to_string()),
        "logFile": paths.log_file(mode).to_string_lossy(),
    });
    match mode {
        Mode::Poste => {
            if let Some((scheme, body)) = status::daemon_status(cfg.port) {
                out["up"] = json!(true);
                out["url"] = json!(format!("{scheme}://127.0.0.1:{}", cfg.port));
                out["live"] = body["threads"]["live"].clone();
                out["clients"] = body["clients"].clone();
            } else {
                out["up"] = json!(false);
            }
        }
        Mode::Relais => {
            let up = status::relay_up(cfg.relay.port);
            let scheme = if cfg.relay.tls_cert.is_some() { "https" } else { "http" };
            out["up"] = json!(up);
            if up {
                out["url"] = json!(format!("{scheme}://127.0.0.1:{}", cfg.relay.port));
            }
        }
    }
    out
}

/// Démarre le serveur de console (thread dédié, port loopback libre).
pub fn start(sup: Arc<Supervisor>, paths: Arc<Paths>) -> Console {
    let server = Arc::new(Server::http("127.0.0.1:0").expect("serveur de console"));
    let port = server.server_addr().to_ip().expect("adresse loopback").port();
    let url = format!("http://127.0.0.1:{port}/");
    let srv = server.clone();
    thread::spawn(move || {
        for request in srv.incoming_requests() {
            let sup = sup.clone();
            let paths = paths.clone();
            // Une requête = un thread : /autostart spawn node (quelques
            // secondes), les autres requêtes ne doivent pas attendre.
            thread::spawn(move || handle(request, &sup, &paths));
        }
    });
    Console { url }
}

fn handle(mut request: tiny_http::Request, sup: &Supervisor, paths: &Paths) {
    let path = request.url().split('?').next().unwrap_or("").to_string();
    let query = request.url().split('?').nth(1).unwrap_or("").to_string();
    let method = request.method().clone();
    let mut body = String::new();
    let _ = request.as_reader().read_to_string(&mut body);

    let response: Response<std::io::Cursor<Vec<u8>>> = match (method, path.as_str()) {
        (Method::Get, "/") => Response::from_string(PAGE.replace("<!--logo-->", LOGO).replacen("<!--i18n-->", &i18n::script(), 1)).with_header(
            Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).unwrap(),
        ),
        (Method::Get, "/favicon.svg") => Response::from_string(LOGO.to_string()).with_header(
            Header::from_bytes(&b"Content-Type"[..], &b"image/svg+xml"[..]).unwrap(),
        ),
        (Method::Get, "/state") => ok_json(state_json(sup, paths)),
        (Method::Get, "/autostart") => {
            // Relais sous Linux/systemd : l'unité zra-relay.service, générée
            // par le binaire (5.6). Sinon : état réel via le script Node
            // (backend de la machine) — pas de devinette côté Rust.
            let cfg = sup.config();
            if cfg.mode == Mode::Relais && relay_unit::is_systemd_user() {
                ok_json(json!({ "ok": true, "autostart": relay_unit::state() }))
            } else {
                let d = orchestrate::discover(paths, &cfg.node);
                ok_json(json!({ "ok": true, "autostart": d.get("autostart").cloned().unwrap_or(Value::Null) }))
            }
        }
        (Method::Post, "/autostart") => {
            #[derive(serde::Deserialize)]
            struct P { enabled: bool }
            let result = (|| -> Result<Value, String> {
                let p: P = serde_json::from_str(&body).map_err(|e| tr!("Requête invalide : {0}", e))?;
                let cfg = sup.config();
                if cfg.mode == Mode::Relais && relay_unit::is_systemd_user() {
                    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
                    let out = if p.enabled {
                        relay_unit::install(&exe, &paths.root)?
                    } else {
                        relay_unit::uninstall()?
                    };
                    return Ok(json!({ "ok": true, "output": out }));
                }
                let verb = if p.enabled { "install" } else { "uninstall" };
                let step = orchestrate::run_script(paths, &cfg.node, &tr!("Démarrage automatique"), "service.mjs",
                    &[verb.to_string(), "--apply".to_string()]);
                Ok(json!({ "ok": step.ok, "output": step.output }))
            })();
            match result {
                Ok(v) => ok_json(v),
                Err(e) => err_json(e),
            }
        }
        (Method::Get, "/logs") => {
            let lines = query.split('&')
                .find_map(|kv| kv.strip_prefix("lines="))
                .and_then(|n| n.parse::<usize>().ok())
                .unwrap_or(200)
                .min(2000);
            let (mode, _) = sup.snapshot();
            ok_json(json!({ "ok": true, "lines": tail_lines(&paths.log_file(mode), lines) }))
        }
        (Method::Post, "/open-logs") => {
            let (mode, _) = sup.snapshot();
            let file = paths.log_file(mode);
            match open::that(&file) {
                Ok(()) => ok_json(json!({ "ok": true })),
                Err(e) => err_json(tr!("Ouverture impossible : {0}", e)),
            }
        }
        (Method::Post, "/restart") => {
            if sup.snapshot().1 == RunState::Adopted {
                err_json(tr!("Service externe : le tray ne le pilote pas."))
            } else {
                sup.restart();
                ok_json(json!({ "ok": true }))
            }
        }
        (Method::Post, "/mode") => {
            #[derive(serde::Deserialize)]
            struct P { mode: Mode }
            let result = (|| -> Result<Value, String> {
                let p: P = serde_json::from_str(&body).map_err(|e| tr!("Requête invalide : {0}", e))?;
                if sup.snapshot().1 == RunState::Adopted {
                    return Err(tr!("Service externe : bascule impossible depuis le tray."));
                }
                sup.switch_mode(p.mode);
                Ok(json!({ "ok": true }))
            })();
            match result {
                Ok(v) => ok_json(v),
                Err(e) => err_json(e),
            }
        }
        (Method::Get, "/update") => ok_json(update::state_json(paths, app_version(paths))),
        (Method::Post, "/update/check") => {
            // Long (réseau + téléchargement) : la requête a son thread.
            ok_json(update::check_and_fetch(paths, app_version(paths)))
        }
        (Method::Post, "/update/toggle") => {
            #[derive(serde::Deserialize)]
            struct P { enabled: bool }
            match serde_json::from_str::<P>(&body) {
                Ok(p) => {
                    let mut st = update::UpdateState::load(paths);
                    st.auto_update = p.enabled;
                    st.save(paths);
                    ok_json(json!({ "ok": true }))
                }
                Err(e) => err_json(tr!("Requête invalide : {0}", e)),
            }
        }
        (Method::Post, "/update/apply") => {
            let st = update::UpdateState::load(paths);
            let inner = st.pending.as_deref().and_then(|v| update::pending_inner(paths, v));
            match inner {
                Some(inner) => {
                    sup.stop();
                    let _ = request.respond(ok_json(json!({ "ok": true })));
                    if let Err(err) = update::apply_and_relaunch(paths, &inner) {
                        eprintln!("{}", tr!("[zra-tray] update impossible ({0}) — arrêt.", err));
                        std::process::exit(1);
                    }
                    return; // succès : le processus est remplacé (exit ou exec)
                }
                None => err_json(tr!("Aucune update prête à installer.")),
            }
        }
        (Method::Post, "/install") => {
            // Self-install (5.7) : layout app seulement, pas déjà installé.
            if !crate::update::is_app_layout(paths) {
                let _ = request.respond(err_json(tr!("Installation depuis le dépôt : pas de self-install (flux contributeur).")));
                return;
            }
            if install::is_installed() {
                let _ = request.respond(err_json(tr!("ZRA est déjà installé sur ce poste.")));
                return;
            }
            sup.stop();
            let cfg = sup.config();
            match install::copy_to_target(paths) {
                Ok(t) => {
                    let tp = Paths::from_root(t.join("app"));
                    let mut steps = install::rewire(&tp, &cfg.node);
                    steps.extend(install::shortcuts(&t, app_version(&tp)));
                    let _ = request.respond(ok_json(json!({
                        "ok": true,
                        "steps": orchestrate::steps_json(&steps),
                        "target": t.to_string_lossy(),
                    })));
                    let exe = t.join(if cfg!(windows) { "zra-tray.exe" } else { "zra-tray" });
                    if let Err(e) = install::launch(&exe, &t) {
                        eprintln!("[zra-tray] {e}");
                        std::process::exit(1);
                    }
                    std::process::exit(0);
                }
                Err(e) => err_json(e),
            }
        }
        (Method::Post, "/uninstall") => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct P { #[serde(default)] keep_settings: bool }
            let keep = serde_json::from_str::<P>(&body).map(|p| p.keep_settings).unwrap_or(false);
            sup.stop();
            let cfg = sup.config();
            let result = uninstall::run(paths, &cfg.node, keep);
            let ok = result.get("ok").and_then(Value::as_bool).unwrap_or(false);
            let _ = request.respond(ok_json(result));
            if ok {
                // Windows : le script détaché attend notre exit pour supprimer
                // le dossier (exe verrouillé). Unix : déjà supprimé.
                std::process::exit(0);
            }
            return;
        }
        (Method::Post, "/quit") => {
            let _ = request.respond(ok_json(json!({ "ok": true })));
            crate::quit_with_update(sup, paths);
            return;
        }
        _ => err_json(tr!("Introuvable.")),
    };
    let _ = request.respond(response);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_lines_garde_les_dernieres() {
        let dir = std::env::temp_dir().join(format!("zra-console-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("test.log");
        std::fs::write(&file, "un\ndeux\n\ntrois\nquatre\n").unwrap();
        assert_eq!(tail_lines(&file, 2), vec!["trois", "quatre"]);
        assert_eq!(tail_lines(&file, 10).len(), 4, "moins de lignes que demandé : tout");
        assert!(tail_lines(&dir.join("absent.log"), 10).is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn run_label_stable() {
        assert_eq!(run_label(RunState::Running), "running");
        assert_eq!(run_label(RunState::Stopped), "stopped");
        assert_eq!(run_label(RunState::Adopted), "adopted");
    }

    #[test]
    fn page_un_seul_placeholder_i18n() {
        // L'injection (replacen 1) ne doit pas tomber sur un commentaire : un
        // </script> injecté dans le bloc script le fermerait prématurément.
        assert_eq!(PAGE.matches("<!--i18n-->").count(), 1);
    }
}