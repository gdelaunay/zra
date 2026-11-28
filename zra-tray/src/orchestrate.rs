// Orchestration des scripts Node (setup/service) depuis le tray — option A de
// la conception : la page collecte les réponses, le tray spawn node en non
// interactif, node exécute. Pas de réimplémentation de la chirurgie JSONC.
//
// Les scripts vivent dans `scripts/` à la racine (dépôt) ou `app/scripts/`
// (archive) — `paths.root` pointe déjà sur le bon dossier (config.rs).

use std::process::{Command, Stdio};

use crate::config::{Mode, Paths};
use crate::i18n::tr;
use crate::relay_unit;
use crate::supervisor::Supervisor;

/// Résultat d'une étape d'orchestration, renvoyé à la page.
pub struct Step {
    pub label: String,
    pub ok: bool,
    pub output: String,
}

impl Step {
    fn json(&self) -> serde_json::Value {
        serde_json::json!({ "label": self.label, "ok": self.ok, "output": self.output })
    }
}

pub fn steps_json(steps: &[Step]) -> serde_json::Value {
    serde_json::Value::Array(steps.iter().map(|s| s.json()).collect())
}

/// Spawne `node <scripts>/<script> <args…>`, capture stdout/stderr, attend la
/// fin. Fenêtre masquée sous Windows (CREATE_NO_WINDOW), comme le superviseur.
pub fn run_script(paths: &Paths, node: &str, label: &str, script: &str, args: &[String]) -> Step {
    let path = paths.root.join("scripts").join(script);
    let mut cmd = Command::new(node);
    cmd.arg(&path)
        .args(args)
        .current_dir(&paths.root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    match cmd.output() {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            let ok = out.status.success();
            // Succès : la sortie informative ; échec : stdout + stderr pour le diagnostic.
            let output = if ok { stdout.trim().to_string() } else { format!("{stdout}{stderr}").trim().to_string() };
            Step { label: label.to_string(), ok, output }
        }
        Err(err) => Step { label: label.to_string(), ok: false, output: tr!("Lancement impossible : {0}", err) },
    }
}

/// `setup.mjs discover --json` → état JSON (Zed, agents, autostart, Wayland).
/// Null si le script échoue ou si la sortie n'est pas du JSON.
pub fn discover(paths: &Paths, node: &str) -> serde_json::Value {
    let step = run_script(paths, node, "discover", "setup.mjs", &["discover".to_string()]);
    if !step.ok {
        return serde_json::Value::Null;
    }
    serde_json::from_str(&step.output).unwrap_or(serde_json::Value::Null)
}

/// Bascule de mode avec migration de l'autostart : l'intention « lancer au
/// démarrage » suit le mode. Deux supports distincts uniquement sous
/// Linux/systemd (unité poste `zra-daemon` ↔ unité relais `zra-relay`) ;
/// ailleurs (Windows, MX/XDG) le même support lance le tray, qui suit le
/// mode — rien à migrer. L'ancien support est retiré sans tuer le tray
/// courant (`--keep-running` / disable seul).
pub fn switch_mode(sup: &Supervisor, paths: &Paths, next: Mode) -> Result<String, String> {
    let (old, _) = sup.snapshot();
    if old == next {
        return Ok(String::new());
    }
    let relay_side = |m: Mode| m == Mode::Relais && relay_unit::is_systemd_user();
    if relay_side(old) == relay_side(next) {
        sup.switch_mode(next);
        return Ok(String::new());
    }
    let cfg = sup.config();
    let enabled = if relay_side(old) {
        relay_unit::state().get("enabled").and_then(|v| v.as_bool()).unwrap_or(false)
    } else {
        discover(paths, &cfg.node)
            .get("autostart")
            .and_then(|a| a.get("installed"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    };
    sup.switch_mode(next);
    if !enabled {
        return Ok(String::new());
    }
    let mut out = String::new();
    if relay_side(old) {
        out.push_str(&relay_unit::uninstall_keep_running(&paths.root)?);
    } else {
        let step = run_script(paths, &cfg.node, &tr!("Démarrage automatique"), "service.mjs",
            &["uninstall".into(), "--apply".into(), "--keep-running".into()]);
        if !step.ok {
            return Err(step.output);
        }
        out.push_str(&step.output);
    }
    out.push('\n');
    if relay_side(next) {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        out.push_str(&relay_unit::install(&exe, &paths.root)?);
    } else {
        let step = run_script(paths, &cfg.node, &tr!("Démarrage automatique"), "service.mjs",
            &["install".into(), "--apply".into()]);
        if !step.ok {
            return Err(step.output);
        }
        out.push_str(&step.output);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_json_sequentialise_label_ok_output() {
        let steps = vec![
            Step { label: "Agents Zed".into(), ok: true, output: "+ opencode".into() },
            Step { label: "Démarrage".into(), ok: false, output: "échec".into() },
        ];
        let v = steps_json(&steps);
        assert_eq!(v[0]["label"], "Agents Zed");
        assert_eq!(v[0]["ok"], true);
        assert_eq!(v[1]["ok"], false);
        assert_eq!(v[1]["output"], "échec");
        assert_eq!(v.as_array().unwrap().len(), 2);
    }
}