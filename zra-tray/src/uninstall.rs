// Désinstallation (5.5) : rendre la machine comme on l'a trouvée.
//
// - arrêt du service (les enfants meurent avec le tray : Job Object /
//   PDEATHSIG) ;
// - retrait de l'autostart (tâche planifiée / systemd --user / XDG) et
//   dé-câblage de Zed (entrées agents, keymap, env) — les scripts Node
//   existants (`service.mjs uninstall`, `setup.mjs uninstall`), pas de
//   réimplémentation de la chirurgie JSONC en Rust ;
// - clé HKCU « Applications installées » retirée (Windows, posée à
//   l'installation 5.7 — idempotent si absente) ;
// - suppression du dossier (binaire, app/, .zra : journaux, enregistrements,
//   appairage, certs). L'exe vivant est verrouillé sous Windows : suppression
//   différée après exit par un script détaché (même mécanique que l'update).
//   Sous Linux, suppression directe (l'exe vivant peut être unlinké).
//
// Deux choix : « tout désinstaller » (défaut, plus aucune trace) ou « garder
// mes réglages » (export de zra.config.json dans le dossier personnel avant
// suppression, pour une réinstallation). Les prérequis système (Node, Zed)
// ne sont pas touchés. Le pare-feu n'a aucune règle à retirer (rien n'a été
// posé). Pas de « désinstaller le tray seul » : sans lui, plus rien ne gère
// l'app pour ce public.
//
// Layout dépôt (contributeur) : dé-câblage + autostart + arrêt, mais le
// dossier cloné n'est PAS supprimé — le contributeur gère son repo.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};

use crate::config::Paths;
use crate::orchestrate::{self, Step};
use crate::relay_unit;
use crate::i18n::tr;
use crate::update::is_app_layout;

/// Clé « Applications installées » (HKCU, sans élévation) — posée à
/// l'installation (5.7), retirée ici.
pub const UNINSTALL_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\ZRA";

/// Le dossier à supprimer : celui qui contient l'exe et app/ (layout archive).
/// En layout dépôt, None — on ne supprime pas un repo cloné.
pub fn base_dir(paths: &Paths) -> Option<PathBuf> {
    if !is_app_layout(paths) {
        return None;
    }
    paths.root.parent().map(Path::to_path_buf)
}

/// « Garder mes paramètres » : la config + données précieuses restent dans le
/// dossier config utilisateur. Installé : elles y sont déjà. Portable : copie
/// depuis la racine (le jetable reste dehors). Idempotent.
fn keep_config(paths: &Paths) -> Option<PathBuf> {
    let dest = crate::config::zra_config_dir()?;
    if crate::install::is_installed() {
        return Some(dest);
    }
    let _ = fs::create_dir_all(&dest);
    let cfg = paths.root.join("zra.config.json");
    if cfg.is_file() {
        let _ = fs::copy(&cfg, dest.join("zra.config.json"));
    }
    let dest_zra = dest.join(".zra");
    let _ = fs::create_dir_all(&dest_zra);
    if let Ok(entries) = fs::read_dir(&paths.zra) {
        for e in entries.flatten() {
            let name = e.file_name();
            let name = name.to_string_lossy();
            if crate::config::JETABLE.contains(&name.as_ref()) {
                continue;
            }
            let src = e.path();
            let dst = dest_zra.join(&*name);
            if src.is_dir() {
                let _ = crate::update::copy_rec(&src, &dst);
            } else {
                let _ = fs::copy(&src, &dst);
            }
        }
    }
    Some(dest)
}

/// Étapes Node : dé-câblage Zed + retrait autostart. Idempotents — un poste
/// relais sans Zed câblé ne produit pas d'erreur bloquante.
pub fn unwire(paths: &Paths, node: &str) -> Vec<Step> {
    let mut steps = vec![
        orchestrate::run_script(paths, node, &tr!("Dé-câblage de Zed"), "setup.mjs",
            &["uninstall".to_string(), "--apply".to_string()]),
        orchestrate::run_script(paths, node, &tr!("Démarrage automatique"), "service.mjs",
            &["uninstall".to_string(), "--apply".to_string()]),
    ];
    // Unité du relais (5.6), si elle a été générée — service.mjs ne connaît
    // que l'unité poste.
    if cfg!(unix) && relay_unit::unit_file().is_file() {
        let (ok, output) = match relay_unit::uninstall() {
            Ok(out) => (true, out),
            Err(e) => (false, e),
        };
        steps.push(Step { label: tr!("Unité systemd du relais"), ok, output });
    }
    steps
}

/// Retrait de la clé HKCU (reg.exe, HKCU ne demande pas d'élévation).
/// Absente = déjà propre : le code de sortie non nul est avalé.
#[cfg(windows)]
fn remove_registry_key() -> Step {
    let mut cmd = Command::new("reg.exe");
    cmd.args(["delete", UNINSTALL_KEY, "/f"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.output();
    match out {
        Ok(o) if o.status.success() => Step {
            label: tr!("Applications installées (registre)"),
            ok: true,
            output: tr!("Clé ZRA retirée."),
        },
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr);
            // Clé absente : rien à faire, c'est un succès. Messages FR/EN,
            // accents perdus en OEM : on matche des fragments ASCII.
            let absent = stderr.contains("introuvable") || stderr.contains("unable to find")
                || stderr.contains("n'a pas trouv")
                || String::from_utf8_lossy(&o.stdout).contains("introuvable");
            Step {
                label: tr!("Applications installées (registre)"),
                ok: absent,
                output: if absent { tr!("Clé déjà absente.") } else { stderr.trim().to_string() },
            }
        }
        Err(e) => Step {
            label: tr!("Applications installées (registre)"),
            ok: false,
            output: tr!("reg.exe impossible : {0}", e),
        },
    }
}

/// Raccourci Menu Démarrer retiré (Windows) — posé à l'installation (5.7).
/// Absent = déjà propre.
#[cfg(windows)]
fn remove_shortcut() -> Step {
    let label = tr!("Raccourci Menu Démarrer");
    let Some(lnk) = std::env::var("APPDATA").ok().map(|a| {
        PathBuf::from(a).join("Microsoft").join("Windows").join("Start Menu").join("Programs").join("ZRA.lnk")
    }) else {
        return Step { label, ok: true, output: tr!("Raccourci déjà absent.") };
    };
    match fs::remove_file(&lnk) {
        Ok(()) => Step { label, ok: true, output: tr!("Raccourci retiré.") },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Step { label, ok: true, output: tr!("Raccourci déjà absent.") },
        Err(e) => Step { label, ok: false, output: tr!("Suppression du raccourci impossible : {0}", e) },
    }
}

/// Suppression différée du dossier (Windows) : le script attend notre exit
/// (l'exe est verrouillé tant qu'on tourne), puis supprime tout. Détaché,
/// fenêtre masquée ; ne rend pas la main (exit ensuite).
#[cfg(windows)]
fn deferred_remove(base: &Path) -> Result<(), String> {
    // Les enfants node meurent avec le tray (job object), mais leur cwd peut
    // verrouiller le dossier quelques millisecondes de plus : retry jusqu'à
    // disparition (~15 s max), pas un seul passage silencieux.
    let path = base.to_string_lossy().replace('\'', "''");
    let script = format!(
        "Wait-Process -Id {} -ErrorAction SilentlyContinue; for ($i = 0; $i -lt 30; $i++) {{ if (-not (Test-Path -LiteralPath '{path}')) {{ break }}; Remove-Item -LiteralPath '{path}' -Recurse -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }}",
        std::process::id(),
    );
    use std::os::windows::process::CommandExt;
    Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &script])
        // cwd neutre : hérité du tray, il pointerait dans le dossier à supprimer
        // et le verrouillerait (un process ne peut pas supprimer son propre cwd).
        .current_dir(std::env::temp_dir())
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .spawn()
        .map_err(|e| tr!("script de suppression : {0}", e))?;
    Ok(())
}

/// Désinstalle et quitte. Le service doit être arrêté avant (sup.stop()).
/// Répond d'abord les étapes à la page, puis supprime et exit — ne rend
/// jamais la main en cas de succès.
pub fn run(paths: &Paths, node: &str, keep_settings: bool) -> Value {
    let mut steps = unwire(paths, node);

    #[cfg(windows)]
    steps.push(remove_registry_key());

    #[cfg(windows)]
    steps.push(remove_shortcut());

    // Config utilisateur (dossier config XDG/APPDATA, hors du dossier d'install) :
    // « garder mes paramètres » (défaut) la conserve ; « tout désinstaller » la
    // retire aussi (installé seulement — en portable/dépôt elle est locale).
    if keep_settings {
        let kept = keep_config(paths);
        steps.push(Step {
            label: tr!("Paramètres conservés"),
            ok: true,
            output: match kept {
                Some(d) => tr!("Config conservée : {0}", d.display()),
                None => tr!("Dossier config introuvable (LOCALAPPDATA/HOME)."),
            },
        });
    } else if crate::install::is_installed() {
        if let Some(d) = crate::config::zra_config_dir() {
            match fs::remove_dir_all(&d) {
                Ok(()) => steps.push(Step { label: tr!("Config supprimée"), ok: true, output: tr!("Dossier config retiré : {0}", d.display()) }),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => steps.push(Step { label: tr!("Config supprimée"), ok: true, output: tr!("Dossier config déjà absent.") }),
                Err(e) => steps.push(Step { label: tr!("Config supprimée"), ok: false, output: tr!("Suppression config impossible : {0}", e) }),
            }
        }
    }

    let base = base_dir(paths);
    let body = json!({
        "ok": true,
        "steps": orchestrate::steps_json(&steps),
        "removed": base.as_ref().map(|p| p.to_string_lossy().to_string()),
    });

    match base {
        Some(base) => {
            #[cfg(windows)]
            {
                if let Err(e) = deferred_remove(&base) {
                    return json!({ "ok": false, "error": e, "steps": orchestrate::steps_json(&steps) });
                }
            }
            #[cfg(unix)]
            {
                // L'exe vivant peut être unlinké : suppression directe.
                if let Err(e) = fs::remove_dir_all(&base) {
                    return json!({ "ok": false, "error": tr!("Suppression impossible : {0}", e), "steps": orchestrate::steps_json(&steps) });
                }
            }
        }
        None => {
            // Layout dépôt : le dossier cloné reste (le contributeur le gère).
        }
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keep_config_portable_copie_config_et_precieux() {
        let _g = crate::testutil::env_guard();
        let dir = std::env::temp_dir().join(format!("zra-keep-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let root = dir.join("app");
        fs::create_dir_all(root.join(".zra/logs")).unwrap();
        let paths = Paths { root: root.clone(), zra: root.join(".zra"), config_zra: root.join(".zra"), logs: root.join(".zra/logs") };
        fs::write(root.join("zra.config.json"), "{ \"port\": 7777 }").unwrap();
        fs::write(root.join(".zra/tray.json"), "{}").unwrap();
        fs::write(root.join(".zra/auth.json"), "{}").unwrap();
        fs::write(root.join(".zra/logs/daemon.log"), "log").unwrap();
        fs::write(root.join(".zra/tray.lock"), "").unwrap();
        let fake_home = dir.join("home");
        fs::create_dir_all(&fake_home).unwrap();
        std::env::set_var("APPDATA", &fake_home);
        std::env::set_var("HOME", &fake_home);
        std::env::set_var("LOCALAPPDATA", &fake_home);
        let dest = keep_config(&paths).expect("dossier config");
        assert_eq!(dest, crate::config::zra_config_dir().unwrap());
        assert!(dest.join("zra.config.json").is_file());
        assert!(dest.join(".zra/tray.json").is_file());
        assert!(dest.join(".zra/auth.json").is_file());
        assert!(!dest.join(".zra/logs").exists(), "jetable exclu");
        assert!(!dest.join(".zra/tray.lock").exists(), "jetable exclu");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn base_dir_seulement_layout_app() {
        // Layout dépôt : root = le repo, l'exe n'est pas à côté → None.
        let dir = std::env::temp_dir().join(format!("zra-uninstall-base-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let paths = Paths { root: dir.clone(), zra: dir.join(".zra"), config_zra: dir.join(".zra"), logs: dir.join(".zra/logs") };
        // current_exe() est le binaire de test, pas à côté de dir : None.
        assert!(base_dir(&paths).is_none());
        fs::remove_dir_all(&dir).unwrap();
    }
}