// Onboarding au premier lancement : mini-page servie sur loopback, ouverte
// dans le navigateur — pas de webview (conception : « l'UI c'est le web »).
// Serveur éphémère : coupé dès la config écrite. Design : tokens One Dark de
// la PWA (reference/zed-ui/), latitude propre à ZRA.

use std::sync::mpsc;

use serde::Deserialize;
use tiny_http::{Header, Method, Response, Server};

use crate::config::{Mode, Paths, RelayConfig, TrayConfig};
use crate::node;

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
    eprintln!("[zra-tray] onboarding : {url}");
    let _ = open::that(&url);

    let (tx, rx) = mpsc::channel::<TrayConfig>();
    for mut request in server.incoming_requests() {
        let path = request.url().split('?').next().unwrap_or("").to_string();
        let method = request.method().clone();
        let mut body = String::new();
        let _ = request.as_reader().read_to_string(&mut body);

        let response: Response<std::io::Cursor<Vec<u8>>> = match (method, path.as_str()) {
            (Method::Get, "/") => html_response(&PAGE.replace("<!--logo-->", LOGO)),
            (Method::Get, "/favicon.svg") => Response::from_string(LOGO.to_string()).with_header(
                Header::from_bytes(&b"Content-Type"[..], &b"image/svg+xml"[..]).unwrap(),
            ),
            (Method::Get, "/info") => {
                let info = match &detected {
                    Some((path, version)) => serde_json::json!({ "node": { "path": path, "version": version } }),
                    None => serde_json::json!({ "node": null }),
                };
                json_response(info.to_string())
            }
            (Method::Post, "/check") => {
                #[derive(Deserialize)]
                struct P { path: String }
                let result = serde_json::from_str::<P>(&body)
                    .map(|p| node::check(&p.path))
                    .unwrap_or_else(|_| Err("Requête invalide.".into()));
                json_response(match result {
                    Ok(version) => serde_json::json!({ "ok": true, "version": version }),
                    Err(error) => serde_json::json!({ "ok": false, "error": error }),
                }.to_string())
            }
            (Method::Post, "/tls") => {
                // Upload du contenu (le navigateur ne donne pas le chemin
                // absolu) : copie dans .zra/tls/, le chemin absolu est renvoyé.
                #[derive(Deserialize)]
                struct P { kind: String, name: String, content: String }
                let result = (|| -> Result<String, String> {
                    let p: P = serde_json::from_str(&body).map_err(|e| format!("Requête invalide : {e}"))?;
                    if p.kind != "cert" && p.kind != "key" {
                        return Err("Type de fichier invalide.".into());
                    }
                    // Nom seul : pas de traversal ni de chemin imposé.
                    let name = std::path::Path::new(&p.name)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .filter(|n| !n.is_empty())
                        .ok_or("Nom de fichier invalide.")?;
                    let dir = paths.zra.join("tls");
                    std::fs::create_dir_all(&dir).map_err(|e| format!("Création de .zra/tls/ impossible : {e}"))?;
                    let file = dir.join(&name);
                    std::fs::write(&file, &p.content).map_err(|e| format!("Écriture impossible : {e}"))?;
                    Ok(file.to_string_lossy().to_string())
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
                            serde_json::json!({ "ok": false, "error": format!("Config invalide : {e}") }).to_string(),
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
                        serde_json::json!({ "ok": false, "error": format!("Écriture impossible : {e}") }).to_string(),
                    ));
                    continue;
                }
                let _ = request.respond(json_response(r#"{"ok":true}"#.into()));
                let _ = tx.send(cfg);
                break;
            }
            _ => html_response("Introuvable."),
        };
        let _ = request.respond(response);
    }
    rx.recv().expect("config d'onboarding")
}