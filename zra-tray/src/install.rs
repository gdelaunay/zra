// Self-install par le tray (5.7, conception figée). Le zip est le produit :
// lancé tel quel il tourne en portable ; sur choix de l'utilisateur il
// s'auto-installe dans un emplacement fixe — pas d'installeur tiers, le tray
// fait tout. L'emplacement fixe tue le piège « dossier déplacé → chemins
// absolus périmés » du portable.
//
// - Cibles : %LOCALAPPDATA%\Programs\zra (Windows, convention VS Code, sans
//   élévation) ; ~/.local/share/zra (Linux).
// - La copie : exe vivant verrouillé sous Windows, mais la lecture/copie est
//   permise — copier exe + app/ vers la cible, lancer la copie, l'originale
//   se ferme. Pas d'exe helper dédié. `.zra/` et `zra.config.json` voyagent
//   dans app/ : rien à réécrire côté données.
// - Après migration, recâblage des chemins absolus : `setup install --apply`
//   (preload Zed, entrées agents — tous les agents lançables) + `service
//   install --apply` (autostart), depuis la cible.
// - Raccourci Menu Démarrer + clé HKCU « Applications installées » posés à
//   l'installation (Windows) ; sous Linux le backend service existant pose
//   le .desktop / l'unité.
// - Pas de retour arrière : la sortie est la désinstallation (5.5).
// - Cas limite : une copie portable relancée alors qu'une instance installée
//   existe → lancer l'installée, pas deux vies parallèles (main.rs, layout
//   app seulement — le dev en layout dépôt n'est pas détourné).

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::config::Paths;
use crate::orchestrate::{self, Step};
use crate::update::copy_rec;

/// Emplacement cible de l'installation (sans élévation).
pub fn target() -> Option<PathBuf> {
    if cfg!(windows) {
        let local = std::env::var("LOCALAPPDATA").ok()?;
        Some(PathBuf::from(local).join("Programs").join("zra"))
    } else {
        let home = std::env::var("HOME").ok()?;
        Some(PathBuf::from(home).join(".local").join("share").join("zra"))
    }
}

/// Le tray tourne-t-il depuis l'emplacement installé ?
pub fn is_installed() -> bool {
    let (Ok(exe), Some(target)) = (std::env::current_exe(), target()) else { return false };
    let exe = exe.to_string_lossy().to_lowercase();
    let target = target.to_string_lossy().to_lowercase();
    exe.starts_with(&target)
}

/// Une installation valide existe-t-elle déjà ? (exe + app/ complet)
pub fn installed_exists() -> bool {
    let Some(target) = target() else { return false };
    let exe = target.join(if cfg!(windows) { "zra-tray.exe" } else { "zra-tray" });
    exe.is_file() && target.join("app/zra-daemon/index.js").is_file()
}

/// Copie exe + app/ (la racine du tray) vers la cible. Renvoie le dossier de
/// base installé. La racine doit être le layout « app » (archive) — un repo
/// cloné ne s'« installe » pas en se copiant (guard côté appelant).
pub fn copy_to_target(paths: &Paths) -> Result<PathBuf, String> {
    let target = target().ok_or("emplacement d'installation introuvable (LOCALAPPDATA/HOME)")?;
    copy_to(paths, &target)
}

/// Cœur de la copie, cible explicite (testable sans variables d'env).
pub(crate) fn copy_to(paths: &Paths, target: &Path) -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    fs::create_dir_all(target).map_err(|e| format!("création de {} : {e}", target.display()))?;
    let new_exe = target.join(if cfg!(windows) { "zra-tray.exe" } else { "zra-tray" });
    // Lecture d'un exe vivant permise (Windows) ; l'ancien reste en place.
    fs::copy(&exe, &new_exe).map_err(|e| format!("copie de l'exécutable : {e}"))?;
    copy_rec(&paths.root, &target.join("app")).map_err(|e| format!("copie de app/ : {e}"))?;
    Ok(target.to_path_buf())
}

/// Recâblage des chemins absolus depuis la cible : Zed (tous les agents
/// lançables) + autostart. Les scripts Node font la chirurgie JSONC.
pub fn rewire(target_paths: &Paths, node: &str) -> Vec<Step> {
    vec![
        orchestrate::run_script(target_paths, node, "Agents Zed (recâblage)", "setup.mjs",
            &["install".to_string(), "--apply".to_string(), "yes".to_string()]),
        orchestrate::run_script(target_paths, node, "Démarrage automatique (recâblage)", "service.mjs",
            &["install".to_string(), "--apply".to_string()]),
    ]
}

/// Raccourci Menu Démarrer + clé HKCU « Applications installées » (Windows).
/// Linux : rien ici — le backend service (recâblage) pose le .desktop/l'unité.
#[cfg(windows)]
pub fn shortcuts(target: &Path, version: Option<String>) -> Vec<Step> {
    let mut steps = Vec::new();
    let exe = target.join("zra-tray.exe");

    // Raccourci : WScript.Shell en PowerShell (pas de crate COM).
    let start_menu = std::env::var("APPDATA").ok().map(|a| {
        PathBuf::from(a).join("Microsoft").join("Windows").join("Start Menu").join("Programs").join("ZRA.lnk")
    });
    if let Some(lnk) = start_menu {
        let script = format!(
            "$ws = New-Object -ComObject WScript.Shell; $sc = $ws.CreateShortcut('{}'); $sc.TargetPath = '{}'; $sc.WorkingDirectory = '{}'; $sc.Save()",
            lnk.to_string_lossy().replace('\'', "''"),
            exe.to_string_lossy().replace('\'', "''"),
            target.to_string_lossy().replace('\'', "''"),
        );
        let out = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output();
        let (ok, output) = match out {
            Ok(o) if o.status.success() => (true, format!("Raccourci : {}", lnk.display())),
            Ok(o) => (false, String::from_utf8_lossy(&o.stderr).trim().to_string()),
            Err(e) => (false, format!("PowerShell impossible : {e}")),
        };
        steps.push(Step { label: "Raccourci Menu Démarrer".into(), ok, output });
    }

    // Clé HKCU (sans élévation) — retirée à la désinstallation (5.5).
    let key = crate::uninstall::UNINSTALL_KEY;
    let values: Vec<(&str, String)> = vec![
        ("DisplayName", "ZRA".into()),
        ("DisplayVersion", version.unwrap_or_else(|| env!("CARGO_PKG_VERSION").into())),
        ("Publisher", "ZRA".into()),
        ("InstallLocation", target.to_string_lossy().to_string()),
        ("UninstallString", format!("\"{}\"", exe.to_string_lossy())),
    ];
    let mut reg_ok = true;
    let mut reg_out = String::new();
    for (name, value) in values {
        let out = Command::new("reg.exe")
            .args(["add", key, "/v", name, "/t", "REG_SZ", "/d", &value, "/f"])
            .output();
        match out {
            Ok(o) if o.status.success() => {}
            Ok(o) => {
                reg_ok = false;
                reg_out = String::from_utf8_lossy(&o.stderr).trim().to_string();
                break;
            }
            Err(e) => {
                reg_ok = false;
                reg_out = format!("reg.exe impossible : {e}");
                break;
            }
        }
    }
    steps.push(Step {
        label: "Applications installées (registre)".into(),
        ok: reg_ok,
        output: if reg_ok { "Clé ZRA posée (HKCU).".into() } else { reg_out },
    });
    steps
}

#[cfg(not(windows))]
pub fn shortcuts(_target: &Path, _version: Option<String>) -> Vec<Step> {
    Vec::new()
}

/// Lance une copie du tray (détachée, sans console Windows). L'appelant
/// s'arrête ensuite : pas deux vies parallèles.
pub fn launch(exe: &Path, workdir: &Path) -> Result<(), String> {
    let mut cmd = Command::new(exe);
    cmd.current_dir(workdir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.spawn().map_err(|e| format!("lancement de la copie installée : {e}"))?;
    Ok(())
}

/// Mémorise le choix portable (même pattern que le « jamais » du
/// téléchargement tray, `.zra/setup.json`) — fusion avec l'existant.
pub fn remember_portable(paths: &Paths) {
    let file = paths.zra.join("setup.json");
    let mut v: serde_json::Value = fs::read_to_string(&file)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    v["portable"] = serde_json::json!(true);
    let _ = fs::create_dir_all(&paths.zra);
    let _ = fs::write(&file, serde_json::to_string_pretty(&v).unwrap() + "\n");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_suit_les_variables_denvironnement() {
        let _g = crate::testutil::env_guard();
        if cfg!(windows) {
            std::env::set_var("LOCALAPPDATA", "C:/fake-local");
            assert_eq!(target().unwrap(), PathBuf::from("C:/fake-local/Programs/zra"));
        } else {
            std::env::set_var("HOME", "/fake-home");
            assert_eq!(target().unwrap(), PathBuf::from("/fake-home/.local/share/zra"));
        }
    }

    #[test]
    fn copy_to_target_structure() {
        let dir = std::env::temp_dir().join(format!("zra-install-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let root = dir.join("portable").join("app");
        fs::create_dir_all(root.join("zra-daemon")).unwrap();
        fs::create_dir_all(root.join(".zra")).unwrap();
        fs::write(root.join("zra-daemon/index.js"), "daemon").unwrap();
        fs::write(root.join("zra.config.json"), "config").unwrap();
        fs::write(root.join(".zra/tray.json"), "tray").unwrap();
        let fake_local = dir.join("local");
        let paths = Paths::from_root(root);
        let target = copy_to(&paths, &fake_local.join("zra")).expect("copie");
        assert!(target.join("app/zra-daemon/index.js").is_file());
        assert_eq!(fs::read_to_string(target.join("app/zra.config.json")).unwrap(), "config");
        assert_eq!(fs::read_to_string(target.join("app/.zra/tray.json")).unwrap(), "tray", "les données voyagent");
        // L'exe copié est le binaire de test lui-même (current_exe).
        let exe = target.join(if cfg!(windows) { "zra-tray.exe" } else { "zra-tray" });
        assert!(exe.is_file());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn remember_portable_fusionne_setup_json() {
        let dir = std::env::temp_dir().join(format!("zra-install-portable-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let root = dir.join("app");
        fs::create_dir_all(root.join(".zra")).unwrap();
        fs::write(root.join(".zra/setup.json"), "{\"trayDownload\":\"never\"}").unwrap();
        let paths = Paths::from_root(root);
        remember_portable(&paths);
        let v: serde_json::Value = serde_json::from_str(&fs::read_to_string(paths.zra.join("setup.json")).unwrap()).unwrap();
        assert_eq!(v["trayDownload"], "never", "l'existant est préservé");
        assert_eq!(v["portable"], true);
        fs::remove_dir_all(&dir).unwrap();
    }
}