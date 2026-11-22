// Chemins du dépôt et config du tray (`.zra/tray.json`).
//
// La racine est retrouvée en remontant depuis l'exécutable jusqu'à un dossier
// contenant `zra-daemon/index.js` (layout dépôt : binaire dans `.zra/bin/` ou
// `zra-tray/target/debug/`) ou `app/zra-daemon/index.js` (archive « app » :
// binaire à côté de `app/`). Dans l'archive la racine est `app/` — le daemon
// y résout sa config et `.zra` (config.js : ROOT = parent de zra-daemon/), le
// tray s'aligne pour partager les mêmes données. `ZRA_ROOT` force la racine.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Poste,
    Relais,
}

impl Mode {
    pub fn label(self) -> &'static str {
        match self {
            Mode::Poste => "Poste",
            Mode::Relais => "Relais",
        }
    }
}

/// Écoute du relais, passée en env au spawn (`zra-relay/index.js`).
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayConfig {
    pub port: u16,
    pub host: String,
    pub tls_cert: Option<String>,
    pub tls_key: Option<String>,
}

impl Default for RelayConfig {
    fn default() -> Self {
        Self { port: 7777, host: "0.0.0.0".into(), tls_cert: None, tls_key: None }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayConfig {
    pub mode: Mode,
    /// Chemin absolu de node, figé à l'onboarding (PATH appauvri en autostart).
    pub node: String,
    /// Port du daemon en mode poste — celui de `zra.config.json` (défaut 7777).
    pub port: u16,
    pub relay: RelayConfig,
}

pub struct Paths {
    pub root: PathBuf,
    pub zra: PathBuf,
    pub logs: PathBuf,
}

impl Paths {
    pub fn discover() -> Option<Self> {
        if let Ok(root) = std::env::var("ZRA_ROOT") {
            if let Some(root) = root_at(&PathBuf::from(root)) {
                return Some(Self::from_root(root));
            }
        }
        let exe = std::env::current_exe().ok()?;
        let mut dir: &Path = exe.parent()?;
        for _ in 0..8 {
            if let Some(root) = root_at(dir) {
                return Some(Self::from_root(root));
            }
            dir = dir.parent()?;
        }
        None
    }

    fn from_root(root: PathBuf) -> Self {
        let zra = root.join(".zra");
        let logs = zra.join("logs");
        Self { root, zra, logs }
    }

    pub fn tray_config(&self) -> PathBuf {
        self.zra.join("tray.json")
    }

    pub fn lock_file(&self) -> PathBuf {
        self.zra.join("tray.lock")
    }

    pub fn log_file(&self, mode: Mode) -> PathBuf {
        self.logs.join(match mode {
            Mode::Poste => "daemon.log",
            Mode::Relais => "relay.log",
        })
    }

    /// stderr du daemon supervisé (crashs) — il journalise lui-même dans
    /// daemon.log via --log, le tray ne recopie plus son stdout.
    pub fn err_log_file(&self) -> PathBuf {
        self.logs.join("daemon.err.log")
    }

    pub fn load_config(&self) -> Option<TrayConfig> {
        let text = fs::read_to_string(self.tray_config()).ok()?;
        serde_json::from_str(&text).ok()
    }

    pub fn save_config(&self, cfg: &TrayConfig) -> std::io::Result<()> {
        fs::create_dir_all(&self.zra)?;
        fs::write(self.tray_config(), serde_json::to_string_pretty(cfg).unwrap() + "\n")
    }
}

/// Racine ZRA depuis un dossier : layout dépôt (`zra-daemon/` direct) ou
/// archive « app » (`app/zra-daemon/`). Dans l'archive la racine est `app/`,
/// pour partager config et `.zra` avec le daemon (ROOT = parent de
/// zra-daemon/ côté config.js).
fn root_at(dir: &Path) -> Option<PathBuf> {
    if dir.join("zra-daemon/index.js").is_file() {
        return Some(dir.to_path_buf());
    }
    let app = dir.join("app");
    if app.join("zra-daemon/index.js").is_file() {
        return Some(app);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Dossier temporaire unique (pas de dépendance tempfile), nettoyé après.
    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zra-tray-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(path: &Path) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "").unwrap();
    }

    #[test]
    fn racine_layout_depot() {
        let dir = tmp("depot");
        touch(&dir.join("zra-daemon/index.js"));
        assert_eq!(root_at(&dir), Some(dir.clone()));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn racine_layout_archive_app() {
        let dir = tmp("archive");
        touch(&dir.join("app/zra-daemon/index.js"));
        assert_eq!(root_at(&dir), Some(dir.join("app")));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn racine_introuvable() {
        let dir = tmp("vide");
        assert_eq!(root_at(&dir), None);
        fs::remove_dir_all(&dir).unwrap();
    }
}