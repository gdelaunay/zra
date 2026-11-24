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

use crate::i18n::tr;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Poste,
    Relais,
}

impl Mode {
    pub fn label(self) -> String {
        match self {
            Mode::Poste => tr!("Poste"),
            Mode::Relais => tr!("Relais"),
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
    /// `.zra` de la racine — jetable (logs, verrou, updates, bin).
    pub zra: PathBuf,
    /// `.zra` du dossier config — précieux (tray.json, setup.json, tls).
    /// Installé : dossier config utilisateur ; portable/dépôt : égal à `zra`.
    pub config_zra: PathBuf,
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

    pub(crate) fn from_root(root: PathBuf) -> Self {
        let zra = root.join(".zra");
        let logs = zra.join("logs");
        let config_zra = config_root(&root).join(".zra");
        Self { root, zra, config_zra, logs }
    }

    pub fn tray_config(&self) -> PathBuf {
        self.config_zra.join("tray.json")
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
        // BOM UTF-8 (Notepad, PowerShell 5.1) : toléré, pas un JSON invalide.
        serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()
    }

    pub fn save_config(&self, cfg: &TrayConfig) -> std::io::Result<()> {
        fs::create_dir_all(&self.config_zra)?;
        fs::write(self.tray_config(), serde_json::to_string_pretty(cfg).unwrap() + "\n")
    }
}

/// Dossier config utilisateur ZRA (layout installé) : `%APPDATA%\zra` (Windows)
/// / `$XDG_CONFIG_HOME/zra` (Linux, défaut `~/.config/zra`). Miroir de
/// `zra-daemon/platform.js::zedPaths().zraConfigDir`.
pub fn zra_config_dir() -> Option<PathBuf> {
    if cfg!(windows) {
        Some(PathBuf::from(std::env::var("APPDATA").ok()?).join("zra"))
    } else {
        let base = match std::env::var("XDG_CONFIG_HOME") {
            Ok(v) if !v.is_empty() => PathBuf::from(v),
            _ => PathBuf::from(std::env::var("HOME").ok()?).join(".config"),
        };
        Some(base.join("zra"))
    }
}

/// Affichage d'un chemin : séparateurs natifs de l'OS. Sous Windows les
/// chemins peuvent arriver avec des `/` (env, saisie, jointures) — la console
/// les montre tous en `\`, pas de mélange.
pub fn display_path(s: &str) -> String {
    if cfg!(windows) { s.replace('/', "\\") } else { s.to_string() }
}

/// Racine de la config + données précieuses : dossier config utilisateur en
/// layout installé (hors zone swappée à l'update), racine sinon (portable/dépôt).
/// Miroir de `platform.js::configRoot`.
pub fn config_root(root: &Path) -> PathBuf {
    if crate::install::is_installed() {
        if let Some(dir) = zra_config_dir() {
            return dir;
        }
    }
    root.to_path_buf()
}

/// Entrées `.zra` jetables (régénérées au runtime, dans le dossier d'install) :
/// tout le reste de `.zra` est précieux et vit dans le dossier config.
pub const JETABLE: &[&str] = &["logs", "bin", "records", "updates", "tray.lock", "injections.log"];

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

    #[test]
    fn display_path_separateurs_natifs() {
        if cfg!(windows) {
            assert_eq!(display_path("C:/x\\y/z"), "C:\\x\\y\\z");
        } else {
            assert_eq!(display_path("/x/y"), "/x/y");
        }
    }

    #[test]
    fn load_config_tolerant_bom() {
        let dir = tmp("bom");
        let paths = Paths::from_root(dir.clone());
        fs::create_dir_all(&paths.config_zra).unwrap();
        let json = "{\"mode\":\"poste\",\"node\":\"n\",\"port\":7777,\"relay\":{\"port\":7777,\"host\":\"0.0.0.0\",\"tlsCert\":null,\"tlsKey\":null}}";
        fs::write(paths.tray_config(), format!("\u{feff}{json}")).unwrap();
        assert!(paths.load_config().is_some(), "le BOM ne doit pas invalider tray.json");
        fs::remove_dir_all(&dir).unwrap();
    }
}