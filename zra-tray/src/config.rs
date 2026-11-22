// Chemins du dépôt et config du tray (`.zra/tray.json`).
//
// La racine est retrouvée en remontant depuis l'exécutable jusqu'à un dossier
// contenant `zra-daemon/index.js` — que le binaire soit dans `.zra/bin/`
// (téléchargé au setup), à la racine d'une archive « app », ou dans
// `zra-tray/target/debug/` (dev). `ZRA_ROOT` force la racine.

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
            let root = PathBuf::from(root);
            if root.join("zra-daemon/index.js").is_file() {
                return Some(Self::from_root(root));
            }
        }
        let exe = std::env::current_exe().ok()?;
        let mut dir: &Path = exe.parent()?;
        for _ in 0..8 {
            if dir.join("zra-daemon/index.js").is_file() {
                return Some(Self::from_root(dir.to_path_buf()));
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

    pub fn load_config(&self) -> Option<TrayConfig> {
        let text = fs::read_to_string(self.tray_config()).ok()?;
        serde_json::from_str(&text).ok()
    }

    pub fn save_config(&self, cfg: &TrayConfig) -> std::io::Result<()> {
        fs::create_dir_all(&self.zra)?;
        fs::write(self.tray_config(), serde_json::to_string_pretty(cfg).unwrap() + "\n")
    }
}