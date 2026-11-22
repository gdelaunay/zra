// Interrogation du service local : `GET /status` et `GET /pair` du daemon
// (loopback, http ou https — le cert est émis pour un domaine, pas pour
// 127.0.0.1, donc pas de vérification), simple connexion TCP pour le relais.

use std::net::{TcpStream, ToSocketAddrs};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

fn agent() -> ureq::Agent {
    // native-tls : même schéma que scripts/lib/daemon-status.mjs, on accepte
    // le certificat du domaine présenté sur la loopback.
    let connector = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .expect("connecteur TLS");
    ureq::AgentBuilder::new()
        .timeout(Duration::from_millis(1500))
        .tls_connector(Arc::new(connector))
        .build()
}

fn get_json(url: &str) -> Option<Value> {
    let body = agent().get(url).call().ok()?.into_string().ok()?;
    serde_json::from_str(&body).ok()
}

/// `/status` du daemon : http puis https (comme daemon-status.mjs).
/// Renvoie (schéma, corps JSON).
pub fn daemon_status(port: u16) -> Option<(&'static str, Value)> {
    for scheme in ["http", "https"] {
        if let Some(v) = get_json(&format!("{scheme}://127.0.0.1:{port}/status")) {
            return Some((scheme, v));
        }
    }
    None
}

/// Code d'appairage : `/pair`, rouvert par `/pair/rotate` si verrouillé
/// (même logique que scripts/pair.mjs — être sur le poste suffit).
pub fn pair_code(port: u16) -> Option<String> {
    for scheme in ["http", "https"] {
        let base = format!("{scheme}://127.0.0.1:{port}");
        let Some(body) = get_json(&format!("{base}/pair")) else { continue };
        if body.get("locked").and_then(Value::as_bool) == Some(true) {
            let rotated = agent()
                .post(&format!("{base}/pair/rotate"))
                .call()
                .ok()?
                .into_string()
                .ok()?;
            let rotated: Value = serde_json::from_str(&rotated).ok()?;
            return rotated.get("code")?.as_str().map(str::to_string);
        }
        return body.get("code")?.as_str().map(str::to_string);
    }
    None
}

/// Le relais écoute-t-il ? (pas de /status côté relais : connexion TCP).
pub fn relay_up(port: u16) -> bool {
    let addr = match ("127.0.0.1", port).to_socket_addrs() {
        Ok(mut a) => match a.next() {
            Some(a) => a,
            None => return false,
        },
        Err(_) => return false,
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(800)).is_ok()
}