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

/// Export de `zra.config.json` dans le dossier personnel (« garder mes
/// réglages »). Renvoie le chemin écrit, ou None si pas de config.
pub fn export_settings(paths: &Paths) -> Option<PathBuf> {
    let config = paths.root.join("zra.config.json");
    if !config.is_file() {
        return None;
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    let dest = PathBuf::from(home).join("zra.config.json");
    fs::copy(&config, &dest).ok()?;
    Some(dest)
}

/// Étapes Node : dé-câblage Zed + retrait autostart. Idempotents — un poste
/// relais sans Zed câblé ne produit pas d'erreur bloquante.
pub fn unwire(paths: &Paths, node: &str) -> Vec<Step> {
    let mut steps = vec![
        orchestrate::run_script(paths, node, "Dé-câblage de Zed", "setup.mjs",
            &["uninstall".to_string(), "--apply".to_string()]),
        orchestrate::run_script(paths, node, "Démarrage automatique", "service.mjs",
            &["uninstall".to_string(), "--apply".to_string()]),
    ];
    // Unité du relais (5.6), si elle a été générée — service.mjs ne connaît
    // que l'unité poste.
    if cfg!(unix) && relay_unit::unit_file().is_file() {
        let (ok, output) = match relay_unit::uninstall() {
            Ok(out) => (true, out),
            Err(e) => (false, e),
        };
        steps.push(Step { label: "Unité systemd du relais".into(), ok, output });
    }
    steps
}

/// Retrait de la clé HKCU (reg.exe, HKCU ne demande pas d'élévation).
/// Absente = déjà propre : le code de sortie non nul est avalé.
#[cfg(windows)]
fn remove_registry_key() -> Step {
    let out = Command::new("reg.exe")
        .args(["delete", UNINSTALL_KEY, "/f"])
        .output();
    match out {
        Ok(o) if o.status.success() => Step {
            label: "Applications installées (registre)".into(),
            ok: true,
            output: "Clé ZRA retirée.".into(),
        },
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr);
            // Clé absente : rien à faire, c'est un succès.
            let absent = stderr.contains("introuvable") || stderr.contains("unable to find")
                || String::from_utf8_lossy(&o.stdout).contains("introuvable");
            Step {
                label: "Applications installées (registre)".into(),
                ok: absent,
                output: if absent { "Clé déjà absente.".into() } else { stderr.trim().to_string() },
            }
        }
        Err(e) => Step {
            label: "Applications installées (registre)".into(),
            ok: false,
            output: format!("reg.exe impossible : {e}"),
        },
    }
}

/// Suppression différée du dossier (Windows) : le script attend notre exit
/// (l'exe est verrouillé tant qu'on tourne), puis supprime tout. Détaché,
/// fenêtre masquée ; ne rend pas la main (exit ensuite).
#[cfg(windows)]
fn deferred_remove(base: &Path) -> Result<(), String> {
    let script = format!(
        "Wait-Process -Id {} -ErrorAction SilentlyContinue; Remove-Item -LiteralPath '{}' -Recurse -Force -ErrorAction SilentlyContinue",
        std::process::id(),
        base.to_string_lossy().replace('\'', "''"),
    );
    use std::os::windows::process::CommandExt;
    Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &script])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .spawn()
        .map_err(|e| format!("script de suppression : {e}"))?;
    Ok(())
}

/// Désinstalle et quitte. Le service doit être arrêté avant (sup.stop()).
/// Répond d'abord les étapes à la page, puis supprime et exit — ne rend
/// jamais la main en cas de succès.
pub fn run(paths: &Paths, node: &str, keep_settings: bool) -> Value {
    let mut steps = unwire(paths, node);

    #[cfg(windows)]
    steps.push(remove_registry_key());

    let mut exported: Option<String> = None;
    if keep_settings {
        match export_settings(paths) {
            Some(dest) => {
                exported = Some(dest.to_string_lossy().to_string());
                steps.push(Step {
                    label: "Réglages conservés".into(),
                    ok: true,
                    output: format!("zra.config.json exporté : {}", dest.display()),
                });
            }
            None => steps.push(Step {
                label: "Réglages conservés".into(),
                ok: true,
                output: "Pas de zra.config.json à exporter.".into(),
            }),
        }
    }

    let base = base_dir(paths);
    let body = json!({
        "ok": true,
        "steps": orchestrate::steps_json(&steps),
        "exported": exported,
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
                    return json!({ "ok": false, "error": format!("Suppression impossible : {e}"), "steps": orchestrate::steps_json(&steps) });
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
    fn export_settings_copie_la_config() {
        let dir = std::env::temp_dir().join(format!("zra-uninstall-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let root = dir.join("app");
        fs::create_dir_all(&root).unwrap();
        let paths = Paths { root: root.clone(), zra: root.join(".zra"), logs: root.join(".zra/logs") };
        assert!(export_settings(&paths).is_none(), "pas de config : rien à exporter");
        fs::write(root.join("zra.config.json"), "{ \"port\": 7777 }").unwrap();
        // USERPROFILE/HOME détournés vers le dossier de test.
        let fake_home = dir.join("home");
        fs::create_dir_all(&fake_home).unwrap();
        std::env::set_var("USERPROFILE", &fake_home);
        std::env::set_var("HOME", &fake_home);
        let dest = export_settings(&paths).expect("export");
        assert_eq!(dest, fake_home.join("zra.config.json"));
        assert_eq!(fs::read_to_string(dest).unwrap(), "{ \"port\": 7777 }");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn base_dir_seulement_layout_app() {
        // Layout dépôt : root = le repo, l'exe n'est pas à côté → None.
        let dir = std::env::temp_dir().join(format!("zra-uninstall-base-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let paths = Paths { root: dir.clone(), zra: dir.join(".zra"), logs: dir.join(".zra/logs") };
        // current_exe() est le binaire de test, pas à côté de dir : None.
        assert!(base_dir(&paths).is_none());
        fs::remove_dir_all(&dir).unwrap();
    }
}