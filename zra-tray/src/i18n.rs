// i18n du tray (fr/en) : mêmes principes que le daemon (zra-daemon/i18n.js)
// et la PWA (zra-client/js/i18n.js). Le français est la langue de référence,
// écrit dans le code ; l'anglais vient du catalogue embarqué i18n/en.json.
// La clé est le texte français, les valeurs interpolées sont {0}, {1}… ;
// texte absent du catalogue (ou vide) : repli sur le français.
//
// Langue : ZRA_LANG (fr ou en) s'il est défini, sinon la locale du système
// (GetUserDefaultLocaleName sous Windows, LC_ALL/LC_MESSAGES/LANG ailleurs) ;
// français si elle commence par « fr », anglais sinon.
//
// Les pages HTML (console, onboarding) reçoivent le catalogue et la langue
// injectés par le serveur (script()) ; leur `tr` inline applique la même
// règle. Voir scripts/i18n-test.mjs (brique « tray») pour la complétude.

use std::collections::HashMap;
use std::sync::OnceLock;

/// Catalogue anglais embarqué (clé = texte français avec {0}, {1}…).
const EN_JSON: &str = include_str!("../i18n/en.json");

static CATALOG: OnceLock<HashMap<String, String>> = OnceLock::new();
static LANG: OnceLock<&'static str> = OnceLock::new();

fn catalog() -> &'static HashMap<String, String> {
    CATALOG.get_or_init(|| serde_json::from_str(EN_JSON).unwrap_or_default())
}

/// Locale du système (nom BCP 47, ex. « fr-FR »).
#[cfg(windows)]
fn os_locale() -> String {
    use windows_sys::Win32::Globalization::GetUserDefaultLocaleName;
    let mut buf = [0u16; 85]; // LOCALE_NAME_MAX_LENGTH
    let n = unsafe { GetUserDefaultLocaleName(buf.as_mut_ptr(), buf.len() as i32) };
    if n > 0 {
        // n compte le terminateur nul.
        String::from_utf16_lossy(&buf[..(n as usize - 1)])
    } else {
        String::new()
    }
}

#[cfg(not(windows))]
fn os_locale() -> String {
    ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .find_map(|k| std::env::var(k).ok().filter(|v| !v.is_empty()))
        .unwrap_or_default()
}

/// fr si la source commence par « fr » (insensible à la casse), en sinon.
fn resolve(zra_lang: Option<String>, os: &str) -> &'static str {
    let src = zra_lang.filter(|s| !s.is_empty()).unwrap_or_else(|| os.to_string());
    if src.trim().to_ascii_lowercase().starts_with("fr") { "fr" } else { "en" }
}

pub fn lang() -> &'static str {
    LANG.get_or_init(|| resolve(std::env::var("ZRA_LANG").ok(), &os_locale()))
}

/// Remplace {0}, {1}… par les valeurs (les accolades sans chiffre restent).
fn subst(text: &str, args: &[String]) -> String {
    let mut out = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' {
            let mut j = i + 1;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            if j > i + 1 && j < bytes.len() && bytes[j] == b'}' {
                let idx: usize = text[i + 1..j].parse().unwrap_or(usize::MAX);
                if let Some(v) = args.get(idx) {
                    out.push_str(v);
                    i = j + 1;
                    continue;
                }
            }
        }
        // Caractère UTF-8 complet (pas d'octet isolé).
        let ch = text[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// Cœur traduisible, explicite pour les tests (langue et catalogue imposés).
fn translate(lang: &str, cat: &HashMap<String, String>, key: &str, args: &[String]) -> String {
    let text = if lang == "en" {
        cat.get(key).filter(|s| !s.is_empty()).map(String::as_str).unwrap_or(key)
    } else {
        key
    };
    subst(text, args)
}

/// Traduit une clé française (valeurs {0}, {1}… déjà dans la clé).
pub fn message(key: &str, args: &[String]) -> String {
    translate(lang(), catalog(), key, args)
}

/// Injection dans les pages HTML : langue + catalogue pour le `tr` inline.
pub fn script() -> String {
    format!(
        "<script>window.ZRA_I18N={{lang:{},en:{}}};</script>",
        serde_json::Value::String(lang().to_string()),
        EN_JSON,
    )
}

/// Appel : la macro tr! prend la clé française puis les valeurs (Display),
/// substituées aux {0}, {1}… de la clé.
macro_rules! tr {
    ($key:expr) => { $crate::i18n::message($key, &[]) };
    ($key:expr, $($arg:expr),+ $(,)?) => {
        $crate::i18n::message($key, &[$($arg.to_string()),+])
    };
}
pub(crate) use tr;

#[cfg(test)]
mod tests {
    use super::*;

    fn cat(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn resolve_zra_lang_prioritaire() {
        assert_eq!(resolve(Some("en".into()), "fr-FR"), "en");
        assert_eq!(resolve(Some("fr".into()), "en-US"), "fr");
        assert_eq!(resolve(Some("FR".into()), "en-US"), "fr");
        assert_eq!(resolve(None, "fr-FR"), "fr");
        assert_eq!(resolve(None, "en-US"), "en");
        assert_eq!(resolve(None, ""), "en");
        assert_eq!(resolve(Some("".into()), "fr-FR"), "fr", "vide = absent");
    }

    #[test]
    fn subst_placeholders() {
        let args = vec!["7777".to_string(), "node".to_string()];
        assert_eq!(subst("port {0} via {1}", &args), "port 7777 via node");
        assert_eq!(subst("sans valeur", &args), "sans valeur");
        assert_eq!(subst("{0} {0}", &args), "7777 7777");
        assert_eq!(subst("{9} absent", &args), "{9} absent");
        assert_eq!(subst("accolade { libre", &args), "accolade { libre");
        assert_eq!(subst("été {0}", &args), "été 7777", "UTF-8 préservé");
    }

    #[test]
    fn translate_fr_renvoie_la_cle() {
        let c = cat(&[("Ouvrir ZRA", "Open ZRA")]);
        assert_eq!(translate("fr", &c, "Ouvrir ZRA", &[]), "Ouvrir ZRA");
    }

    #[test]
    fn translate_en_catalogue_et_repli() {
        let c = cat(&[("Ouvrir ZRA", "Open ZRA"), ("Port {0}", "Port {0}"), ("Vide", "")]);
        let args = vec!["7777".to_string()];
        assert_eq!(translate("en", &c, "Ouvrir ZRA", &[]), "Open ZRA");
        assert_eq!(translate("en", &c, "Port {0}", &args), "Port 7777");
        assert_eq!(translate("en", &c, "Absent", &[]), "Absent", "clé absente : français");
        assert_eq!(translate("en", &c, "Vide", &[]), "Vide", "traduction vide : français");
    }

    #[test]
    fn script_injecte_langue_et_catalogue() {
        let s = script();
        assert!(s.starts_with("<script>window.ZRA_I18N={lang:"));
        assert!(s.contains("\"en\":") || s.contains("en:{"));
        assert!(s.ends_with("};</script>"));
    }
}
