// Onboarding au premier lancement : mini-page servie sur loopback, ouverte
// dans le navigateur — pas de webview (conception : « l'UI c'est le web »).
// Serveur éphémère : coupé dès la config écrite. Design : tokens One Dark de
// la PWA (reference/zed-ui/), latitude propre à ZRA.

use std::sync::mpsc;

use serde::Deserialize;
use tiny_http::{Header, Method, Response, Server};

use crate::config::{Mode, Paths, RelayConfig, TrayConfig};
use crate::i18n;
use crate::install;
use crate::i18n::tr;
use crate::node;
use crate::orchestrate;
use crate::update;

const PAGE: &str = include_str!("onboarding.html");
// Le logo suit les régénérations de scripts/gen-icons.mjs (SVG complet, signal
// compris) — pas de copie figée dans la page. Son style embarqué
// (prefers-color-scheme) adapte le mark au thème de la page, comme le favicon.
const LOGO: &str = include_str!("../../zra-client/icons/icon.svg");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DonePayload {
    mode: Mode,
    node: String,
    port: u16,
    relay: RelayConfig,
    #[serde(default)]
    agents: Vec<String>,
    #[serde(default)]
    autostart: bool,
    #[serde(default)]
    xwayland: bool,
    #[serde(default)]
    tls_cert: Option<String>,
    #[serde(default)]
    tls_key: Option<String>,
    /// Self-install (5.7) : coché par défaut dans la page, layout app only.
    #[serde(default)]
    install: bool,
}

fn json_response(body: String) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_string(body).with_header(
        Header::from_bytes(&b"Content-Type"[..], &b"application/json; charset=utf-8"[..]).unwrap(),
    )
}

fn html_response(body: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_string(body.to_string()).with_header(
        Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).unwrap(),
    )
}

/// Bloquant : rend la main quand l'utilisateur a fini (config écrite).
pub fn run(paths: &Paths) -> TrayConfig {
    let detected = node::detect();
    let server = Server::http("127.0.0.1:0").expect("serveur d'onboarding");
    let port = server.server_addr().to_ip().expect("adresse loopback").port();
    let url = format!("http://127.0.0.1:{port}/");
    eprintln!("{}", tr!("[zra-tray] onboarding : {0}", url));
    if let Err(err) = open::that(&url) {
        eprintln!("{}", tr!("[zra-tray] ouverture du navigateur impossible ({0}) — ouvrir l'URL manuellement.", err));
    }

    let (tx, rx) = mpsc::channel::<TrayConfig>();
    for mut request in server.incoming_requests() {
        let path = request.url().split('?').next().unwrap_or("").to_string();
        let method = request.method().clone();
        let mut body = String::new();
        let _ = request.as_reader().read_to_string(&mut body);

        let response: Response<std::io::Cursor<Vec<u8>>> = match (method, path.as_str()) {
            (Method::Get, "/") => html_response(&PAGE.replace("<!--logo-->", LOGO).replacen("<!--i18n-->", &i18n::script(), 1)),
            (Method::Get, "/favicon.svg") => Response::from_string(LOGO.to_string()).with_header(
                Header::from_bytes(&b"Content-Type"[..], &b"image/svg+xml"[..]).unwrap(),
            ),
            (Method::Get, "/info") => {
                let info = match &detected {
                    Some((path, version)) => serde_json::json!({ "node": { "path": path, "version": version } }),
                    None => serde_json::json!({ "node": null }),
                };
                let mut info = info;
                info["appLayout"] = serde_json::json!(update::is_app_layout(paths));
                info["installTarget"] = serde_json::json!(install::target().map(|p| p.to_string_lossy().to_string()));
                json_response(info.to_string())
            }
            (Method::Post, "/check") => {
                #[derive(Deserialize)]
                struct P { path: String }
                let result = serde_json::from_str::<P>(&body)
                    .map(|p| node::check(&p.path))
                    .unwrap_or_else(|_| Err(tr!("Requête invalide.")));
                json_response(match result {
                    Ok(version) => serde_json::json!({ "ok": true, "version": version }),
                    Err(error) => serde_json::json!({ "ok": false, "error": error }),
                }.to_string())
            }
            (Method::Post, "/discover") => {
                #[derive(Deserialize)]
                struct P { node: String }
                let result = (|| -> Result<serde_json::Value, String> {
                    let p: P = serde_json::from_str(&body).map_err(|e| tr!("Requête invalide : {0}", e))?;
                    node::check(&p.node)?;
                    Ok(orchestrate::discover(paths, &p.node))
                })();
                json_response(match result {
                    Ok(v) => serde_json::json!({ "ok": true, "discover": v }),
                    Err(error) => serde_json::json!({ "ok": false, "error": error }),
                }.to_string())
            }
            (Method::Post, "/listen-test") => {
                #[derive(Deserialize)]
                struct P { port: u16, host: String, node: String }
                let result = (|| -> Result<serde_json::Value, String> {
                    let p: P = serde_json::from_str(&body).map_err(|e| tr!("Requête invalide : {0}", e))?;
                    node::check(&p.node)?;
                    let args = vec!["--port".to_string(), p.port.to_string(), "--host".to_string(), p.host];
                    let step = orchestrate::run_script(paths, &p.node, "listen-test", "lib/listen-test.mjs", &args);
                    if !step.ok { return Err(step.output); }
                    serde_json::from_str(&step.output).map_err(|e| tr!("Réponse invalide : {0}", e))
                })();
                json_response(match result {
                    Ok(v) => serde_json::json!({ "ok": true, "result": v }),
                    Err(error) => serde_json::json!({ "ok": false, "error": error }),
                }.to_string())
            }
            (Method::Post, "/tls") => {
                // Upload du contenu (le navigateur ne donne pas le chemin
                // absolu) : copie dans .zra/tls/ (dossier config), chemin relatif
                // renvoyé — résolu contre configRoot, pas de recalibrage à l'install.
                #[derive(Deserialize)]
                struct P { kind: String, name: String, content: String }
                let result = (|| -> Result<String, String> {
                    let p: P = serde_json::from_str(&body).map_err(|e| tr!("Requête invalide : {0}", e))?;
                    if p.kind != "cert" && p.kind != "key" {
                        return Err(tr!("Type de fichier invalide."));
                    }
                    // Nom seul : pas de traversal ni de chemin imposé.
                    let name = std::path::Path::new(&p.name)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .filter(|n| !n.is_empty())
                        .ok_or(tr!("Nom de fichier invalide."))?;
                    let dir = paths.config_zra.join("tls");
                    std::fs::create_dir_all(&dir).map_err(|e| tr!("Création de .zra/tls/ impossible : {0}", e))?;
                    let file = dir.join(&name);
                    std::fs::write(&file, &p.content).map_err(|e| tr!("Écriture impossible : {0}", e))?;
                    Ok(format!(".zra/tls/{name}"))
                })();
                json_response(match result {
                    Ok(path) => serde_json::json!({ "ok": true, "path": path }),
                    Err(error) => serde_json::json!({ "ok": false, "error": error }),
                }.to_string())
            }
            (Method::Post, "/done") => {
                let payload: DonePayload = match serde_json::from_str(&body) {
                    Ok(p) => p,
                    Err(e) => {
                        let _ = request.respond(json_response(
                            serde_json::json!({ "ok": false, "error": tr!("Config invalide : {0}", e) }).to_string(),
                        ));
                        continue;
                    }
                };
                if let Err(error) = node::check(&payload.node) {
                    let _ = request.respond(json_response(
                        serde_json::json!({ "ok": false, "error": error }).to_string(),
                    ));
                    continue;
                }
                let cfg = TrayConfig {
                    mode: payload.mode,
                    node: payload.node,
                    port: payload.port,
                    relay: payload.relay,
                };
                if let Err(e) = paths.save_config(&cfg) {
                    let _ = request.respond(json_response(
                        serde_json::json!({ "ok": false, "error": tr!("Écriture impossible : {0}", e) }).to_string(),
                    ));
                    continue;
                }
                // Self-install (5.7) : copier exe + app/ vers l'emplacement
                // fixe, puis orchestrer DEPUIS LA CIBLE (chemins absolus).
                // `.zra/` et zra.config.json voyagent dans app/ : rien à
                // réécrire côté données. Portable choisi : mémorisé.
                let want_install = payload.install
                    && update::is_app_layout(paths)
                    && !install::is_installed();
                let (work_paths, install_target) = if want_install {
                    match install::copy_to_target(paths) {
                        Ok(t) => (Paths::from_root(t.join("app")), Some(t)),
                        Err(e) => {
                            let _ = request.respond(json_response(
                                serde_json::json!({ "ok": false, "error": tr!("Installation impossible : {0}", e) }).to_string(),
                            ));
                            continue;
                        }
                    }
                } else {
                    if !payload.install {
                        install::remember_portable(paths);
                    }
                    (Paths::from_root(paths.root.clone()), None)
                };
                // Orchestration (poste) : câblage Zed, autostart, XWayland — les
                // scripts Node en non interactif, la page a collecté les choix.
                let mut steps: Vec<orchestrate::Step> = Vec::new();
                if cfg.mode == Mode::Poste {
                    if !payload.agents.is_empty() {
                        let mut args = vec!["install".to_string(), "--apply".to_string(), "yes".to_string()];
                        for a in &payload.agents {
                            args.push("--agent".to_string());
                            args.push(a.clone());
                        }
                        steps.push(orchestrate::run_script(&work_paths, &cfg.node, &tr!("Agents Zed"), "setup.mjs", &args));
                    }
                    if payload.autostart {
                        steps.push(orchestrate::run_script(&work_paths, &cfg.node, &tr!("Démarrage automatique"), "service.mjs",
                            &["install".to_string(), "--apply".to_string()]));
                    }
                    if payload.xwayland {
                        steps.push(orchestrate::run_script(&work_paths, &cfg.node, &tr!("Zed sous XWayland"), "setup.mjs",
                            &["xwayland".to_string(), "--apply".to_string()]));
                    }
                    // TLS du daemon : écrit dans zra.config.json (HTTPS) ou retiré
                    // (HTTP). Idempotent — succès sans changement = rien à faire.
                    let tls_args = match (&payload.tls_cert, &payload.tls_key) {
                        (Some(cert), Some(key)) => vec!["tls".to_string(), "--cert".to_string(), cert.clone(), "--key".to_string(), key.clone(), "--apply".to_string()],
                        _ => vec!["tls".to_string(), "--apply".to_string()],
                    };
                    steps.push(orchestrate::run_script(&work_paths, &cfg.node, &tr!("TLS du daemon"), "setup.mjs", &tls_args));
                }
                if let Some(t) = &install_target {
                    steps.extend(install::shortcuts(t, crate::console::app_version(&work_paths)));
                }
                let body = serde_json::json!({
                    "ok": true,
                    "steps": orchestrate::steps_json(&steps),
                    "installed": install_target.as_ref().map(|t| t.to_string_lossy().to_string()),
                });
                let _ = request.respond(json_response(body.to_string()));
                if let Some(t) = install_target {
                    // Lancer la copie installée, l'originale se ferme — pas
                    // deux vies parallèles. Le supervisor portable n'est jamais
                    // créé (onboarding::run ne rend pas la main).
                    let exe = t.join(if cfg!(windows) { "zra-tray.exe" } else { "zra-tray" });
                    if let Err(e) = install::launch(&exe, &t) {
                        eprintln!("{}", tr!("[zra-tray] {0} — ouvrir ZRA depuis {1} manuellement.", e, t.display()));
                    }
                    std::process::exit(0);
                }
                let _ = tx.send(cfg);
                break;
            }
            _ => html_response(&tr!("Introuvable.")),
        };
        let _ = request.respond(response);
    }
    rx.recv().expect("config d'onboarding")
}
#[cfg(test)]
mod tests {
    #[test]
    fn page_un_seul_placeholder_i18n() {
        // L'injection (replacen 1) ne doit pas tomber sur un commentaire : un
        // </script> injecté dans le bloc script le fermerait prématurément.
        assert_eq!(super::PAGE.matches("<!--i18n-->").count(), 1);
    }
}
