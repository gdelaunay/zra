// Détection de Node ≥ 24 : scan du PATH + emplacements usuels, vérification
// par `node --version`. Le chemin absolu est figé dans la config du tray.

use std::path::PathBuf;
use std::process::Command;

use crate::i18n::tr;

/// Version majeure de « v24.1.0 » → 24.
fn major(version: &str) -> Option<u32> {
    version.trim().trim_start_matches('v').split('.').next()?.parse().ok()
}

/// `node --version` sur un chemin précis : Ok(version) ou Err(message lisible).
pub fn check(path: &str) -> Result<String, String> {
    if path.trim().is_empty() {
        return Err(tr!("Chemin vide."));
    }
    let mut cmd = Command::new(path);
    cmd.arg("--version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd
        .output()
        .map_err(|e| tr!("Impossible de lancer « {0} » : {1}", path, e))?;
    if !out.status.success() {
        return Err(tr!("« {0} » ne répond pas correctement à --version.", path));
    }
    let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
    match major(&version) {
        Some(m) if m >= 24 => Ok(version),
        Some(_) => Err(tr!("Node ≥ 24 requis — trouvé {0}.", version)),
        None => Err(tr!("Version illisible : « {0} ».", version)),
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