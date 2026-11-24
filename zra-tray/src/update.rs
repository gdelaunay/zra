// Updates (5.4) : un seul canal — la dernière release stable des forges
// (Forgejo source, GitHub miroir en repli, même ordre que tray-download.mjs).
// L'archive « app » est téléchargée en arrière-plan si les mises à jour
// automatiques sont activées (défaut), puis appliquée au prochain arrêt ou
// redémarrage : le code est remplacé, `app/.zra` et `app/zra.config.json`
// sont préservés. Sous Windows l'exe vivant est verrouillé : il est renommé
// (possible à chaud), le neuf posé à la place, l'ancien supprimé après exit
// par un script détaché qui relance le tray. Sous Linux, `exec` remplace le
// processus en place (même pid — l'unité systemd ne voit rien).
//
// Layout dépôt (contributeur) : pas d'update par le tray — le code vient de
// git, l'écraser serait une surprise. La console le dit.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::config::Paths;
use crate::i18n::tr;

const REPO: &str = "gdelaunay/zra";
/// (nom, serveur, API) — la forge source d'abord, le miroir en repli.
const FORGES: [(&str, &str, &str); 2] = [
    ("Forgejo", "https://forgejo.gdelaunay.fr", "https://forgejo.gdelaunay.fr/api/v1"),
    ("GitHub", "https://github.com", "https://api.github.com"),
];

/// Triple de la plateforme, tel que nommé par la CI (assets de release).
pub fn target_triple() -> Option<&'static str> {
    match (std::env::consts::ARCH, std::env::consts::OS) {
        ("x86_64", "windows") => Some("x86_64-pc-windows-msvc"),
        ("x86_64", "linux") => Some("x86_64-unknown-linux-gnu"),
        ("aarch64", "linux") => Some("aarch64-unknown-linux-gnu"),
        _ => None,
    }
}

/// « v0.6.1 » → (0, 6, 1). Pré-release (« v0.6.0-dev ») : None — canal stable
/// unique, les tags de test ne sont pas des mises à jour.
pub fn parse_version(tag: &str) -> Option<(u32, u32, u32)> {
    let s = tag.trim().trim_start_matches('v');
    if s.contains('-') {
        return None;
    }
    let mut parts = s.split('.');
    let maj = parts.next()?.parse().ok()?;
    let min = parts.next()?.parse().ok()?;
    let pat = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((maj, min, pat))
}

pub fn newer(latest: &str, current: &str) -> bool {
    match (parse_version(latest), parse_version(current)) {
        (Some(l), Some(c)) => l > c,
        _ => false,
    }
}

/// Layout « app » (archive grand public) : l'exe est à côté de `app/`, la
/// racine du tray. Layout dépôt : l'exe vit dans `.zra/bin/` ou `target/`.
pub fn is_app_layout(paths: &Paths) -> bool {
    let Ok(exe) = std::env::current_exe() else { return false };
    paths.root.file_name().map(|n| n == "app").unwrap_or(false)
        && exe.parent().is_some()
        && exe.parent() == paths.root.parent()
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    /// Mises à jour automatiques : défaut activé (conception).
    #[serde(default = "yes")]
    pub auto_update: bool,
    /// Version téléchargée, prête à installer (dossier dans .zra/updates/).
    #[serde(default)]
    pub pending: Option<String>,
    #[serde(default)]
    pub latest: Option<String>,
    #[serde(default)]
    pub last_check: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

fn yes() -> bool {
    true
}

impl Default for UpdateState {
    fn default() -> Self {
        Self { auto_update: true, pending: None, latest: None, last_check: None, error: None }
    }
}

impl UpdateState {
    pub fn load(paths: &Paths) -> Self {
        let mut st: Self = fs::read_to_string(state_file(paths))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        // Dossier pending disparu (nettoyage manuel…) : ne pas le promettre.
        if st.pending.is_some() && !pending_dir(paths, st.pending.as_deref().unwrap()).is_dir() {
            st.pending = None;
        }
        st
    }

    pub fn save(&self, paths: &Paths) {
        let _ = fs::create_dir_all(updates_dir(paths));
        let _ = fs::write(state_file(paths), serde_json::to_string_pretty(self).unwrap() + "\n");
    }
}

fn updates_dir(paths: &Paths) -> PathBuf {
    paths.zra.join("updates")
}

fn state_file(paths: &Paths) -> PathBuf {
    updates_dir(paths).join("state.json")
}

/// Dossier extrait d'une version : `.zra/updates/pending-<version>/` — il
/// contient le dossier racine du zip (`zra-<version>-<target>/`).
fn pending_dir(paths: &Paths, version: &str) -> PathBuf {
    updates_dir(paths).join(format!("pending-{version}"))
}

/// Le dossier racine extrait (exe + app/) d'un pending, s'il existe encore.
pub fn pending_inner(paths: &Paths, version: &str) -> Option<PathBuf> {
    let dir = pending_dir(paths, version);
    fs::read_dir(dir).ok()?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .find(|p| p.is_dir())
}

fn agent(timeout: Duration) -> ureq::Agent {
    let connector = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .expect("connecteur TLS");
    ureq::AgentBuilder::new()
        .timeout(timeout)
        .tls_connector(std::sync::Arc::new(connector))
        .build()
}

/// Dernière release stable, forge par forge. Ok((version, forge)) ou Err.
pub fn check_latest() -> Result<(String, &'static str), String> {
    let mut errors = Vec::new();
    for (name, _server, api) in FORGES {
        let url = format!("{api}/repos/{REPO}/releases/latest");
        let result = (|| -> Result<String, String> {
            let body = agent(Duration::from_secs(20))
                .get(&url)
                .set("Accept", "application/json")
                .call()
                .map_err(|e| tr!("releases/latest : {0}", e))?
                .into_string()
                .map_err(|e| tr!("lecture : {0}", e))?;
            let v: Value = serde_json::from_str(&body).map_err(|e| tr!("JSON : {0}", e))?;
            let tag = v.get("tag_name").and_then(Value::as_str).ok_or(tr!("release sans tag"))?;
            if parse_version(tag).is_none() {
                return Err(tr!("tag non stable : {0}", tag));
            }
            Ok(tag.trim_start_matches('v').to_string())
        })();
        match result {
            Ok(version) => return Ok((version, name)),
            Err(e) => errors.push(tr!("{0} : {1}", name, e)),
        }
    }
    Err(errors.join(" ; "))
}

/// Télécharge l'archive de la version et l'extrait dans pending-<version>/.
/// Renvoie le dossier racine extrait (celui qui contient l'exe et app/).
pub fn download(paths: &Paths, version: &str) -> Result<PathBuf, String> {
    let target = target_triple().ok_or(tr!("plateforme non couverte par la CI"))?;
    let asset = format!("zra-{version}-{target}.zip");
    let mut errors = Vec::new();
    let mut bytes: Option<Vec<u8>> = None;
    for (name, server, _api) in FORGES {
        let url = format!("{server}/{REPO}/releases/download/v{version}/{asset}");
        match agent(Duration::from_secs(300)).get(&url).call() {
            Ok(resp) => {
                let mut buf = Vec::new();
                use std::io::Read;
                if let Err(e) = resp.into_reader().take(200 * 1024 * 1024).read_to_end(&mut buf) {
                    errors.push(tr!("{0} : lecture : {1}", name, e));
                    continue;
                }
                if buf.is_empty() {
                    errors.push(tr!("{0} : fichier vide", name));
                    continue;
                }
                bytes = Some(buf);
                break;
            }
            Err(e) => errors.push(tr!("{0} : {1}", name, e)),
        }
    }
    let bytes = bytes.ok_or_else(|| errors.join(" ; "))?;

    let dir = pending_dir(paths, version);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).map_err(|e| tr!("création de {0} : {1}", dir.display(), e))?;
    let zip_path = updates_dir(paths).join(&asset);
    fs::write(&zip_path, &bytes).map_err(|e| tr!("écriture du zip : {0}", e))?;
    extract_zip(&zip_path, &dir)?;
    let _ = fs::remove_file(&zip_path);

    // Le zip contient un dossier racine nommé zra-<version>-<target>/.
    let inner = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .find(|p| p.is_dir())
        .ok_or(tr!("archive sans dossier racine"))?;
    let exe = inner.join(if cfg!(windows) { "zra-tray.exe" } else { "zra-tray" });
    if !exe.is_file() || !inner.join("app/zra-daemon/index.js").is_file() {
        return Err(tr!("archive incomplète (exe ou app/ manquant)"));
    }
    Ok(inner)
}

/// Extraction zip (crate `zip`, deflate) — chemins sûrs : pas de traversal.
fn extract_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::open(zip_path).map_err(|e| tr!("ouverture du zip : {0}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| tr!("zip illisible : {0}", e))?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| tr!("entrée {0} : {1}", i, e))?;
        let Some(rel) = entry.enclosed_name() else { continue }; // traversal : ignoré
        let out = dest.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|e| tr!("{0} : {1}", out.display(), e))?;
        } else {
            if let Some(parent) = out.parent() {
                fs::create_dir_all(parent).map_err(|e| tr!("{0} : {1}", parent.display(), e))?;
            }
            let mut f = fs::File::create(&out).map_err(|e| tr!("{0} : {1}", out.display(), e))?;
            std::io::copy(&mut entry, &mut f).map_err(|e| tr!("{0} : {1}", out.display(), e))?;
        }
    }
    Ok(())
}

/// Copie récursive (le merge de l'update) : écrase les fichiers, crée les
/// dossiers. Les données (.zra, zra.config.json) sont filtrées en amont.
pub(crate) fn copy_rec(src: &Path, dst: &Path) -> std::io::Result<()> {
    if src.is_dir() {
        fs::create_dir_all(dst)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            copy_rec(&entry.path(), &dst.join(entry.file_name()))?;
        }
    } else {
        fs::copy(src, dst)?;
    }
    Ok(())
}

/// Remplace le code par le pending, préserve `.zra` et `zra.config.json`.
/// Le service doit être arrêté avant (plus aucun fichier ouvert).
pub fn merge_app(inner: &Path, paths: &Paths) -> Result<(), String> {
    let new_app = inner.join("app");
    for entry in fs::read_dir(&new_app).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        if name == ".zra" || name == "zra.config.json" {
            continue; // les données de l'utilisateur voyagent à travers l'update
        }
        copy_rec(&entry.path(), &paths.root.join(&name)).map_err(|e| tr!("{0} : {1}", name.to_string_lossy(), e))?;
    }
    Ok(())
}

/// Applique le pending puis relance le tray. Ne rend jamais la main en cas de
/// succès (exit ou exec). Le service doit déjà être arrêté.
pub fn apply_and_relaunch(paths: &Paths, inner: &Path) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let new_exe = inner.join(if cfg!(windows) { "zra-tray.exe" } else { "zra-tray" });
    merge_app(inner, paths)?;

    #[cfg(windows)]
    {
        // L'exe vivant est verrouillé en écriture/suppression, mais pas en
        // renommage : l'ancien devient .old, le neuf prend sa place, et un
        // script détaché attend notre exit pour supprimer .old et relancer.
        let old = exe.with_file_name("zra-tray.old.exe");
        let _ = fs::remove_file(&old);
        fs::rename(&exe, &old).map_err(|e| tr!("renommage de l'exe : {0}", e))?;
        if let Err(e) = fs::copy(&new_exe, &exe) {
            let _ = fs::rename(&old, &exe); // marche arrière : l'ancien reprend sa place
            return Err(tr!("copie du nouvel exe : {0}", e));
        }
        let base = paths.root.parent().unwrap_or(&paths.root);
        // Même course que la désinstallation : le verrou de l'exe peut survivre
        // quelques millisecondes à l'exit — retry avant de relancer.
        let old_q = old.to_string_lossy().replace('\'', "''");
        let script = format!(
            "Wait-Process -Id {} -ErrorAction SilentlyContinue; for ($i = 0; $i -lt 30; $i++) {{ if (-not (Test-Path -LiteralPath '{old_q}')) {{ break }}; Remove-Item -LiteralPath '{old_q}' -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }}; Start-Process -FilePath '{}' -WorkingDirectory '{}'",
            std::process::id(),
            exe.to_string_lossy().replace('\'', "''"),
            base.to_string_lossy().replace('\'', "''"),
        );
        use std::os::windows::process::CommandExt;
        Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &script])
            .current_dir(std::env::temp_dir()) // cwd neutre (cf. désinstallation)
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .spawn()
            .map_err(|e| tr!("script de relance : {0}", e))?;
        cleanup_pending(paths);
        std::process::exit(0);
    }

    #[cfg(unix)]
    {
        // Renommer par-dessus l'exe vivant est permis (l'ancien inode reste
        // mapped) ; exec remplace le processus en place — même pid, l'unité
        // systemd --user ne voit pas d'arrêt.
        fs::rename(&new_exe, &exe).map_err(|e| tr!("remplacement de l'exe : {0}", e))?;
        use std::os::unix::process::CommandExt;
        let base = paths.root.parent().unwrap_or(&paths.root).to_path_buf();
        cleanup_pending(paths);
        let err = Command::new(&exe).current_dir(base).exec();
        Err(tr!("exec : {0}", err))
    }
}

fn cleanup_pending(paths: &Paths) {
    if let Ok(entries) = fs::read_dir(updates_dir(paths)) {
        for entry in entries.filter_map(Result::ok) {
            let name = entry.file_name();
            if name.to_string_lossy().starts_with("pending-") {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
}

/// Projection pour la console.
pub fn state_json(paths: &Paths, current: Option<String>) -> Value {
    let st = UpdateState::load(paths);
    json!({
        "supported": is_app_layout(paths) && target_triple().is_some(),
        "autoUpdate": st.auto_update,
        "current": current,
        "pending": st.pending,
        "latest": st.latest,
        "lastCheck": st.last_check,
        "error": st.error,
    })
}

/// Vérifie + (si auto) télécharge. À appeler depuis un thread ou une requête
/// dédiée — c'est long (réseau). Renvoie la projection à jour.
pub fn check_and_fetch(paths: &Paths, current: Option<String>) -> Value {
    let mut st = UpdateState::load(paths);
    st.last_check = Some(now_secs().to_string());
    st.error = None;
    if !is_app_layout(paths) || target_triple().is_none() {
        st.save(paths);
        return state_json(paths, current);
    }
    match check_latest() {
        Ok((latest, _forge)) => {
            st.latest = Some(latest.clone());
            let cur = current.clone().unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
            if newer(&latest, &cur) && st.pending.as_deref() != Some(latest.as_str()) {
                match download(paths, &latest) {
                    Ok(_) => st.pending = Some(latest),
                    Err(e) => st.error = Some(e),
                }
            }
        }
        Err(e) => st.error = Some(e),
    }
    st.save(paths);
    state_json(paths, current)
}

/// Horodatage de dernière vérification (secondes epoch) — la page le formate
/// en date locale (pas de dépendance chrono côté Rust).
fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_version_stable_seulement() {
        assert_eq!(parse_version("v0.6.1"), Some((0, 6, 1)));
        assert_eq!(parse_version("0.6.1"), Some((0, 6, 1)));
        assert_eq!(parse_version("v0.6.0-dev"), None);
        assert_eq!(parse_version("v0.6"), None);
        assert_eq!(parse_version("v0.6.1.2"), None);
        assert_eq!(parse_version("n'importe quoi"), None);
    }

    #[test]
    fn newer_compare_semver() {
        assert!(newer("0.6.1", "0.6.0"));
        assert!(newer("0.7.0", "0.6.9"));
        assert!(newer("1.0.0", "0.9.9"));
        assert!(!newer("0.6.0", "0.6.0"));
        assert!(!newer("0.5.4", "0.6.0"));
        assert!(!newer("0.6.0-dev", "0.5.4"), "pré-release ignorée");
    }

    #[test]
    fn merge_app_preserve_les_donnees() {
        let dir = std::env::temp_dir().join(format!("zra-update-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let root = dir.join("app");
        let inner = dir.join("pending").join("zra-0.7.0-x");
        fs::create_dir_all(root.join(".zra")).unwrap();
        fs::create_dir_all(root.join("zra-daemon")).unwrap();
        fs::create_dir_all(inner.join("app/zra-daemon")).unwrap();
        fs::create_dir_all(inner.join("app/.zra")).unwrap();
        fs::write(root.join(".zra/tray.json"), "données").unwrap();
        fs::write(root.join("zra.config.json"), "réglages").unwrap();
        fs::write(root.join("zra-daemon/old.js"), "ancien").unwrap();
        fs::write(inner.join("app/zra-daemon/index.js"), "neuf").unwrap();
        fs::write(inner.join("app/zra-daemon/old.js"), "neuf aussi").unwrap();
        fs::write(inner.join("app/package.json"), "{}").unwrap();
        fs::write(inner.join("app/.zra/tray.json"), "écraserait").unwrap();
        fs::write(inner.join("app/zra.config.json"), "écraserait").unwrap();

        merge_app(&inner, &Paths { root: root.clone(), zra: root.join(".zra"), config_zra: root.join(".zra"), logs: root.join(".zra/logs") }).unwrap();
        assert_eq!(fs::read_to_string(root.join(".zra/tray.json")).unwrap(), "données");
        assert_eq!(fs::read_to_string(root.join("zra.config.json")).unwrap(), "réglages");
        assert_eq!(fs::read_to_string(root.join("zra-daemon/index.js")).unwrap(), "neuf");
        assert_eq!(fs::read_to_string(root.join("zra-daemon/old.js")).unwrap(), "neuf aussi");
        assert!(root.join("package.json").is_file());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn zip_roundtrip_layout_archive() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("zra-update-zip-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let zip_path = dir.join("zra-0.7.0-x.zip");
        let file = fs::File::create(&zip_path).unwrap();
        let mut zw = zip::ZipWriter::new(file);
        let opts: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
        // Le zip de la CI contient un dossier racine nommé.
        zw.add_directory("zra-0.7.0-x/", opts).unwrap();
        zw.add_directory("zra-0.7.0-x/app/", opts).unwrap();
        zw.start_file("zra-0.7.0-x/zra-tray.exe", opts).unwrap();
        zw.write_all(b"exe").unwrap();
        zw.start_file("zra-0.7.0-x/app/zra-daemon/index.js", opts).unwrap();
        zw.write_all(b"daemon").unwrap();
        // Traversal : doit être ignoré, pas extrait hors de dest.
        zw.start_file("../evil.txt", opts).unwrap();
        zw.write_all(b"non").unwrap();
        zw.finish().unwrap();

        let dest = dir.join("out");
        fs::create_dir_all(&dest).unwrap();
        extract_zip(&zip_path, &dest).unwrap();
        assert!(dest.join("zra-0.7.0-x/zra-tray.exe").is_file());
        assert_eq!(fs::read_to_string(dest.join("zra-0.7.0-x/app/zra-daemon/index.js")).unwrap(), "daemon");
        assert!(!dir.join("evil.txt").exists(), "traversal ignoré");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn etat_defaut_auto_active() {
        let dir = std::env::temp_dir().join(format!("zra-update-state-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let paths = Paths { root: dir.clone(), zra: dir.join(".zra"), config_zra: dir.join(".zra"), logs: dir.join(".zra/logs") };
        let st = UpdateState::load(&paths);
        assert!(st.auto_update, "défaut activé (conception)");
        assert!(st.pending.is_none());
        st.save(&paths);
        assert!(UpdateState::load(&paths).auto_update);
        fs::remove_dir_all(&dir).unwrap();
    }
}