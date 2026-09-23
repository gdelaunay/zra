// Options booléennes à l'épreuve de npm.
//
// `npm run setup install --apply` (sans le `--` séparateur, ou quand le shell
// l'avale) : npm prend `--apply` pour sa propre option et ne le transmet pas au
// script — qui simule alors en boucle. npm transmet toujours les mots nus :
// `apply` vaut donc `--apply`. Les vieux npm posaient en plus
// `npm_config_apply`, lu aussi.

/**
 * @param {string[]} argv
 * @param {string[]} flags  options booléennes, sans tirets (`apply`, `no-record`…)
 * @returns {string[]} argv où chaque mot nu de `flags` est devenu `--flag`
 */
export function npmSafeArgs(argv, flags) {
  const out = argv.map((a) => (flags.includes(a) ? `--${a}` : a))
  for (const flag of flags) {
    const env = process.env[`npm_config_${flag.replace(/-/g, '_')}`]
    if (env === 'true' && !out.includes(`--${flag}`)) out.push(`--${flag}`)
  }
  return out
}
