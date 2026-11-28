// Unité systemd --user du relais (5.6, homelab) : générée par le binaire,
// plus de copier-coller depuis la doc. L'unité lance le tray (headless
// automatique sans session graphique) ; il lit `.zra/tray.json` (mode
// relais) et supervise node avec l'écoute et le TLS configurés — un seul
// point d'entrée, comme le backend poste.
//
// Reprise graphique : avec linger, l'unité démarre au boot sans session —
// le tray est headless, sans icône. Une entrée XDG autostart compagnon
// (`zra-relay-login.desktop`) relance le tray avec l'environnement de la
// session à l'ouverture de session, si le marqueur `.zra/tray.session`
// ne correspond pas (tray headless ou session périmée).
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
/// Pas de `--headless` forcé : au boot sans session, le tray se détecte
/// headless tout seul ; relancé avec l'environnement graphique (reprise
/// XDG), il crée l'icône.
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
ExecStart={}
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

/// Entrée XDG autostart de reprise graphique (compagnon de l'unité).
pub fn login_desktop_file() -> PathBuf {
    let config = std::env::var("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
            PathBuf::from(home).join(".config")
        });
    config.join("autostart").join("zra-relay-login.desktop")
}

/// Lanceur de reprise graphique, dans le `.zra` jetable de l'app.
pub fn login_script(workdir: &Path) -> PathBuf {
    workdir.join(".zra").join("service").join("zra-relay-login.sh")
}

/// Quoting shell POSIX : single quotes, le seul caractère à échapper est '.
fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Contenu du lanceur — fonction pure. Compare le marqueur de session
/// (écrit par le tray au démarrage) à la session courante ; différent ou
/// absent → importe l'environnement graphique dans le manager user et
/// relance l'unité (le tray recrée alors l'icône). Session identique → rien.
pub fn build_login_script(marker: &Path) -> String {
    format!(
        "#!/bin/sh
# Généré par zra-tray — ne pas éditer à la main.
# Reprise graphique du relais : le tray lancé au boot (linger) tourne sans
# session ; à l'ouverture de session, le relancer avec l'environnement
# graphique s'il est headless ou périmé. Sans effet si la session correspond.
marker={}
current=$(printf '%s\\n%s\\n%s\\n%s' \"${{DISPLAY:-}}\" \"${{WAYLAND_DISPLAY:-}}\" \"${{DBUS_SESSION_BUS_ADDRESS:-}}\" \"${{XDG_SESSION_ID:-}}\")
if [ -f \"$marker\" ] && [ \"$(cat \"$marker\")\" = \"$current\" ]; then
  exit 0
fi
systemctl --user import-environment DISPLAY WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS XAUTHORITY XDG_SESSION_TYPE XDG_CURRENT_DESKTOP XDG_SESSION_ID
systemctl --user restart {}
",
        sh_quote(&marker.to_string_lossy()),
        UNIT,
    )
}

/// Contenu de l'entrée XDG autostart — fonction pure.
pub fn build_login_desktop(script: &Path) -> String {
    format!(
        "[Desktop Entry]
Type=Application
Name={}
Comment={}
Exec=sh {}
NoDisplay=true
X-GNOME-Autostart-enabled=true
",
        tr!("ZRA — relais (reprise graphique)"),
        tr!("Relance le tray ZRA avec la session graphique s'il a démarré au boot sans elle."),
        quote_arg(&script.to_string_lossy()),
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
/// Pose aussi l'entrée XDG de reprise graphique (icône au login).
pub fn install(exe: &Path, workdir: &Path) -> Result<String, String> {
    let file = unit_file();
    std::fs::create_dir_all(file.parent().unwrap()).map_err(|e| tr!("création du dossier systemd : {0}", e))?;
    std::fs::write(&file, build_unit(exe, workdir)).map_err(|e| tr!("écriture de l'unité : {0}", e))?;
    let script = login_script(workdir);
    std::fs::create_dir_all(script.parent().unwrap()).map_err(|e| tr!("création du dossier service : {0}", e))?;
    std::fs::write(&script, build_login_script(&workdir.join(".zra").join("tray.session")))
        .map_err(|e| tr!("écriture du lanceur de reprise : {0}", e))?;
    let desktop = login_desktop_file();
    std::fs::create_dir_all(desktop.parent().unwrap()).map_err(|e| tr!("création du dossier autostart : {0}", e))?;
    std::fs::write(&desktop, build_login_desktop(&script)).map_err(|e| tr!("écriture de l'entrée de reprise : {0}", e))?;
    let (ok, out) = systemctl(&["daemon-reload"]);
    if !ok {
        return Err(tr!("daemon-reload : {0}", out));
    }
    let (ok, out) = systemctl(&["enable", UNIT]);
    if !ok {
        return Err(tr!("enable : {0}", out));
    }
    let mut note = tr!("Unité {0} écrite et activée ({1}).", UNIT, file.display());
    note.push_str(&tr!(" Reprise graphique à l'ouverture de session : {0}.", desktop.display()));
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
pub fn uninstall(workdir: &Path) -> Result<String, String> {
    remove(workdir, true)
}

/// Retrait sans arrêter le processus courant (migration de mode) : disable
/// seul, le tray vivant continue jusqu'à la bascule suivante.
pub fn uninstall_keep_running(workdir: &Path) -> Result<String, String> {
    remove(workdir, false)
}

fn remove(workdir: &Path, stop: bool) -> Result<String, String> {
    let file = unit_file();
    let desktop = login_desktop_file();
    if !file.is_file() && !desktop.is_file() {
        return Ok(tr!("Unité {0} : déjà absente.", UNIT));
    }
    if stop {
        systemctl(&["disable", "--now", UNIT]);
    } else {
        systemctl(&["disable", UNIT]);
    }
    if file.is_file() {
        std::fs::remove_file(&file).map_err(|e| tr!("suppression de l'unité : {0}", e))?;
    }
    let _ = std::fs::remove_file(&desktop);
    let _ = std::fs::remove_file(login_script(workdir));
    let (ok, out) = systemctl(&["daemon-reload"]);
    if !ok {
        return Err(tr!("daemon-reload : {0}", out));
    }
    Ok(if stop {
        tr!("Unité {0} supprimée.", UNIT)
    } else {
        tr!("Unité {0} désactivée et supprimée (processus courant laissé vivant).", UNIT)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_unit_contenu_et_quoting() {
        let unit = build_unit(Path::new("/opt/zra/zra-tray"), Path::new("/opt/zra"));
        assert!(unit.contains("ExecStart=/opt/zra/zra-tray"));
        // Pas de --headless forcé : headless auto au boot, icône après reprise.
        assert!(!unit.contains("--headless"));
        assert!(unit.contains("WorkingDirectory=/opt/zra"));
        assert!(unit.contains("WantedBy=default.target"));
        assert!(unit.contains("Restart=on-failure"));
        // Chemins avec espaces : quotés comme systemd l'exige.
        let unit = build_unit(Path::new("/home/moi/Mes projets/zra/zra-tray"), Path::new("/home/moi/Mes projets/zra"));
        assert!(unit.contains("ExecStart=\"/home/moi/Mes projets/zra/zra-tray\""));
        assert!(unit.contains("WorkingDirectory=\"/home/moi/Mes projets/zra\""));
    }

    #[test]
    fn login_script_compare_marqueur_et_relance() {
        let script = build_login_script(Path::new("/opt/zra/.zra/tray.session"));
        assert!(script.contains("marker='/opt/zra/.zra/tray.session'"));
        assert!(script.contains("import-environment DISPLAY WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS"));
        assert!(script.contains("systemctl --user restart zra-relay.service"));
        assert!(script.contains("XDG_SESSION_ID"));
        // Chemin avec apostrophe : échappé shell.
        let script = build_login_script(Path::new("/home/l'user/zra/tray.session"));
        assert!(script.contains("'/home/l'\\''user/zra/tray.session'"));
    }

    #[test]
    fn login_desktop_pointe_vers_le_lanceur() {
        let desktop = build_login_desktop(Path::new("/opt/zra/.zra/service/zra-relay-login.sh"));
        assert!(desktop.contains("Exec=sh /opt/zra/.zra/service/zra-relay-login.sh"));
        assert!(desktop.contains("NoDisplay=true"));
        let desktop = build_login_desktop(Path::new("/home/moi/Mes projets/zra-login.sh"));
        assert!(desktop.contains("Exec=sh \"/home/moi/Mes projets/zra-login.sh\""));
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