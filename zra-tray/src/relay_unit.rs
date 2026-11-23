// Unité systemd --user du relais (5.6, homelab) : générée par le binaire,
// plus de copier-coller depuis la doc. L'unité lance le tray en --headless ;
// lui lit `.zra/tray.json` (mode relais) et supervise node avec l'écoute et
// le TLS configurés — un seul point d'entrée, comme le backend poste.
//
// Le piège du --user (établi sur la machine de portage, scripts/lib/systemd.mjs) :
// sans linger, le service meurt à la déconnexion et ne part pas au boot.
// `loginctl enable-linger` passe sans sudo — l'installation le vérifie et
// l'active si besoin.
//
// Linux avec systemd en init uniquement (/run/systemd/system) ; ailleurs
// (MX/sysvinit), l'autostart XDG de service.mjs lance déjà le tray, qui
// suit le mode relais — rien à générer.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};

use crate::i18n::tr;

pub const UNIT: &str = "zra-relay.service";

/// systemd est-il l'init (user session disponible) ? Détection standard.
pub fn is_systemd_user() -> bool {
    cfg!(unix) && Path::new("/run/systemd/system").exists()
}

/// `~/.config/systemd/user/zra-relay.service`, en suivant XDG_CONFIG_HOME.
pub fn unit_file() -> PathBuf {
    let config = std::env::var("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
            PathBuf::from(home).join(".config")
        });
    config.join("systemd").join("user").join(UNIT)
}

/// Argument d'ExecStart/WorkingDirectory : systemd découpe sur les espaces,
/// tout ce qui en contient (ou des guillemets/backslashes) est quoté.
pub fn quote_arg(value: &str) -> String {
    if value.contains(|c: char| c.is_whitespace() || c == '"' || c == '\\') {
        format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        value.to_string()
    }
}

/// Contenu de l'unité — fonction pure, testable sans rien installer.
/// `exe` : le binaire tray ; `workdir` : le dossier de base (exe + app/).
pub fn build_unit(exe: &Path, workdir: &Path) -> String {
    format!(
        "# Généré par zra-tray — ne pas éditer à la main.
# ZRA — relais : le tray supervise node (mode relais de .zra/tray.json).
[Unit]
Description=ZRA — relais (application web + relais de connexions)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory={}
ExecStart={} --headless
# Relancé s'il s'arrête en erreur ; un arrêt propre (verrou single-instance
# tenu par un autre tray) ne relance pas — voulu, comme le backend poste.
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
",
        quote_arg(&workdir.to_string_lossy()),
        quote_arg(&exe.to_string_lossy()),
    )
}

fn systemctl(args: &[&str]) -> (bool, String) {
    match Command::new("systemctl").arg("--user").args(args).output() {
        Ok(o) => (
            o.status.success(),
            format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr)).trim().to_string(),
        ),
        Err(e) => (false, tr!("systemctl impossible : {0}", e)),
    }
}

/// Linger activé ? (None si loginctl ne répond pas)
pub fn linger() -> Option<bool> {
    let user = std::env::var("USER").or_else(|_| std::env::var("LOGNAME")).ok()?;
    let out = Command::new("loginctl").args(["show-user", &user, "--property=Linger"]).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    if text.contains("Linger=yes") {
        Some(true)
    } else if text.contains("Linger=no") {
        Some(false)
    } else {
        None
    }
}

/// État pour la console : même forme que serviceState() côté Node
/// ({ backend, installed }) — la page n'y voit que du feu.
pub fn state() -> Value {
    let installed = unit_file().is_file();
    let enabled = installed && systemctl(&["is-enabled", UNIT]).0;
    json!({
        "backend": "systemd --user (relais)",
        "installed": installed,
        "enabled": enabled,
        "linger": linger(),
        "file": unit_file().to_string_lossy(),
    })
}

/// Installe l'unité : écrit, daemon-reload, enable (boot). Le tray courant
/// continue de tourner ; au prochain boot l'unité le lance (single-instance :
/// si un autre tray tient déjà le verrou, celui de l'unité sort proprement).
pub fn install(exe: &Path, workdir: &Path) -> Result<String, String> {
    let file = unit_file();
    std::fs::create_dir_all(file.parent().unwrap()).map_err(|e| tr!("création du dossier systemd : {0}", e))?;
    std::fs::write(&file, build_unit(exe, workdir)).map_err(|e| tr!("écriture de l'unité : {0}", e))?;
    let (ok, out) = systemctl(&["daemon-reload"]);
    if !ok {
        return Err(tr!("daemon-reload : {0}", out));
    }
    let (ok, out) = systemctl(&["enable", UNIT]);
    if !ok {
        return Err(tr!("enable : {0}", out));
    }
    let mut note = tr!("Unité {0} écrite et activée ({1}).", UNIT, file.display());
    if linger() == Some(false) {
        let user = std::env::var("USER").or_else(|_| std::env::var("LOGNAME")).unwrap_or_default();
        let out = Command::new("loginctl").args(["enable-linger", &user]).output();
        match out {
            Ok(o) if o.status.success() => note.push_str(&tr!(" Linger activé (démarre au boot, survit à la déconnexion).")),
            _ => note.push_str(&tr!(" ⚠ linger désactivé : activer `loginctl enable-linger $USER` pour un démarrage au boot.")),
        }
    }
    Ok(note)
}

/// Retrait : disable --now, suppression, daemon-reload. Idempotent.
pub fn uninstall() -> Result<String, String> {
    let file = unit_file();
    if !file.is_file() {
        return Ok(tr!("Unité {0} : déjà absente.", UNIT));
    }
    systemctl(&["disable", "--now", UNIT]);
    std::fs::remove_file(&file).map_err(|e| tr!("suppression de l'unité : {0}", e))?;
    let (ok, out) = systemctl(&["daemon-reload"]);
    if !ok {
        return Err(tr!("daemon-reload : {0}", out));
    }
    Ok(tr!("Unité {0} supprimée.", UNIT))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_unit_contenu_et_quoting() {
        let unit = build_unit(Path::new("/opt/zra/zra-tray"), Path::new("/opt/zra"));
        assert!(unit.contains("ExecStart=/opt/zra/zra-tray --headless"));
        assert!(unit.contains("WorkingDirectory=/opt/zra"));
        assert!(unit.contains("WantedBy=default.target"));
        assert!(unit.contains("Restart=on-failure"));
        // Chemins avec espaces : quotés comme systemd l'exige.
        let unit = build_unit(Path::new("/home/moi/Mes projets/zra/zra-tray"), Path::new("/home/moi/Mes projets/zra"));
        assert!(unit.contains("ExecStart=\"/home/moi/Mes projets/zra/zra-tray\" --headless"));
        assert!(unit.contains("WorkingDirectory=\"/home/moi/Mes projets/zra\""));
    }

    #[test]
    fn quote_arg_echappe_guillemets_et_backslashes() {
        assert_eq!(quote_arg("simple"), "simple");
        assert_eq!(quote_arg("avec espace"), "\"avec espace\"");
        assert_eq!(quote_arg("a\"b"), "\"a\\\"b\"");
        assert_eq!(quote_arg("a\\b"), "\"a\\\\b\"");
    }

    #[test]
    fn unit_file_suit_xdg() {
        let _g = crate::testutil::env_guard();
        std::env::set_var("XDG_CONFIG_HOME", "/tmp/zra-xdg-test");
        assert_eq!(unit_file(), PathBuf::from("/tmp/zra-xdg-test/systemd/user/zra-relay.service"));
        std::env::remove_var("XDG_CONFIG_HOME");
    }
}