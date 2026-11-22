// Détection de Node ≥ 24 : scan du PATH + emplacements usuels, vérification
// par `node --version`. Le chemin absolu est figé dans la config du tray.

use std::path::PathBuf;
use std::process::Command;

/// Version majeure de « v24.1.0 » → 24.
fn major(version: &str) -> Option<u32> {
    version.trim().trim_start_matches('v').split('.').next()?.parse().ok()
}

/// `node --version` sur un chemin précis : Ok(version) ou Err(message lisible).
pub fn check(path: &str) -> Result<String, String> {
    if path.trim().is_empty() {
        return Err("Chemin vide.".into());
    }
    let out = Command::new(path)
        .arg("--version")
        .output()
        .map_err(|e| format!("Impossible de lancer « {path} » : {e}"))?;
    if !out.status.success() {
        return Err(format!("« {path} » ne répond pas correctement à --version."));
    }
    let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
    match major(&version) {
        Some(m) if m >= 24 => Ok(version),
        Some(_) => Err(format!("Node ≥ 24 requis — trouvé {version}.")),
        None => Err(format!("Version illisible : « {version} ».")),
    }
}

/// Premier node ≥ 24 trouvé : emplacements usuels puis PATH.
pub fn detect() -> Option<(String, String)> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if cfg!(windows) {
        candidates.push(PathBuf::from(r"C:\Program Files\nodejs\node.exe"));
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            // nvm-windows, fnm… installations par utilisateur.
            candidates.push(PathBuf::from(local).join("nodejs").join("node.exe"));
        }
    } else {
        for p in ["/usr/bin/node", "/usr/local/bin/node", "/opt/homebrew/bin/node"] {
            candidates.push(PathBuf::from(p));
        }
    }
    let sep = if cfg!(windows) { ';' } else { ':' };
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(sep) {
            if !dir.is_empty() {
                candidates.push(PathBuf::from(dir).join(if cfg!(windows) { "node.exe" } else { "node" }));
            }
        }
    }
    for cand in candidates {
        if !cand.is_file() {
            continue;
        }
        let path = cand.to_string_lossy().to_string();
        if let Ok(version) = check(&path) {
            return Some((path, version));
        }
    }
    None
}